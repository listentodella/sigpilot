#include <saleae_compat.h>
#include <nlohmann/json.hpp>

#include <algorithm>
#include <atomic>
#include <cctype>
#include <chrono>
#include <cstdio>
#include <cstdlib>
#include <cstdint>
#include <filesystem>
#include <fstream>
#include <future>
#include <iostream>
#include <limits>
#include <map>
#include <memory>
#include <mutex>
#include <optional>
#include <sstream>
#include <stdexcept>
#include <string>
#include <thread>
#include <unordered_map>
#include <vector>

#ifdef _WIN32
#include <fcntl.h>
#include <io.h>
#endif

using json = nlohmann::json;
namespace fs = std::filesystem;

namespace
{

// The framed transport (PXLQ1 requests, PXLF1 responses) carries raw edge and
// payload bytes. The Windows CRT opens the standard streams in text mode, where
// 0x1A reads as EOF and "\n" is expanded to "\r\n" on write, so a varint stream
// containing either byte truncates the request or corrupts the response. Unix
// hosts perform no such translation, which is why only Windows was affected.
// The JSON-only modes are unaffected either way, but switching the whole
// process keeps every mode consistent.
void UseBinaryStandardStreams()
{
#ifdef _WIN32
    _setmode(_fileno(stdin), _O_BINARY);
    _setmode(_fileno(stdout), _O_BINARY);
#endif
}

using Clock = std::chrono::steady_clock;
using ConfiguredChannelMap = std::unordered_map<std::string, unsigned>;

constexpr size_t kMaxBubbleTextCacheReserve = 16 * 1024;

enum class ResponseFormat
{
    Standard,
    CompactV1,
    CompactV2,
    CompactV3,
    CompactV4,
    BinaryV1,
};

struct SessionDeleter
{
    void operator()(sr_session* session) const { sr_session_destroy(session); }
};
using Session = std::unique_ptr<sr_session, SessionDeleter>;

struct AsyncSessionObserver
{
    std::mutex mutex;
    sr_session* session = nullptr;
    std::uint64_t progress_sample = 0;
    size_t emitted_structured_frames = 0;
    bool finalizing = false;
};

struct AsyncDecodeJob
{
    std::shared_ptr<AsyncSessionObserver> observer = std::make_shared<AsyncSessionObserver>();
    std::future<json> result;
    json partial_request;
    std::uint64_t sample_count = 0;
    size_t emitted_structured_frames = 0;
    size_t emitted_legacy_frames = 0;
    bool cancel_requested = false;
};

struct AsyncSessionPublication
{
    AsyncSessionObserver* observer = nullptr;

    ~AsyncSessionPublication()
    {
        if(!observer)
            return;
        std::lock_guard lock(observer->mutex);
        observer->session = nullptr;
    }
};

struct ChannelValueOutput
{
    unsigned channel = 0;
    std::string role;
    std::string label;
    std::vector<std::string> texts;
    unsigned long long value = 0;
};

struct CompactRoleDictionary
{
    std::vector<std::string> roles;
    std::unordered_map<std::string, size_t> indexes;

    size_t Index(const std::string& role)
    {
        if(const auto found = indexes.find(role); found != indexes.end())
            return found->second;
        const auto index = roles.size();
        roles.push_back(role);
        indexes.emplace(role, index);
        return index;
    }
};

struct CompactStringDictionary
{
    std::vector<std::string> strings;
    std::unordered_map<std::string, size_t> indexes;

    size_t Index(const std::string& value)
    {
        if(const auto found = indexes.find(value); found != indexes.end())
            return found->second;
        const auto index = strings.size();
        strings.push_back(value);
        indexes.emplace(value, index);
        return index;
    }
};

void PutVarint(std::vector<std::uint8_t>& output, std::uint64_t value)
{
    do
    {
        auto byte = static_cast<std::uint8_t>(value & 0x7f);
        value >>= 7;
        if(value != 0)
            byte |= 0x80;
        output.push_back(byte);
    } while(value != 0);
}

std::string Base64Encode(const std::vector<std::uint8_t>& input)
{
    static constexpr char kAlphabet[] =
        "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    std::string output;
    output.reserve(((input.size() + 2) / 3) * 4);
    for(size_t index = 0; index < input.size(); index += 3)
    {
        const auto a = input[index];
        const auto b = index + 1 < input.size() ? input[index + 1] : 0;
        const auto c = index + 2 < input.size() ? input[index + 2] : 0;
        output.push_back(kAlphabet[(a >> 2) & 0x3f]);
        output.push_back(kAlphabet[((a & 0x03) << 4) | ((b >> 4) & 0x0f)]);
        output.push_back(index + 1 < input.size()
            ? kAlphabet[((b & 0x0f) << 2) | ((c >> 6) & 0x03)]
            : '=');
        output.push_back(index + 2 < input.size() ? kAlphabet[c & 0x3f] : '=');
    }
    return output;
}

struct BubbleTextKey
{
    size_t frame = 0;
    unsigned channel = 0;
};

bool operator==(const BubbleTextKey& left, const BubbleTextKey& right)
{
    return left.frame == right.frame && left.channel == right.channel;
}

struct BubbleTextKeyHash
{
    size_t operator()(const BubbleTextKey& key) const noexcept
    {
        const auto frame_hash = std::hash<size_t>{}(key.frame);
        const auto channel_hash = std::hash<unsigned>{}(key.channel);
        return frame_hash ^ (channel_hash + 0x9e3779b97f4a7c15ULL + (frame_hash << 6) + (frame_hash >> 2));
    }
};

bool TimingEnabled()
{
    return std::getenv("SIGPILOT_DECODER_TIMING") != nullptr;
}

bool FramedBinaryTransportRequested(const json& input)
{
    return input.value("response_transport", std::string()) == "framed_binary_v1";
}

void ExtractFramedBinaryPayloads(json& value, std::vector<std::uint8_t>& binary)
{
    if(value.is_binary())
    {
        const auto& payload = value.get_binary();
        const auto offset = binary.size();
        binary.insert(binary.end(), payload.begin(), payload.end());
        value = json{{"o", offset}, {"l", payload.size()}};
        return;
    }
    if(value.is_array())
    {
        for(auto& item : value)
            ExtractFramedBinaryPayloads(item, binary);
        return;
    }
    if(value.is_object())
    {
        for(auto& [key, item] : value.items())
        {
            (void)key;
            ExtractFramedBinaryPayloads(item, binary);
        }
    }
}

void WriteLittleEndianU64(std::ostream& output, std::uint64_t value)
{
    std::uint8_t bytes[8]{};
    for(size_t index = 0; index < 8; ++index)
        bytes[index] = static_cast<std::uint8_t>((value >> (index * 8)) & 0xffu);
    output.write(reinterpret_cast<const char*>(bytes), sizeof(bytes));
}

std::uint64_t ReadLittleEndianU64(std::istream& input)
{
    std::uint8_t bytes[8]{};
    input.read(reinterpret_cast<char*>(bytes), sizeof(bytes));
    if(!input)
        throw std::runtime_error("truncated framed request length");
    std::uint64_t value = 0;
    for(size_t index = 0; index < 8; ++index)
        value |= static_cast<std::uint64_t>(bytes[index]) << (index * 8);
    return value;
}

bool ReadServeRequest(json& request, size_t& request_bytes)
{
    const auto next = std::cin.peek();
    if(next == std::char_traits<char>::eof())
        return false;
    if(next != 'P')
    {
        std::string line;
        if(!std::getline(std::cin, line))
            return false;
        request_bytes = line.size();
        request = line.empty() ? json() : json::parse(line);
        return true;
    }

    char magic[5]{};
    std::cin.read(magic, sizeof(magic));
    if(!std::cin || std::string(magic, sizeof(magic)) != "PXLQ1")
        throw std::runtime_error("invalid framed request magic");
    const auto header_length = ReadLittleEndianU64(std::cin);
    const auto binary_length = ReadLittleEndianU64(std::cin);
    constexpr std::uint64_t kMaxHeaderLength = 64ULL * 1024ULL * 1024ULL;
    constexpr std::uint64_t kMaxBinaryLength = 2ULL * 1024ULL * 1024ULL * 1024ULL;
    if(header_length > kMaxHeaderLength || binary_length > kMaxBinaryLength)
        throw std::runtime_error("framed request exceeds the transport size limit");
    std::string header(static_cast<size_t>(header_length), '\0');
    std::vector<std::uint8_t> binary(static_cast<size_t>(binary_length));
    std::cin.read(header.data(), static_cast<std::streamsize>(header.size()));
    if(!binary.empty())
        std::cin.read(reinterpret_cast<char*>(binary.data()), static_cast<std::streamsize>(binary.size()));
    if(!std::cin)
        throw std::runtime_error("truncated framed request payload");
    request = json::parse(header);
    request["_request_binary"] = json::binary(std::move(binary));
    request_bytes = sizeof(magic) + 16 + header.size() + static_cast<size_t>(binary_length);
    return true;
}

void WriteFramedResponse(json response)
{
    std::vector<std::uint8_t> binary;
    ExtractFramedBinaryPayloads(response, binary);
    const auto header = response.dump();
    static constexpr char kMagic[] = {'P', 'X', 'L', 'F', '1'};
    std::cout.write(kMagic, sizeof(kMagic));
    WriteLittleEndianU64(std::cout, header.size());
    WriteLittleEndianU64(std::cout, binary.size());
    std::cout.write(header.data(), static_cast<std::streamsize>(header.size()));
    if(!binary.empty())
        std::cout.write(reinterpret_cast<const char*>(binary.data()), static_cast<std::streamsize>(binary.size()));
    std::cout.flush();
}

size_t ConfiguredWorkerCount(const char* name, size_t task_count, size_t fallback)
{
    if(task_count <= 1)
        return 1;
    size_t requested = fallback;
    if(const char* raw = std::getenv(name); raw && *raw)
    {
        try
        {
            requested = std::stoull(raw);
        }
        catch(...)
        {
            requested = fallback;
        }
        if(requested == 0)
            requested = fallback;
    }
    const auto available = std::max(1u, std::thread::hardware_concurrency());
    return std::max<size_t>(1, std::min({requested, task_count, static_cast<size_t>(available)}));
}

size_t DefaultSidecarWorkerCount()
{
    const auto available = std::max(1u, std::thread::hardware_concurrency());
    if(available <= 2)
        return available;
    return std::min<size_t>(8, static_cast<size_t>(available - 1));
}

size_t SaleaeBatchWorkerCount(size_t decoder_count)
{
    return ConfiguredWorkerCount("SIGPILOT_SALEAE_BATCH_WORKERS", decoder_count, DefaultSidecarWorkerCount());
}

size_t SaleaeWindowBatchWorkerCount(size_t window_count)
{
    return ConfiguredWorkerCount("SIGPILOT_SALEAE_WINDOW_BATCH_WORKERS", window_count, DefaultSidecarWorkerCount());
}

void TraceTiming(const char* stage, Clock::time_point started, const std::string& detail = {})
{
    if(!TimingEnabled())
        return;
    const auto elapsed = std::chrono::duration<double, std::milli>(Clock::now() - started).count();
    std::ostringstream message;
    message << "[pxlogic-saleae-sidecar] stage=" << stage << " elapsed_ms=" << elapsed;
    if(!detail.empty())
        message << ' ' << detail;
    message << '\n';
    std::cerr << message.str();
}

size_t OutputFrameCount(const json& output)
{
    if(output.contains("outputs") && output.at("outputs").is_array())
    {
        size_t count = 0;
        for(const auto& item : output.at("outputs"))
            count += OutputFrameCount(item);
        return count;
    }
    if(output.contains("f") && output.at("f").is_array())
        return output.at("f").size();
    if(output.contains("n") && output.at("n").is_number_unsigned())
        return output.at("n").get<size_t>();
    if(output.contains("frames") && output.at("frames").is_array())
        return output.at("frames").size();
    return 0;
}

std::string Lower(std::string value)
{
    std::transform(value.begin(), value.end(), value.begin(), [](unsigned char character) {
        return static_cast<char>(std::tolower(character));
    });
    return value;
}

std::string DecoderId(const fs::path& plugin)
{
    auto id = plugin.stem().string();
    if(id.rfind("lib", 0) == 0)
        id.erase(0, 3);
    constexpr const char* suffix = "_analyzer";
    if(id.size() > std::char_traits<char>::length(suffix) &&
       id.compare(id.size() - std::char_traits<char>::length(suffix), std::char_traits<char>::length(suffix), suffix) == 0)
        id.erase(id.size() - std::char_traits<char>::length(suffix));
    return id;
}

std::string ProtocolNameForId(const std::string& id)
{
    static const std::map<std::string, std::string> names = {
        {"async_rgb_led", "Addressable LEDs (Async)"},
        {"atmel_swi", "Atmel SWI"},
        {"biss", "BiSS C"},
        {"can", "CAN"},
        {"dmx_512", "DMX-512"},
        {"hd44780", "HD44780"},
        {"hdlc", "HDLC"},
        {"hdmi_cec", "HDMI CEC"},
        {"i2c", "I2C"},
        {"i2s", "I2S / PCM"},
        {"jtag", "JTAG"},
        {"lin", "LIN"},
        {"manchester", "Manchester"},
        {"mcs04", "Intel MCS-04 bus"},
        {"mdio", "MDIO"},
        {"midi", "Midi"},
        {"modbus", "Modbus"},
        {"one_wire", "1-Wire"},
        {"ps2_keyboard", "PS/2 Keyboard/Mouse"},
        {"serial", "Async Serial"},
        {"simple_parallel", "Simple Parallel"},
        {"smbus", "SMBus"},
        {"spi", "SPI"},
        {"swd", "SWD"},
        {"unio", "UNI/O"},
        {"usb", "USB LS and FS"},
    };
    if(const auto found = names.find(id); found != names.end())
        return found->second;

    std::string fallback = id;
    bool capitalize = true;
    for(auto& character : fallback)
    {
        if(character == '_')
        {
            character = ' ';
            capitalize = true;
        }
        else if(capitalize)
        {
            character = static_cast<char>(std::toupper(static_cast<unsigned char>(character)));
            capitalize = false;
        }
    }
    return fallback;
}

fs::path RuntimeLibrary(const fs::path& root)
{
#ifdef _WIN32
    const std::vector<fs::path> candidates = {
        root / "saleae_compat.dll", root / "libsaleae_compat.dll",
        root / "Analyzers/saleae_compat.dll", root / "Analyzers/libsaleae_compat.dll",
        root / "lib/saleae_compat.dll", root / "lib/libsaleae_compat.dll"};
#elif defined(__APPLE__)
    const std::vector<fs::path> candidates = {
        root / "libsaleae_compat.dylib", root / "Analyzers/libsaleae_compat.dylib",
        root / "lib/libsaleae_compat.dylib"};
#else
    const std::vector<fs::path> candidates = {
        root / "libsaleae_compat.so", root / "Analyzers/libsaleae_compat.so",
        root / "lib/libsaleae_compat.so"};
#endif
    for(const auto& candidate : candidates)
        if(fs::is_regular_file(candidate))
            return candidate;
    throw std::runtime_error("standalone Saleae runtime library was not found under " + root.string());
}

bool IsAnalyzerPlugin(const fs::path& path)
{
    const auto filename = Lower(path.filename().string());
#ifdef _WIN32
    return filename.find("_analyzer.dll") != std::string::npos;
#else
    return filename.find("_analyzer.so") != std::string::npos;
#endif
}

fs::path PluginDirectory(const fs::path& root)
{
    for(const auto& candidate : {root, root / "Analyzers", root / "lib"})
        if(fs::is_directory(candidate))
            for(const auto& entry : fs::directory_iterator(candidate))
                if(entry.is_regular_file() && IsAnalyzerPlugin(entry.path()))
                    return candidate;
    throw std::runtime_error("Saleae analyzer plugins were not found under " + root.string());
}

std::vector<fs::path> Plugins(const fs::path& root)
{
    const auto directory = PluginDirectory(root);
    std::vector<fs::path> plugins;
    for(const auto& entry : fs::directory_iterator(directory))
        if(entry.is_regular_file() && IsAnalyzerPlugin(entry.path()))
            plugins.push_back(entry.path());
    std::sort(plugins.begin(), plugins.end());
    return plugins;
}

fs::path FindPlugin(const fs::path& root, const std::string& requested)
{
    const auto normalized = Lower(requested);
    static const std::map<std::string, std::string> aliases = {
        {"uart", "serial"}, {"async_serial", "serial"}, {"parallel", "simple_parallel"},
        {"simple-parallel", "simple_parallel"}, {"i2s_pcm", "i2s"},
    };
    const auto target = aliases.count(normalized) ? aliases.at(normalized) : normalized;
    for(const auto& plugin : Plugins(root))
        if(DecoderId(plugin) == target)
            return plugin;
    throw std::runtime_error("Saleae analyzer plugin '" + requested + "' was not found");
}

fs::path FindPlugin(const std::vector<fs::path>& plugins, const std::string& requested)
{
    const auto normalized = Lower(requested);
    static const std::map<std::string, std::string> aliases = {
        {"uart", "serial"}, {"async_serial", "serial"}, {"parallel", "simple_parallel"},
        {"simple-parallel", "simple_parallel"}, {"i2s_pcm", "i2s"},
    };
    const auto target = aliases.count(normalized) ? aliases.at(normalized) : normalized;
    for(const auto& plugin : plugins)
        if(DecoderId(plugin) == target)
            return plugin;
    throw std::runtime_error("Saleae analyzer plugin '" + requested + "' was not found");
}

Session Open(const fs::path& plugin)
{
    const auto plugin_utf8 = plugin.u8string();
    Session session(sr_session_create(plugin_utf8.c_str()));
    if(!session)
        throw std::runtime_error("failed to allocate Saleae analyzer session");
    if(std::string(sr_session_analyzer_name(session.get())).empty())
        throw std::runtime_error(sr_session_last_error(session.get()));
    return session;
}

json Primitive(double value)
{
    if(value == static_cast<double>(static_cast<long long>(value)))
        return static_cast<long long>(value);
    return value;
}

json CatalogItem(const fs::path& plugin)
{
    auto session = Open(plugin);
    json channels = json::array();
    json optional_channels = json::array();
    json options = json::array();
    int channel_order = 0;
    const auto setting_count = sr_session_setting_count(session.get());
    for(size_t index = 0; index < setting_count; ++index)
    {
        sr_setting_view setting{};
        if(sr_session_setting(session.get(), index, &setting) != 0)
            continue;
        const std::string title = setting.title ? setting.title : "";
        const std::string setting_id = title.empty() ? "__setting_" + std::to_string(index) : title;
        const std::string tooltip = setting.tooltip ? setting.tooltip : "";
        if(setting.kind == SR_SETTING_CHANNEL)
        {
            json channel = {{"id", title}, {"name", title}, {"desc", tooltip}, {"order", channel_order++},
                            {"type", 0}, {"type_name", "logic"}, {"idn", title}};
            (setting.channel_required ? channels : optional_channels).push_back(std::move(channel));
            continue;
        }

        json option = {{"id", setting_id}, {"idn", setting_id},
                       {"desc", tooltip.empty() ? setting_id : tooltip}};
        if(setting.kind == SR_SETTING_NUMBER_LIST)
        {
            option["value_type"] = "enum";
            option["default"] = Primitive(setting.number_value);
            option["values"] = json::array();
            for(size_t option_index = 0; option_index < setting.option_count; ++option_index)
            {
                sr_number_option_view number{};
                if(sr_session_number_option(session.get(), index, option_index, &number) == 0)
                    option["values"].push_back(Primitive(number.value));
            }
        }
        else if(setting.kind == SR_SETTING_INTEGER)
        {
            option["value_type"] = "int";
            option["default"] = setting.integer_value;
            option["values"] = json::array();
        }
        else if(setting.kind == SR_SETTING_BOOL)
        {
            option["value_type"] = "bool";
            option["default"] = setting.integer_value != 0;
            option["values"] = json::array({false, true});
        }
        else
        {
            option["value_type"] = "string";
            option["default"] = setting.text_value ? setting.text_value : "";
            option["values"] = json::array();
        }
        options.push_back(std::move(option));
    }

    const auto name = std::string(sr_session_analyzer_name(session.get()));
    return {{"id", DecoderId(plugin)}, {"name", name}, {"longname", name},
            {"desc", "Saleae standalone analyzer"}, {"license", "See bundled analyzer license"},
            {"kind", "saleae"}, {"runner_status", "generic_sparse_saleae"},
            {"inputs", json::array({"logic"})}, {"outputs", json::array({DecoderId(plugin)})},
            {"tags", json::array({"Saleae", "Native"})}, {"channels", channels},
            {"optional_channels", optional_channels}, {"options", options},
            {"annotations", json::array()}, {"annotation_rows", json::array()}, {"binary", json::array()}};
}

json Probe(const fs::path& root, bool include_catalog)
{
    (void)RuntimeLibrary(root);
    const auto plugins = Plugins(root);
    json protocols = json::array();
    json catalog = json::array();
    std::vector<std::string> names;
    for(const auto& plugin : plugins)
    {
        if(include_catalog)
        {
            auto item = CatalogItem(plugin);
            const auto name = item.value("name", ProtocolNameForId(DecoderId(plugin)));
            names.push_back(name);
            protocols.push_back(name);
            catalog.push_back(std::move(item));
        }
        else
        {
            const auto name = ProtocolNameForId(DecoderId(plugin));
            names.push_back(name);
            protocols.push_back(name);
        }
    }
    std::ostringstream analyzer_names;
    for(size_t index = 0; index < names.size(); ++index)
        analyzer_names << (index ? ", " : "") << names[index];
    return {{"kind", "saleae_native"}, {"display_name", "Saleae Standalone analyzer sidecar"},
            {"available", !plugins.empty()}, {"protocols", protocols}, {"supports_streaming", false},
            {"isolation", "sidecar"}, {"analyzer_name", analyzer_names.str()},
            {"runtime_sha256", "standalone-source"}, {"plugin_sha256", "standalone-source"},
            {"abi_match", true}, {"catalog_included", include_catalog},
            {"edge_encodings", json::array({"delta_varint_base64"})},
            {"decoder_catalog", catalog}, {"c_decoder_count", plugins.size()}, {"python_decoder_count", 0}};
}

std::map<unsigned, std::vector<std::uint64_t>> ParseEdges(const json& input)
{
    const auto base64_value = [](unsigned char character) -> int {
        if(character >= 'A' && character <= 'Z') return character - 'A';
        if(character >= 'a' && character <= 'z') return character - 'a' + 26;
        if(character >= '0' && character <= '9') return character - '0' + 52;
        if(character == '+') return 62;
        if(character == '/') return 63;
        return -1;
    };
    const auto decode_delta_bytes = [](const std::uint8_t* bytes, size_t length) {
        std::vector<std::uint64_t> samples;
        samples.reserve(length);
        std::uint64_t sample = 0;
        std::uint64_t delta = 0;
        unsigned shift = 0;
        for(size_t index = 0; index < length; ++index)
        {
            const auto byte = bytes[index];
            if(shift >= 64 || (shift == 63 && (byte & 0x7e)))
                throw std::runtime_error("edge delta varint overflow");
            delta |= static_cast<std::uint64_t>(byte & 0x7f) << shift;
            if(byte & 0x80)
            {
                shift += 7;
                continue;
            }
            if(delta == 0 || sample > std::numeric_limits<std::uint64_t>::max() - delta)
                throw std::runtime_error("invalid edge delta sequence");
            sample += delta;
            samples.push_back(sample);
            delta = 0;
            shift = 0;
        }
        if(shift != 0) throw std::runtime_error("truncated edge delta varint");
        return samples;
    };

    const auto decode_deltas = [&](const std::string& encoded) {
        std::vector<std::uint8_t> bytes;
        bytes.reserve(encoded.size() * 3 / 4);
        std::uint32_t accumulator = 0;
        unsigned bits = 0;
        for(const unsigned char character : encoded)
        {
            if(character == '=') break;
            const int digit = base64_value(character);
            if(digit < 0) throw std::runtime_error("invalid base64 edge payload");
            accumulator = (accumulator << 6) | static_cast<unsigned>(digit);
            bits += 6;
            if(bits >= 8)
            {
                bits -= 8;
                bytes.push_back(static_cast<std::uint8_t>((accumulator >> bits) & 0xff));
                accumulator = bits == 0 ? 0 : accumulator & ((1u << bits) - 1u);
            }
        }
        return decode_delta_bytes(bytes.data(), bytes.size());
    };

    std::map<unsigned, std::vector<std::uint64_t>> edges;
    for(const auto& edge_set : input.at("edges"))
    {
        const auto channel = edge_set.at("channel").get<unsigned>();
        if(edge_set.value("encoding", "") == "delta_varint_base64")
            edges[channel] = decode_deltas(edge_set.at("samples_b64").get<std::string>());
        else if(edge_set.value("encoding", "") == "delta_varint_framed")
        {
            if(!input.contains("_request_binary") || !input.at("_request_binary").is_binary())
                throw std::runtime_error("framed edge payload is missing request binary data");
            const auto& range = edge_set.at("samples_binary");
            if(!range.is_array() || range.size() != 2)
                throw std::runtime_error("framed edge payload range is invalid");
            const auto offset = range.at(0).get<size_t>();
            const auto length = range.at(1).get<size_t>();
            const auto& binary = input.at("_request_binary").get_binary();
            if(offset > binary.size() || length > binary.size() - offset)
                throw std::runtime_error("framed edge payload range is outside request data");
            edges[channel] = decode_delta_bytes(binary.data() + offset, length);
        }
        else
            edges[channel] = edge_set.at("samples").get<std::vector<std::uint64_t>>();
    }
    return edges;
}

std::string SpecializedChannelTitle(const std::string& protocol, const std::string& key)
{
    const auto id = Lower(protocol);
    const auto role = Lower(key);
    if(id == "uart" || id == "serial" || id == "async_serial") return "Input Channel";
    if(id == "i2c") return role == "sda" ? "SDA" : "SCL";
    if(id == "spi") return role == "clk" || role == "clock" ? "Clock" : role == "cs" || role == "enable" ? "Enable" : role == "mosi" ? "MOSI" : "MISO";
    if(id == "i2s" || id == "i2s_pcm")
    {
        return role == "sck" || role == "clock" || role == "clock channel" ? "CLOCK channel" :
               role == "ws" || role == "frame" ? "FRAME" : "DATA";
    }
    if(id == "can") return "CAN";
    if(id == "lin") return "Serial";
    if(id == "parallel" || id == "simple_parallel")
        return role == "clk" || role == "clock" ? "Clock" :
               (key.size() > 1 && (key[0] == 'd' || key[0] == 'D') ? std::string("D") + key.substr(1) : key);
    return key;
}

std::optional<std::pair<std::string, json>> SpecializedOption(const std::string& protocol, const std::string& key, const json& value)
{
    const auto id = Lower(protocol);
    if(id == "uart" || id == "serial" || id == "async_serial")
    {
        if(key == "baudrate") return {{"Bit Rate (Bits/s)", value}};
        if(key == "data_bits") return {{"Bits per Frame", value}};
        if(key == "stop_bits") return {{"Stop Bits", value}};
        if(key == "parity") return {{"Parity Bit", value == "even" ? 1 : value == "odd" ? 2 : 0}};
        if(key == "bit_order") return {{"Significant Bit", value == "msb-first" ? 1 : 0}};
        if(key == "invert_rx" || key == "inverted")
            return {{"Signal inversion", value.is_boolean() ? json(value.get<bool>() ? 1 : 0) : json(value.get<int>() != 0 ? 1 : 0)}};
    }
    if(id == "spi")
    {
        if(key == "bit_order") return {{"Significant Bit", value == "lsb-first" ? 1 : 0}};
        if(key == "word_size") return {{"Bits per Transfer", value}};
        if(key == "cpol") return {{"Clock State", value}};
        if(key == "cpha") return {{"Clock Phase", value}};
        if(key == "cs_polarity") return {{"Enable Line", value == "active-high" ? 1 : 0}};
    }
    if(id == "i2s" || id == "i2s_pcm")
    {
        if(key == "bit_order") return {{"DATA Significant Bit", value == "lsb-first" ? 1 : 0}};
        if(key == "clk_edge") return {{"CLOCK State", value == "rising-edge" ? 1 : 0}};
        if(key == "word_size") return {{"Audio Bit Depth (bits/sample)", value}};
        if(key == "frame_transitions") return {{"FRAME Signal Transitions", value == "twice-each-word" ? 0 : value == "twice-every-four-words" ? 2 : 1}};
        if(key == "bit_align") return {{"DATA Bits Alignment", value == "right-aligned" ? 1 : 0}};
        if(key == "bit_shift") return {{"DATA Bits Shift", value == "none" ? 1 : 0}};
        if(key == "signed") return {{"Signed/Unsigned", value.get<bool>() ? 1 : 0}};
        if(key == "ws_polarity") return {{"Word Select High", value == "left-high" ? 1 : 0}};
    }
    if(id == "can")
    {
        if(key == "bitrate") return {{"Bit Rate (Bits/s)", value}};
        if(key == "inverted") return {{"", value}};
    }
    if(id == "lin")
    {
        if(key == "baudrate") return {{"Bit Rate (Bits/s)", value}};
        if(key == "version") return {{"LIN Version", value}};
    }
    if((id == "parallel" || id == "simple_parallel") && (key == "clock_edge" || key == "clock_state"))
        return {{"Clock State", value.is_string() ? json(value == "falling" ? 1 : value == "dual" ? 2 : 0) : value}};
    return std::nullopt;
}

void Check(sr_session* session, int result, const std::string& action)
{
    if(result != 0)
        throw std::runtime_error(action + ": " + sr_session_last_error(session));
}

void ApplyOption(sr_session* session, const std::string& title, const json& value)
{
    sr_setting_view metadata{};
    bool found = false;
    std::string actual_title = title;
    std::optional<size_t> requested_index;
    if(title.rfind("__setting_", 0) == 0)
        requested_index = static_cast<size_t>(std::stoull(title.substr(std::string("__setting_").size())));
    for(size_t index = 0; index < sr_session_setting_count(session); ++index)
        if(sr_session_setting(session, index, &metadata) == 0 &&
           ((requested_index && *requested_index == index) || (!requested_index && title == (metadata.title ? metadata.title : ""))))
        {
            found = true;
            actual_title = metadata.title ? metadata.title : "";
            break;
        }
    if(!found)
        return;
    if(metadata.kind == SR_SETTING_NUMBER_LIST)
        Check(session, sr_session_set_number_setting(session, actual_title.c_str(), value.get<double>()), "set " + title);
    else if(metadata.kind == SR_SETTING_INTEGER)
        Check(session, sr_session_set_integer_setting(session, actual_title.c_str(), value.get<int>()), "set " + title);
    else if(metadata.kind == SR_SETTING_BOOL)
        Check(session, sr_session_set_bool_setting(session, actual_title.c_str(), value.get<bool>() ? 1 : 0), "set " + title);
    else if(metadata.kind == SR_SETTING_TEXT)
        Check(session, sr_session_set_text_setting(session, actual_title.c_str(), value.get<std::string>().c_str()), "set " + title);
}

json FieldValue(const sr_field_view& field)
{
    switch(field.kind)
    {
    case SR_FIELD_STRING: return {{"Text", field.string_value ? field.string_value : ""}};
    case SR_FIELD_DOUBLE: return {{"Text", std::to_string(field.double_value)}};
    case SR_FIELD_INTEGER: return field.integer_value < 0 ? json{{"Signed", field.integer_value}} : json{{"Unsigned", field.integer_value}};
    case SR_FIELD_BOOLEAN: return {{"Boolean", field.boolean_value != 0}};
    case SR_FIELD_BYTE: return {{"Unsigned", field.integer_value}};
    case SR_FIELD_BYTES: return {{"Bytes", std::vector<unsigned char>(field.bytes_value, field.bytes_value + field.bytes_length)}};
    }
    return {{"Text", ""}};
}

std::string FieldText(const sr_field_view& field)
{
    if(field.kind == SR_FIELD_STRING) return field.string_value ? field.string_value : "";
    if(field.kind == SR_FIELD_BOOLEAN) return field.boolean_value ? "true" : "false";
    if(field.kind == SR_FIELD_DOUBLE) return std::to_string(field.double_value);
    if(field.kind == SR_FIELD_BYTES)
    {
        std::ostringstream output;
        output << std::hex;
        for(size_t index = 0; index < field.bytes_length; ++index) output << (index ? " " : "") << static_cast<int>(field.bytes_value[index]);
        return output.str();
    }
    return std::to_string(field.integer_value);
}

std::optional<unsigned long long> NumericField(const sr_field_view& field)
{
    if(field.kind == SR_FIELD_BOOLEAN) return field.boolean_value ? 1 : 0;
    if(field.kind == SR_FIELD_INTEGER || field.kind == SR_FIELD_BYTE)
        return static_cast<unsigned long long>(field.integer_value);
    if(field.kind == SR_FIELD_BYTES && field.bytes_length)
    {
        unsigned long long value = 0;
        for(size_t index = 0; index < field.bytes_length; ++index) value = (value << 8) | field.bytes_value[index];
        return value;
    }
    return std::nullopt;
}

ConfiguredChannelMap ConfiguredChannels(const json& channels)
{
    ConfiguredChannelMap configured;
    configured.reserve(channels.size());
    for(const auto& [key, value] : channels.items())
        if(!value.is_null()) configured[Lower(key)] = value.get<unsigned>();
    return configured;
}

std::optional<unsigned> ConfiguredChannel(const ConfiguredChannelMap& channels, const char* name)
{
    const auto found = channels.find(name);
    if(found == channels.end())
        return std::nullopt;
    return found->second;
}

std::string RoleForField(const std::string& protocol_lower, const std::string& field)
{
    if(protocol_lower == "spi") return field == "mosi" ? "MOSI" : field == "miso" ? "MISO" : "Data";
    if(protocol_lower == "can")
    {
        if(field == "identifier") return "Identifier";
        if(field == "num_data_bytes") return "DLC";
        if(field == "crc") return "CRC";
        if(field == "ack") return "ACK";
        if(field == "data") return "Data";
    }
    if(protocol_lower == "lin") return "LIN";
    return "Data";
}

unsigned ChannelForField(
    const std::string& protocol_lower,
    const std::string& field,
    const ConfiguredChannelMap& channels,
    unsigned primary_channel)
{
    if(protocol_lower == "spi")
    {
        if(field == "mosi") return ConfiguredChannel(channels, "mosi").value_or(primary_channel);
        if(field == "miso") return ConfiguredChannel(channels, "miso").value_or(primary_channel);
    }
    if(protocol_lower == "i2c") return ConfiguredChannel(channels, "sda").value_or(primary_channel);
    if(protocol_lower == "uart" || protocol_lower == "serial" || protocol_lower == "async_serial")
        return ConfiguredChannel(channels, "rx").value_or(primary_channel);
    if(protocol_lower == "i2s" || protocol_lower == "i2s_pcm")
    {
        if(const auto channel = ConfiguredChannel(channels, "sd")) return *channel;
        return ConfiguredChannel(channels, "data").value_or(primary_channel);
    }
    if(protocol_lower == "can")
    {
        if(const auto channel = ConfiguredChannel(channels, "can_rx")) return *channel;
        return ConfiguredChannel(channels, "can").value_or(primary_channel);
    }
    if(protocol_lower == "lin")
    {
        if(const auto channel = ConfiguredChannel(channels, "rx")) return *channel;
        return ConfiguredChannel(channels, "serial").value_or(primary_channel);
    }
    return primary_channel;
}

bool ExposeField(const std::string& protocol_lower, const std::string& row, const std::string& field)
{
    if(protocol_lower == "uart" || protocol_lower == "serial" || protocol_lower == "async_serial") return field == "data";
    if(protocol_lower == "i2c") return field == "address" || field == "data";
    if(protocol_lower == "spi") return field == "mosi" || field == "miso";
    if(protocol_lower == "i2s" || protocol_lower == "i2s_pcm") return field == "data";
    if(protocol_lower == "can") return field == "identifier" || field == "num_data_bytes" || field == "data" || field == "crc" || field == "ack";
    if(protocol_lower == "lin")
    {
        if(row == "data_or_checksum") return field == "checksum";
        return field == "protected_id" || field == "data" || field == "checksum";
    }
    return true;
}

bool StructuredProtocolCanLabelWithoutLegacyBubbleText(const std::string& protocol_lower)
{
    return protocol_lower == "i2c" || protocol_lower == "spi";
}

const char* MarkerKind(int kind)
{
    static const char* kinds[] = {
        "dot", "error_dot", "square", "error_square", "up_arrow", "down_arrow",
        "x", "error_x", "start", "stop", "one", "zero"};
    return kind >= 0 && kind < static_cast<int>(sizeof(kinds) / sizeof(kinds[0])) ? kinds[kind] : "dot";
}

std::vector<std::string> BubbleText(sr_session* session, size_t frame, unsigned channel)
{
    if(sr_session_generate_bubble_text(session, frame, channel, 2) != 0)
        return {};
    std::vector<std::string> texts;
    for(size_t index = 0; index < sr_session_bubble_text_count(session); ++index)
        if(const auto* text = sr_session_bubble_text(session, index); text && *text)
            texts.emplace_back(text);
    return texts;
}

std::optional<std::vector<std::string>> IncrementalLegacyBubbleText(
    const sr_session* session,
    size_t frame_index,
    unsigned channel_index)
{
    sr_incremental_legacy_frame_view frame{};
    if(sr_session_incremental_legacy_frame(session, frame_index, &frame) != 0)
        return std::nullopt;
    for(size_t index = 0; index < frame.channel_count; ++index)
    {
        sr_incremental_legacy_channel_view channel{};
        if(sr_session_incremental_legacy_channel(session, frame_index, index, &channel) != 0 ||
           channel.channel_index != channel_index)
        {
            continue;
        }
        std::vector<std::string> texts;
        texts.reserve(channel.text_count);
        for(size_t text_index = 0; text_index < channel.text_count; ++text_index)
        {
            const auto* text = sr_session_incremental_legacy_text(
                session,
                frame_index,
                index,
                text_index);
            if(text && *text)
                texts.emplace_back(text);
        }
        return texts;
    }
    return std::nullopt;
}

size_t BubbleTextCacheReserve(size_t structured_count, size_t legacy_count, size_t configured_channel_count)
{
    const auto estimated = std::max(structured_count, legacy_count) * std::max<size_t>(configured_channel_count, 1);
    return std::min(estimated, kMaxBubbleTextCacheReserve);
}

std::optional<size_t> MatchingLegacyFrame(
    sr_session* session,
    const sr_frame_view& frame,
    size_t legacy_count,
    size_t& cursor)
{
    while(cursor < legacy_count)
    {
        sr_legacy_frame_view legacy{};
        if(sr_session_legacy_frame(session, cursor, &legacy) != 0)
        {
            ++cursor;
            continue;
        }
        const auto start = static_cast<std::uint64_t>(std::max<std::int64_t>(legacy.start_sample, 0));
        const auto end = static_cast<std::uint64_t>(std::max<std::int64_t>(legacy.end_sample, 0));
        if(start == frame.start_sample && (end == frame.end_sample || end + 1 == frame.end_sample))
            return cursor++;
        if(start >= frame.start_sample)
            break;
        ++cursor;
    }
    return std::nullopt;
}

json StringIndexes(const std::vector<std::string>& values, CompactStringDictionary* strings)
{
    json output = json::array();
    output.get_ref<json::array_t&>().reserve(values.size());
    for(const auto& value : values)
        output.push_back(strings->Index(value));
    return output;
}

void PutStringIndexes(std::vector<std::uint8_t>& output, const std::vector<std::string>& values, CompactStringDictionary* strings)
{
    PutVarint(output, values.size());
    for(const auto& value : values)
        PutVarint(output, strings->Index(value));
}

json Markers(sr_session* session, ResponseFormat format, CompactStringDictionary* strings)
{
    json markers = json::array();
    const auto marker_count = sr_session_marker_count(session);
    markers.get_ref<json::array_t&>().reserve(marker_count);
    for(size_t index = 0; index < marker_count; ++index)
    {
        sr_marker_view marker{};
        if(sr_session_marker(session, index, &marker) != 0)
            continue;
        if(marker.channel_index > 255)
            continue;
        const auto kind = MarkerKind(marker.kind);
        if(format == ResponseFormat::CompactV4 || format == ResponseFormat::BinaryV1)
            markers.push_back(json::array({
                strings->Index("marker"),
                marker.channel_index,
                marker.sample,
                strings->Index(kind)}));
        else if(format != ResponseFormat::Standard)
            markers.push_back(json::array({"marker", marker.channel_index, marker.sample, kind}));
        else
            markers.push_back({{"row", "marker"}, {"channel", marker.channel_index},
                               {"sample", marker.sample}, {"kind", kind}});
    }
    return markers;
}

json AsyncCompletionMarkers(sr_session* session, bool framed_binary_transport)
{
    const auto marker_count = sr_session_marker_count(session);
    std::vector<sr_marker_view> markers;
    markers.reserve(marker_count);
    for(size_t index = 0; index < marker_count; ++index)
    {
        sr_marker_view marker{};
        if(sr_session_marker(session, index, &marker) != 0 || marker.channel_index > 255)
            continue;
        markers.push_back(marker);
    }
    std::vector<std::uint8_t> payload;
    payload.reserve(markers.size() * 4 + 12);
    static constexpr std::uint8_t kMagic[] = {'P', 'X', 'L', 'M', '1'};
    payload.insert(payload.end(), kMagic, kMagic + sizeof(kMagic));
    PutVarint(payload, markers.size());
    for(const auto& marker : markers)
    {
        PutVarint(payload, marker.channel_index);
        PutVarint(payload, marker.sample);
        PutVarint(payload, static_cast<std::uint64_t>(std::max(marker.kind, 0)));
    }
    auto blob = framed_binary_transport
        ? json::binary(payload)
        : json(Base64Encode(payload));
    return {
        {"format", "pxlogic.decoder.markers.binary_v1"},
        {"blob", std::move(blob)},
    };
}

ResponseFormat RequestedResponseFormat(const json& input)
{
    const auto format = input.value("response_format", std::string());
    if(format == "binary_v1")
        return ResponseFormat::BinaryV1;
    if(format == "compact_v4")
        return ResponseFormat::CompactV4;
    if(format == "compact_v3")
        return ResponseFormat::CompactV3;
    if(format == "compact_v2")
        return ResponseFormat::CompactV2;
    if(format == "compact_v1")
        return ResponseFormat::CompactV1;
    return ResponseFormat::Standard;
}

bool CompactResponseRequested(ResponseFormat format)
{
    return format != ResponseFormat::Standard;
}

bool IncludeFieldsRequested(const json& input)
{
    return input.value("include_fields", true);
}

std::string HexByte(unsigned long long value)
{
    char label[32];
    if(value <= 0xff)
        std::snprintf(label, sizeof(label), "0x%02llX", value);
    else
        std::snprintf(label, sizeof(label), "0x%llX", value);
    return label;
}

std::optional<std::string> I2cDisplayLabel(
    const std::string& row,
    const std::vector<std::string>& texts,
    const std::optional<unsigned long long>& address,
    const std::optional<bool>& read,
    const std::optional<unsigned long long>& data,
    const std::optional<bool>& ack,
    bool missing_ack)
{
    const auto lower_row = Lower(row);
    if(lower_row == "address")
    {
        for(const auto& text : texts)
            if(text.rfind("W[", 0) == 0 || text.rfind("R[", 0) == 0)
                return text;
        if(address)
        {
            std::ostringstream label;
            label << (read.value_or(false) ? 'R' : 'W') << '[' << HexByte(*address) << ']';
            return label.str();
        }
    }
    if(lower_row == "data")
    {
        for(const auto& text : texts)
            if(text.find(" + ACK") != std::string::npos ||
               text.find(" + NAK") != std::string::npos ||
               text.find("Missing ACK/NAK") != std::string::npos)
                return text;
        if(data)
        {
            auto label = HexByte(*data);
            if(ack)
                label += (*ack ? " + ACK" : " + NAK");
            else if(missing_ack)
                label += " + Missing ACK/NAK";
            return label;
        }
    }
    return std::nullopt;
}

json FieldValueCompact(const sr_field_view& field)
{
    const std::string name = field.key ? field.key : "value";
    switch(field.kind)
    {
    case SR_FIELD_STRING: return json::array({name, "t", field.string_value ? field.string_value : ""});
    case SR_FIELD_DOUBLE: return json::array({name, "t", std::to_string(field.double_value)});
    case SR_FIELD_INTEGER:
        return field.integer_value < 0
            ? json::array({name, "s", field.integer_value})
            : json::array({name, "u", field.integer_value});
    case SR_FIELD_BOOLEAN: return json::array({name, "b", field.boolean_value != 0});
    case SR_FIELD_BYTE: return json::array({name, "u", field.integer_value});
    case SR_FIELD_BYTES:
        return json::array({name, "bytes",
            std::vector<unsigned char>(field.bytes_value, field.bytes_value + field.bytes_length)});
    }
    return json::array({name, "t", ""});
}

json FieldValueJson(const sr_field_view& field, bool compact)
{
    if(compact)
        return FieldValueCompact(field);
    return {{"name", field.key ? field.key : "value"}, {"value", FieldValue(field)}};
}

json ChannelValuesJson(
    const std::vector<ChannelValueOutput>& values,
    ResponseFormat format,
    CompactRoleDictionary* roles,
    CompactStringDictionary* strings)
{
    json output = json::array();
    output.get_ref<json::array_t&>().reserve(values.size());
    for(const auto& value : values)
    {
        if(format == ResponseFormat::CompactV4 || format == ResponseFormat::BinaryV1)
        {
            const auto role_index = roles ? roles->Index(value.role) : 0;
            const auto label_index = strings->Index(value.label);
            if(value.texts.empty())
                output.push_back(json::array({
                    value.channel,
                    role_index,
                    label_index,
                    value.value,
                }));
            else
                output.push_back(json::array({
                    value.channel,
                    role_index,
                    label_index,
                    StringIndexes(value.texts, strings),
                    value.value,
                }));
        }
        else if(format == ResponseFormat::CompactV3)
        {
            const auto role_index = roles ? roles->Index(value.role) : 0;
            if(value.texts.empty())
                output.push_back(json::array({
                    value.channel,
                    role_index,
                    value.label,
                    value.value,
                }));
            else
                output.push_back(json::array({
                    value.channel,
                    role_index,
                    value.label,
                    value.texts,
                    value.value,
                }));
        }
        else if(format == ResponseFormat::CompactV2)
        {
            if(value.texts.empty())
                output.push_back(json::array({
                    value.channel,
                    value.role,
                    value.label,
                    value.value,
                }));
            else
                output.push_back(json::array({
                    value.channel,
                    value.role,
                    value.label,
                    value.texts,
                    value.value,
                }));
        }
        else if(format == ResponseFormat::CompactV1)
        {
            output.push_back(json::array({
                value.channel,
                value.role,
                value.label,
                value.texts,
                value.value,
            }));
        }
        else
        {
            output.push_back({{"channel", value.channel}, {"role", value.role},
                              {"label", value.label}, {"texts", value.texts},
                              {"value", value.value}});
        }
    }
    return output;
}

void PutChannelValues(std::vector<std::uint8_t>& output,
                      const std::vector<ChannelValueOutput>& values,
                      CompactRoleDictionary* roles,
                      CompactStringDictionary* strings)
{
    PutVarint(output, values.size());
    for(const auto& value : values)
    {
        PutVarint(output, value.channel);
        PutVarint(output, roles ? roles->Index(value.role) : 0);
        PutVarint(output, strings->Index(value.label));
        PutVarint(output, value.value);
        PutStringIndexes(output, value.texts, strings);
    }
}

struct BinaryPayloadBuilder
{
    std::vector<std::uint8_t> frames;
    size_t frame_count = 0;

    void AddFrame(
        CompactRoleDictionary* roles,
        CompactStringDictionary* strings,
        unsigned long long frame_id,
        unsigned long long start_sample,
        unsigned long long end_sample,
        const std::string& row,
        const std::vector<std::string>& texts,
        const std::vector<ChannelValueOutput>& channel_values)
    {
        ++frame_count;
        PutVarint(frames, frame_id);
        PutVarint(frames, start_sample);
        PutVarint(frames, end_sample);
        PutVarint(frames, strings->Index(row));
        PutStringIndexes(frames, texts, strings);
        PutChannelValues(frames, channel_values, roles, strings);
    }
};

json FrameJson(
    ResponseFormat format,
    CompactRoleDictionary* roles,
    CompactStringDictionary* strings,
    unsigned long long frame_id,
    unsigned long long start_sample,
    unsigned long long end_sample,
    const std::string& row,
    const std::vector<std::string>& texts,
    json fields,
    const std::vector<ChannelValueOutput>& channel_values,
    json markers)
{
    if(format == ResponseFormat::CompactV4 || format == ResponseFormat::BinaryV1)
    {
        return json::array({
            frame_id,
            start_sample,
            end_sample,
            strings->Index(row),
            StringIndexes(texts, strings),
            ChannelValuesJson(channel_values, format, roles, strings),
        });
    }
    if(format == ResponseFormat::CompactV3 || format == ResponseFormat::CompactV2)
    {
        return json::array({
            frame_id,
            start_sample,
            end_sample,
            row,
            texts,
            ChannelValuesJson(channel_values, format, roles, strings),
        });
    }
    if(format == ResponseFormat::CompactV1)
    {
        return json::array({
            frame_id,
            start_sample,
            end_sample,
            row,
            texts,
            std::move(fields),
            ChannelValuesJson(channel_values, format, roles, strings),
            std::move(markers),
        });
    }
    return {{"frame_id", frame_id}, {"start_sample", start_sample}, {"end_sample", end_sample},
            {"row", row}, {"texts", texts}, {"fields", std::move(fields)},
            {"channel_values", ChannelValuesJson(channel_values, format, roles, strings)},
            {"markers", std::move(markers)}};
}

std::vector<std::uint8_t> BinaryPayloadV1(const BinaryPayloadBuilder& frames, const json& markers, const json& diagnostics)
{
    std::vector<std::uint8_t> output;
    output.reserve(frames.frames.size() + markers.size() * 8 + diagnostics.size() * 4 + 16);
    static constexpr std::uint8_t kMagic[] = {'P', 'X', 'L', 'B', '1'};
    output.insert(output.end(), kMagic, kMagic + sizeof(kMagic));

    PutVarint(output, frames.frame_count);
    output.insert(output.end(), frames.frames.begin(), frames.frames.end());

    PutVarint(output, markers.size());
    for(const auto& marker : markers)
    {
        PutVarint(output, marker.at(0).get<std::uint64_t>());
        if(marker.at(1).is_null())
        {
            PutVarint(output, 0);
        }
        else
        {
            PutVarint(output, 1);
            PutVarint(output, marker.at(1).get<std::uint64_t>());
        }
        PutVarint(output, marker.at(2).get<std::uint64_t>());
        PutVarint(output, marker.at(3).get<std::uint64_t>());
    }

    PutVarint(output, diagnostics.size());
    for(const auto& diagnostic : diagnostics)
    {
        PutVarint(output, diagnostic.at(0).get<std::uint64_t>());
        PutVarint(output, diagnostic.at(1).get<std::uint64_t>());
    }
    return output;
}

json OutputBinaryJson(
    const std::string& protocol,
    const CompactRoleDictionary& roles,
    CompactStringDictionary& strings,
    const BinaryPayloadBuilder& frames,
    json markers,
    bool framed_binary_transport)
{
    const json diagnostics = json::array({
        json::array({
            strings.Index("info"),
            strings.Index("Saleae standalone sparse analyzer completed"),
        })
    });
    const auto payload = BinaryPayloadV1(frames, markers, diagnostics);
    auto blob = framed_binary_transport ? json::binary(payload) : json(Base64Encode(payload));
    return json{{"format", "pxlogic.decoder.binary_v1"}, {"p", protocol},
                {"n", frames.frame_count},
                {"r", roles.roles}, {"s", strings.strings}, {"b", std::move(blob)}};
}

json OutputJson(
    ResponseFormat format,
    const std::string& protocol,
    const CompactRoleDictionary& roles,
    CompactStringDictionary& strings,
    json frames,
    json markers)
{
    if(format == ResponseFormat::CompactV4)
    {
        const json diagnostics = json::array({
            json::array({
                strings.Index("info"),
                strings.Index("Saleae standalone sparse analyzer completed"),
            })
        });
        return json{{"format", "pxlogic.decoder.compact_v4"}, {"p", protocol},
                    {"r", roles.roles}, {"s", strings.strings}, {"f", std::move(frames)},
                    {"m", std::move(markers)}, {"d", diagnostics}};
    }

    const json diagnostics = CompactResponseRequested(format)
        ? json::array({json::array({"info", "Saleae standalone sparse analyzer completed"})})
        : json::array({{{"level", "info"}, {"message", "Saleae standalone sparse analyzer completed"}}});
    if(format == ResponseFormat::CompactV3)
        return json{{"format", "pxlogic.decoder.compact_v3"}, {"p", protocol},
                    {"r", roles.roles}, {"f", std::move(frames)}, {"m", std::move(markers)}, {"d", diagnostics}};
    if(format == ResponseFormat::CompactV2)
        return json{{"format", "pxlogic.decoder.compact_v2"}, {"p", protocol},
                    {"f", std::move(frames)}, {"m", std::move(markers)}, {"d", diagnostics}};
    if(format == ResponseFormat::CompactV1)
        return json{{"format", "pxlogic.decoder.compact_v1"},
                    {"p", protocol}, {"f", std::move(frames)}, {"d", diagnostics}};
    return {{"backend", "saleae_native"}, {"protocol", protocol},
            {"frames", std::move(frames)}, {"diagnostics", diagnostics}};
}

bool SupportsIncrementalStructuredOutput(const json& decoder)
{
    const auto protocol = Lower(decoder.at("protocol").get<std::string>());
    return StructuredProtocolCanLabelWithoutLegacyBubbleText(protocol);
}

json IncrementalStructuredOutput(
    sr_session* session,
    const json& input,
    const json& decoder,
    size_t begin_frame,
    size_t end_frame)
{
    const auto protocol = decoder.at("protocol").get<std::string>();
    const auto protocol_lower = Lower(protocol);
    const auto response_format = RequestedResponseFormat(input);
    const bool compact = CompactResponseRequested(response_format);
    const bool include_fields = IncludeFieldsRequested(input);
    const bool binary_response = response_format == ResponseFormat::BinaryV1;
    CompactRoleDictionary role_dictionary;
    CompactStringDictionary string_dictionary;
    const auto configured_channels = ConfiguredChannels(decoder.at("channels"));
    const unsigned primary_channel = decoder.value("primary_channel", 0u);
    json frames = json::array();
    BinaryPayloadBuilder binary_frames;
    if(binary_response)
        binary_frames.frames.reserve((end_frame - begin_frame) * 24);
    else
        frames.get_ref<json::array_t&>().reserve(end_frame - begin_frame);

    for(size_t index = begin_frame; index < end_frame; ++index)
    {
        sr_frame_view frame{};
        if(sr_session_frame(session, index, &frame) != 0)
            continue;
        json fields = json::array();
        if(include_fields)
            fields.get_ref<json::array_t&>().reserve(frame.field_count);
        std::vector<std::string> texts;
        std::vector<ChannelValueOutput> channel_values;
        channel_values.reserve(frame.field_count);
        const std::string row = frame.type ? frame.type : sr_session_analyzer_name(session);
        std::optional<unsigned long long> i2c_address;
        std::optional<unsigned long long> i2c_data;
        std::optional<bool> i2c_read;
        std::optional<bool> i2c_ack;
        bool i2c_missing_ack = false;

        for(size_t field_index = 0; field_index < frame.field_count; ++field_index)
        {
            sr_field_view field{};
            if(sr_session_frame_field(session, index, field_index, &field) != 0)
                continue;
            if(include_fields)
                fields.push_back(FieldValueJson(field, compact));
            const std::string field_key = field.key ? field.key : "value";
            const auto field_key_lower = Lower(field_key);
            std::optional<std::string> field_text;
            const auto get_field_text = [&]() -> const std::string& {
                if(!field_text)
                    field_text = FieldText(field);
                return *field_text;
            };
            const auto numeric = NumericField(field);
            if(protocol_lower == "i2c")
            {
                if(field_key_lower == "address" && numeric)
                    i2c_address = *numeric;
                else if(field_key_lower == "data" && numeric)
                    i2c_data = *numeric;
                else if(field_key_lower == "read" && numeric)
                    i2c_read = *numeric != 0;
                else if(field_key_lower == "ack" && numeric)
                    i2c_ack = *numeric != 0;
                else if(field_key_lower == "error" && Lower(get_field_text()).find("ack") != std::string::npos)
                    i2c_missing_ack = true;
            }
            if(numeric && ExposeField(protocol_lower, row, field_key_lower))
            {
                const auto role = RoleForField(protocol_lower, field_key_lower);
                const auto channel = ChannelForField(
                    protocol_lower,
                    field_key_lower,
                    configured_channels,
                    primary_channel);
                const auto label = HexByte(*numeric);
                channel_values.push_back(ChannelValueOutput{
                    channel,
                    role,
                    label,
                    protocol_lower == "spi" ? std::vector<std::string>{label} : std::vector<std::string>{},
                    *numeric,
                });
                if(protocol_lower == "spi")
                    texts.push_back(label);
            }
        }

        if(texts.empty())
            texts.push_back(frame.type ? frame.type : sr_session_analyzer_name(session));
        if(const auto label = I2cDisplayLabel(
               row,
               texts,
               i2c_address,
               i2c_read,
               i2c_data,
               i2c_ack,
               i2c_missing_ack))
        {
            texts = {*label};
            for(auto& value : channel_values)
            {
                value.label = *label;
                value.texts = {*label};
            }
        }

        if(binary_response)
            binary_frames.AddFrame(
                &role_dictionary,
                &string_dictionary,
                index,
                frame.start_sample,
                frame.end_sample,
                row,
                texts,
                channel_values);
        else
            frames.push_back(FrameJson(
                response_format,
                &role_dictionary,
                &string_dictionary,
                index,
                frame.start_sample,
                frame.end_sample,
                row,
                texts,
                std::move(fields),
                channel_values,
                json::array()));
    }

    const auto markers = json::array();
    if(binary_response)
        return OutputBinaryJson(
            sr_session_analyzer_name(session),
            role_dictionary,
            string_dictionary,
            binary_frames,
            markers,
            FramedBinaryTransportRequested(input));
    return OutputJson(
        response_format,
        sr_session_analyzer_name(session),
        role_dictionary,
        string_dictionary,
        std::move(frames),
        markers);
}

json IncrementalLegacyOutput(
    sr_session* session,
    const json& input,
    const json& decoder,
    size_t begin_frame,
    size_t end_frame)
{
    const auto protocol = decoder.at("protocol").get<std::string>();
    const auto protocol_lower = Lower(protocol);
    const auto response_format = RequestedResponseFormat(input);
    const bool compact = CompactResponseRequested(response_format);
    const bool include_fields = IncludeFieldsRequested(input);
    const bool binary_response = response_format == ResponseFormat::BinaryV1;
    const unsigned primary_channel = decoder.value("primary_channel", 0u);
    CompactRoleDictionary role_dictionary;
    CompactStringDictionary string_dictionary;
    json frames = json::array();
    BinaryPayloadBuilder binary_frames;
    if(binary_response)
        binary_frames.frames.reserve((end_frame - begin_frame) * 24);
    else
        frames.get_ref<json::array_t&>().reserve(end_frame - begin_frame);

    for(size_t index = begin_frame; index < end_frame; ++index)
    {
        sr_incremental_legacy_frame_view frame{};
        if(sr_session_incremental_legacy_frame(session, index, &frame) != 0)
            continue;
        auto texts = IncrementalLegacyBubbleText(session, index, primary_channel)
            .value_or(std::vector<std::string>{});
        std::ostringstream label;
        label << "0x" << std::hex << frame.data1;
        if(texts.empty())
            texts.push_back(label.str());

        std::vector<ChannelValueOutput> channel_values;
        channel_values.reserve(protocol_lower == "swd" ? decoder.at("channels").size() : 1);
        if(protocol_lower == "swd")
        {
            for(const auto& [role, configured_channel] : decoder.at("channels").items())
            {
                if(configured_channel.is_null())
                    continue;
                const auto channel = configured_channel.get<unsigned>();
                auto candidates = IncrementalLegacyBubbleText(session, index, channel)
                    .value_or(std::vector<std::string>{});
                channel_values.push_back(ChannelValueOutput{
                    channel,
                    role,
                    candidates.empty() ? label.str() : candidates.back(),
                    candidates.empty() ? std::vector<std::string>{label.str()} : std::move(candidates),
                    frame.data1,
                });
            }
        }
        else
        {
            channel_values.push_back(ChannelValueOutput{
                primary_channel,
                "Data",
                label.str(),
                texts,
                frame.data1,
            });
        }

        const auto row = "frame_" + std::to_string(frame.type);
        json fields = json::array();
        if(include_fields)
        {
            fields = compact
                ? json::array({
                    json::array({"data1", "u", frame.data1}),
                    json::array({"data2", "u", frame.data2}),
                    json::array({"flags", "u", frame.flags}),
                  })
                : json::array({
                    {{"name", "data1"}, {"value", json{{"Unsigned", frame.data1}}}},
                    {{"name", "data2"}, {"value", json{{"Unsigned", frame.data2}}}},
                    {{"name", "flags"}, {"value", json{{"Unsigned", frame.flags}}}},
                  });
        }
        if(binary_response)
        {
            binary_frames.AddFrame(
                &role_dictionary,
                &string_dictionary,
                index,
                std::max<std::int64_t>(frame.start_sample, 0),
                std::max<std::int64_t>(frame.end_sample, 0),
                row,
                texts,
                channel_values);
        }
        else
        {
            frames.push_back(FrameJson(
                response_format,
                &role_dictionary,
                &string_dictionary,
                index,
                std::max<std::int64_t>(frame.start_sample, 0),
                std::max<std::int64_t>(frame.end_sample, 0),
                row,
                texts,
                std::move(fields),
                channel_values,
                json::array()));
        }
    }

    const auto markers = json::array();
    if(binary_response)
    {
        return OutputBinaryJson(
            sr_session_analyzer_name(session),
            role_dictionary,
            string_dictionary,
            binary_frames,
            markers,
            FramedBinaryTransportRequested(input));
    }
    return OutputJson(
        response_format,
        sr_session_analyzer_name(session),
        role_dictionary,
        string_dictionary,
        std::move(frames),
        markers);
}

json DecodeWithEdges(
    const fs::path& root,
    const std::vector<fs::path>& plugins,
    const json& input,
    const json& decoder,
    const std::map<unsigned, std::vector<std::uint64_t>>& edges,
    AsyncSessionObserver* observer = nullptr)
{
    const auto protocol = decoder.at("protocol").get<std::string>();
    const auto protocol_lower = Lower(protocol);
    const auto response_format = RequestedResponseFormat(input);
    const bool compact = CompactResponseRequested(response_format);
    const bool include_fields = IncludeFieldsRequested(input);
    CompactRoleDictionary role_dictionary;
    CompactStringDictionary string_dictionary;
    auto session = Open(FindPlugin(plugins, protocol));
    AsyncSessionPublication publication{observer};
    Check(session.get(), sr_session_set_sample_rate(session.get(), input.at("sample_rate_hz").get<unsigned long long>()), "set sample rate");

    const auto initial_levels = input.at("initial_levels").get<std::vector<unsigned char>>();
    unsigned primary_channel = decoder.value("primary_channel", 0u);
    const auto configured_channels = ConfiguredChannels(decoder.at("channels"));
    const bool structured_text_without_legacy = StructuredProtocolCanLabelWithoutLegacyBubbleText(protocol_lower);
    size_t incremental_legacy_count = 0;
    std::unordered_map<BubbleTextKey, std::vector<std::string>, BubbleTextKeyHash> bubble_text_cache;
    const auto bubble_text = [&](size_t frame, unsigned channel) -> const std::vector<std::string>& {
        const BubbleTextKey key{frame, channel};
        if(const auto found = bubble_text_cache.find(key); found != bubble_text_cache.end())
            return found->second;
        auto texts = frame < incremental_legacy_count
            ? IncrementalLegacyBubbleText(session.get(), frame, channel)
                  .value_or(std::vector<std::string>{})
            : BubbleText(session.get(), frame, channel);
        const auto inserted = bubble_text_cache.emplace(key, std::move(texts));
        return inserted.first->second;
    };
    size_t configured_channel_count = 0;
    for(const auto& [key, value] : decoder.at("channels").items())
    {
        if(value.is_null()) continue;
        ++configured_channel_count;
        const auto channel = value.get<unsigned>();
        const auto title = SpecializedChannelTitle(protocol, key);
        const auto found = edges.find(channel);
        const std::vector<std::uint64_t> empty;
        const auto& transitions = found == edges.end() ? empty : found->second;
        Check(session.get(), sr_session_add_channel(session.get(), title.c_str(), channel,
              channel < initial_levels.size() && initial_levels[channel] != 0, transitions.data(), transitions.size()), "set channel " + title);
    }
    for(const auto& [key, value] : decoder.at("options").items())
    {
        if(const auto specialized = SpecializedOption(protocol, key, value)) ApplyOption(session.get(), specialized->first, specialized->second);
        else ApplyOption(session.get(), key, value);
    }
    Check(session.get(), sr_session_commit_settings(session.get()), "commit settings");
    if(observer && !structured_text_without_legacy)
        sr_session_enable_incremental_results(session.get());
    if(observer)
    {
        std::lock_guard lock(observer->mutex);
        observer->session = session.get();
    }
    const auto analyzer_started = Clock::now();
    Check(session.get(), sr_session_run(session.get()), "run analyzer");
    TraceTiming(
        "analyzer_run",
        analyzer_started,
        "protocol=" + protocol + " samples=" + input.at("sample_count").dump());
    if(observer && structured_text_without_legacy)
    {
        std::lock_guard lock(observer->mutex);
        observer->progress_sample = input.at("sample_count").get<std::uint64_t>();
        observer->finalizing = true;
        const auto frame_count = sr_session_frame_count(session.get());
        const auto begin_frame = std::min(observer->emitted_structured_frames, frame_count);
        const auto delta_started = Clock::now();
        auto output = IncrementalStructuredOutput(
            session.get(),
            input,
            decoder,
            begin_frame,
            frame_count);
        TraceTiming(
            "final_incremental_result_conversion",
            delta_started,
            "protocol=" + protocol + " frames=" + std::to_string(frame_count - begin_frame));
        return {
            {"async_delta", true},
            {"output", std::move(output)},
            {"expected_frame_count", frame_count},
            {"markers", AsyncCompletionMarkers(
                session.get(),
                FramedBinaryTransportRequested(input))},
        };
    }
    if(observer)
    {
        std::lock_guard lock(observer->mutex);
        observer->progress_sample = input.at("sample_count").get<std::uint64_t>();
    }

    // HLA consumes the original FrameV2 contract, never display-normalized fields.
    if(input.value("raw_frames", false))
    {
        json raw = json::array();
        const auto count = sr_session_frame_count(session.get());
        for(size_t index = 0; index < count; ++index)
        {
            sr_frame_view frame{};
            Check(session.get(), sr_session_frame(session.get(), index, &frame), "read raw frame");
            json data = json::object();
            for(size_t field_index = 0; field_index < frame.field_count; ++field_index)
            {
                sr_field_view field{};
                Check(session.get(), sr_session_frame_field(session.get(), index, field_index, &field), "read raw field");
                data[field.key ? field.key : "value"] = field.kind == SR_FIELD_DOUBLE
                    ? json{{"Float", field.double_value}} : FieldValue(field);
            }
            raw.push_back({{"type", frame.type ? frame.type : ""},
                {"start_sample", frame.start_sample}, {"end_sample", frame.end_sample}, {"data", std::move(data)}});
        }
        return {{"format", "sigpilot.hla.raw.v1"}, {"frames", std::move(raw)}};
    }

    const auto output_started = Clock::now();
    const bool binary_response = response_format == ResponseFormat::BinaryV1;
    json frames = json::array();
    BinaryPayloadBuilder binary_frames;
    const auto structured_count = sr_session_frame_count(session.get());
    const auto legacy_count = sr_session_legacy_frame_count(session.get());
    incremental_legacy_count = sr_session_incremental_legacy_frame_count(session.get());
    if(!binary_response)
        frames.get_ref<json::array_t&>().reserve(structured_count ? structured_count : legacy_count);
    else
        binary_frames.frames.reserve((structured_count ? structured_count : legacy_count) * 24);
    bubble_text_cache.reserve(BubbleTextCacheReserve(structured_count, legacy_count, configured_channel_count));
    if(structured_count)
    {
        size_t legacy_cursor = 0;
        for(size_t index = 0; index < structured_count; ++index)
        {
            sr_frame_view frame{};
            if(sr_session_frame(session.get(), index, &frame) != 0) continue;
            json fields = json::array();
            if(include_fields) fields.get_ref<json::array_t&>().reserve(frame.field_count);
            std::vector<std::string> texts;
            std::vector<ChannelValueOutput> channel_values;
            channel_values.reserve(frame.field_count);
            const std::string row = frame.type ? frame.type : sr_session_analyzer_name(session.get());
            std::optional<size_t> legacy_match;
            if(!structured_text_without_legacy)
                legacy_match = MatchingLegacyFrame(session.get(), frame, legacy_count, legacy_cursor);
            if(legacy_match && !structured_text_without_legacy)
                texts = bubble_text(*legacy_match, primary_channel);
            std::optional<unsigned long long> i2c_address;
            std::optional<unsigned long long> i2c_data;
            std::optional<bool> i2c_read;
            std::optional<bool> i2c_ack;
            bool i2c_missing_ack = false;
            for(size_t field_index = 0; field_index < frame.field_count; ++field_index)
            {
                sr_field_view field{};
                if(sr_session_frame_field(session.get(), index, field_index, &field) != 0) continue;
                if(include_fields) fields.push_back(FieldValueJson(field, compact));
                const std::string field_key = field.key ? field.key : "value";
                const auto field_key_lower = Lower(field_key);
                std::optional<std::string> field_text;
                const auto get_field_text = [&]() -> const std::string& {
                    if(!field_text) field_text = FieldText(field);
                    return *field_text;
                };
                if(texts.empty() && !structured_text_without_legacy)
                {
                    const auto& text = get_field_text();
                    if(!text.empty()) texts.push_back(text);
                }
                const auto numeric = NumericField(field);
                if(protocol_lower == "i2c")
                {
                    if(field_key_lower == "address" && numeric) i2c_address = *numeric;
                    else if(field_key_lower == "data" && numeric) i2c_data = *numeric;
                    else if(field_key_lower == "read" && numeric) i2c_read = *numeric != 0;
                    else if(field_key_lower == "ack" && numeric) i2c_ack = *numeric != 0;
                    else if(field_key_lower == "error" && Lower(get_field_text()).find("ack") != std::string::npos)
                        i2c_missing_ack = true;
                }
                if(numeric && ExposeField(protocol_lower, row, field_key_lower))
                {
                    const auto role = RoleForField(protocol_lower, field_key_lower);
                    const auto channel = ChannelForField(
                        protocol_lower,
                        field_key_lower,
                        configured_channels,
                        primary_channel);
                    const auto label = HexByte(*numeric);
                    channel_values.push_back(ChannelValueOutput{
                        channel,
                        role,
                        label,
                        structured_text_without_legacy && protocol_lower == "spi"
                            ? std::vector<std::string>{label}
                            : std::vector<std::string>{},
                        *numeric,
                    });
                    if(protocol_lower == "spi") texts.push_back(label);
                }
            }
            if(texts.empty()) texts.push_back(frame.type ? frame.type : sr_session_analyzer_name(session.get()));
            if(const auto label = I2cDisplayLabel(row, texts, i2c_address, i2c_read, i2c_data, i2c_ack, i2c_missing_ack))
            {
                texts = {*label};
                if(structured_text_without_legacy)
                {
                    for(auto& value : channel_values)
                    {
                        value.label = *label;
                        value.texts = {*label};
                    }
                }
            }
            if(protocol_lower == "lin" && channel_values.empty())
            {
                const unsigned long long value = row == "header_sync" ? 0x55 : 0;
                channel_values.push_back(ChannelValueOutput{primary_channel, "LIN", row, {}, value});
            }
            if(protocol_lower == "swd" && legacy_match && !channel_values.empty())
            {
                const auto value = channel_values.front().value;
                std::vector<ChannelValueOutput> swd_values;
                for(const auto& [role, configured_channel] : decoder.at("channels").items())
                {
                    if(configured_channel.is_null()) continue;
                    const auto channel = configured_channel.get<unsigned>();
                    const auto& candidates = bubble_text(*legacy_match, channel);
                    swd_values.push_back(ChannelValueOutput{
                        channel,
                        role,
                        candidates.empty() ? row : candidates.back(),
                        candidates,
                        value,
                    });
                }
                channel_values = std::move(swd_values);
            }
            if(legacy_match && !structured_text_without_legacy)
            {
                for(auto& value : channel_values)
                {
                    const auto& candidates = bubble_text(*legacy_match, value.channel);
                    value.texts = candidates.empty()
                        ? std::vector<std::string>{value.label}
                        : candidates;
                }
            }
            if(binary_response)
                binary_frames.AddFrame(&role_dictionary, &string_dictionary, index, frame.start_sample, frame.end_sample,
                                       row, texts, channel_values);
            else
                frames.push_back(FrameJson(response_format, &role_dictionary, &string_dictionary, index, frame.start_sample, frame.end_sample,
                                           row, texts, std::move(fields), channel_values, json::array()));
        }
    }
    else
    {
        for(size_t index = 0; index < legacy_count; ++index)
        {
            sr_legacy_frame_view frame{};
            if(sr_session_legacy_frame(session.get(), index, &frame) != 0) continue;
            auto texts = bubble_text(index, primary_channel);
            std::ostringstream label;
            label << "0x" << std::hex << frame.data1;
            if(texts.empty()) texts.push_back(label.str());
            std::vector<ChannelValueOutput> legacy_channel_values;
            legacy_channel_values.reserve(protocol_lower == "swd" ? decoder.at("channels").size() : 1);
            if(protocol_lower == "swd")
            {
                for(const auto& [role, configured_channel] : decoder.at("channels").items())
                {
                    if(configured_channel.is_null()) continue;
                    const auto channel = configured_channel.get<unsigned>();
                    const auto& candidates = bubble_text(index, channel);
                    legacy_channel_values.push_back(ChannelValueOutput{
                        channel,
                        role,
                        candidates.empty() ? label.str() : candidates.back(),
                        candidates.empty() ? std::vector<std::string>{label.str()} : candidates,
                        frame.data1,
                    });
                }
            }
            else
            {
                legacy_channel_values.push_back(ChannelValueOutput{
                    primary_channel,
                    "Data",
                    label.str(),
                    texts,
                    frame.data1,
                });
            }
            const auto row = "frame_" + std::to_string(frame.type);
            json fields = json::array();
            if(include_fields)
            {
                fields = compact
                    ? json::array({
                        json::array({"data1", "u", frame.data1}),
                        json::array({"data2", "u", frame.data2}),
                        json::array({"flags", "u", frame.flags}),
                      })
                    : json::array({
                        {{"name", "data1"}, {"value", json{{"Unsigned", frame.data1}}}},
                        {{"name", "data2"}, {"value", json{{"Unsigned", frame.data2}}}},
                        {{"name", "flags"}, {"value", json{{"Unsigned", frame.flags}}}},
                      });
            }
            if(binary_response)
                binary_frames.AddFrame(
                    &role_dictionary,
                    &string_dictionary,
                    index,
                    std::max<long long>(frame.start_sample, 0),
                    std::max<long long>(frame.end_sample, 0),
                    row,
                    texts,
                    legacy_channel_values);
            else
                frames.push_back(FrameJson(
                    response_format,
                    &role_dictionary,
                    &string_dictionary,
                    index,
                    std::max<long long>(frame.start_sample, 0),
                    std::max<long long>(frame.end_sample, 0),
                    row,
                    texts,
                    std::move(fields),
                    legacy_channel_values,
                    json::array()));
        }
    }
    const auto markers = Markers(session.get(), response_format, &string_dictionary);
    if(binary_response)
    {
        auto output = OutputBinaryJson(
            sr_session_analyzer_name(session.get()),
            role_dictionary,
            string_dictionary,
            binary_frames,
            std::move(markers),
            FramedBinaryTransportRequested(input));
        TraceTiming(
            "result_conversion",
            output_started,
            "protocol=" + protocol + " frames=" + std::to_string(binary_frames.frame_count));
        return output;
    }
    if(!frames.empty())
    {
        if(response_format == ResponseFormat::CompactV1)
            frames.front()[7] = markers;
        else if(response_format == ResponseFormat::Standard)
            frames.front()["markers"] = markers;
    }
    const auto frame_count = frames.size();
    auto output = OutputJson(response_format, sr_session_analyzer_name(session.get()), role_dictionary, string_dictionary, std::move(frames), std::move(markers));
    TraceTiming(
        "result_conversion",
        output_started,
        "protocol=" + protocol + " frames=" + std::to_string(frame_count));
    return output;
}

json Decode(const fs::path& root, const std::vector<fs::path>& plugins, const json& input)
{
    const auto edges = ParseEdges(input);
    return DecodeWithEdges(root, plugins, input, input.at("decoder"), edges);
}

json DecodeBatch(const fs::path& root, const std::vector<fs::path>& plugins, const json& input)
{
    const auto started = Clock::now();
    const auto edges = ParseEdges(input);
    const auto& decoders = input.at("decoders");
    const auto worker_count = SaleaeBatchWorkerCount(decoders.size());
    if(worker_count > 1)
    {
        std::vector<json> decoder_requests;
        decoder_requests.reserve(decoders.size());
        for(const auto& decoder : decoders)
            decoder_requests.push_back(decoder);

        const auto chunk_size = (decoder_requests.size() + worker_count - 1) / worker_count;
        std::vector<std::future<std::vector<std::pair<size_t, json>>>> futures;
        futures.reserve(worker_count);
        for(size_t chunk_begin = 0; chunk_begin < decoder_requests.size(); chunk_begin += chunk_size)
        {
            const auto chunk_end = std::min(chunk_begin + chunk_size, decoder_requests.size());
            futures.push_back(std::async(std::launch::async, [&, chunk_begin, chunk_end]() {
                std::vector<std::pair<size_t, json>> outputs;
                outputs.reserve(chunk_end - chunk_begin);
                for(size_t index = chunk_begin; index < chunk_end; ++index)
                    outputs.emplace_back(index, DecodeWithEdges(root, plugins, input, decoder_requests[index], edges));
                return outputs;
            }));
        }

        std::vector<json> ordered_outputs(decoders.size());
        size_t frame_count = 0;
        for(auto& future : futures)
        {
            for(auto& [index, output] : future.get())
            {
                frame_count += OutputFrameCount(output);
                ordered_outputs[index] = std::move(output);
            }
        }
        json outputs = json::array();
        outputs.get_ref<json::array_t&>().reserve(ordered_outputs.size());
        for(auto& output : ordered_outputs)
            outputs.push_back(std::move(output));
        TraceTiming("batch_decode_total", started,
                    "decoders=" + std::to_string(decoders.size()) +
                    " workers=" + std::to_string(worker_count) +
                    " frames=" + std::to_string(frame_count));
        return json{{"format", "pxlogic.decoder.batch.v1"}, {"outputs", std::move(outputs)}};
    }

    json outputs = json::array();
    outputs.get_ref<json::array_t&>().reserve(decoders.size());
    size_t frame_count = 0;
    for(const auto& decoder : decoders)
    {
        auto output = DecodeWithEdges(root, plugins, input, decoder, edges);
        frame_count += OutputFrameCount(output);
        outputs.push_back(std::move(output));
    }
    TraceTiming("batch_decode_total", started,
                "decoders=" + std::to_string(decoders.size()) +
                " workers=1 frames=" + std::to_string(frame_count));
    return json{{"format", "pxlogic.decoder.batch.v1"}, {"outputs", std::move(outputs)}};
}

json DecodeWindowBatch(const fs::path& root, const std::vector<fs::path>& plugins, const json& input)
{
    const auto started = Clock::now();
    const auto& windows = input.at("windows");
    std::vector<json> window_requests;
    window_requests.reserve(windows.size());
    for(const auto& window : windows)
    {
        auto request = window;
        if(input.contains("response_transport"))
            request["response_transport"] = input.at("response_transport");
        if(input.contains("_request_binary"))
            request["_request_binary"] = input.at("_request_binary");
        window_requests.push_back(std::move(request));
    }
    const auto worker_count = SaleaeWindowBatchWorkerCount(windows.size());
    if(worker_count > 1)
    {
        const auto chunk_size = (window_requests.size() + worker_count - 1) / worker_count;
        std::vector<std::future<std::vector<std::pair<size_t, json>>>> futures;
        futures.reserve(worker_count);
        for(size_t chunk_begin = 0; chunk_begin < window_requests.size(); chunk_begin += chunk_size)
        {
            const auto chunk_end = std::min(chunk_begin + chunk_size, window_requests.size());
            futures.push_back(std::async(std::launch::async, [&, chunk_begin, chunk_end]() {
                std::vector<std::pair<size_t, json>> outputs;
                outputs.reserve(chunk_end - chunk_begin);
                for(size_t index = chunk_begin; index < chunk_end; ++index)
                    outputs.emplace_back(index, DecodeBatch(root, plugins, window_requests[index]));
                return outputs;
            }));
        }

        std::vector<json> ordered_outputs(windows.size());
        size_t frame_count = 0;
        for(auto& future : futures)
        {
            for(auto& [index, output] : future.get())
            {
                frame_count += OutputFrameCount(output);
                ordered_outputs[index] = std::move(output);
            }
        }
        json outputs = json::array();
        outputs.get_ref<json::array_t&>().reserve(ordered_outputs.size());
        for(auto& output : ordered_outputs)
            outputs.push_back(std::move(output));
        TraceTiming("window_batch_decode_total", started,
                    "windows=" + std::to_string(windows.size()) +
                    " workers=" + std::to_string(worker_count) +
                    " frames=" + std::to_string(frame_count));
        return json{{"format", "pxlogic.decoder.window_batch.v1"}, {"outputs", std::move(outputs)}};
    }

    json outputs = json::array();
    outputs.get_ref<json::array_t&>().reserve(windows.size());
    size_t frame_count = 0;
    for(const auto& window : window_requests)
    {
        auto output = DecodeBatch(root, plugins, window);
        frame_count += OutputFrameCount(output);
        outputs.push_back(std::move(output));
    }
    TraceTiming("window_batch_decode_total", started,
                "windows=" + std::to_string(windows.size()) +
                " workers=1 frames=" + std::to_string(frame_count));
    return json{{"format", "pxlogic.decoder.window_batch.v1"}, {"outputs", std::move(outputs)}};
}

json DecodeRequest(const fs::path& root, const std::vector<fs::path>& plugins, const json& input)
{
    if(input.contains("windows"))
        return DecodeWindowBatch(root, plugins, input);
    if(input.contains("decoders"))
        return DecodeBatch(root, plugins, input);
    return Decode(root, plugins, input);
}

json Decode(const fs::path& root, const json& input)
{
    return DecodeRequest(root, Plugins(root), input);
}

std::uint64_t AsyncDecodeProgress(AsyncDecodeJob& job)
{
    std::lock_guard lock(job.observer->mutex);
    if(job.observer->session)
        job.observer->progress_sample = std::max(
            job.observer->progress_sample,
            std::min(job.sample_count, sr_session_progress_sample(job.observer->session)));
    return job.observer->progress_sample;
}

void ReapCancelledAsyncJobs(
    std::unordered_map<std::string, std::unique_ptr<AsyncDecodeJob>>& jobs)
{
    for(auto job = jobs.begin(); job != jobs.end();)
    {
        if(!job->second->cancel_requested ||
           job->second->result.wait_for(std::chrono::milliseconds(0)) != std::future_status::ready)
        {
            ++job;
            continue;
        }
        try
        {
            (void)job->second->result.get();
        }
        catch(...)
        {
        }
        job = jobs.erase(job);
    }
}

json HandleAsyncDecode(
    const fs::path& root,
    const std::vector<fs::path>& plugins,
    const json& input,
    std::unordered_map<std::string, std::unique_ptr<AsyncDecodeJob>>& jobs)
{
    ReapCancelledAsyncJobs(jobs);
    const auto id = input.at("async_decode_id").get<std::string>();
    if(id.empty())
        throw std::runtime_error("async decode id is empty");
    const auto action = input.value("async_action", std::string("poll"));
    auto found = jobs.find(id);

    if(action == "start" && found == jobs.end())
    {
        if(!input.contains("decoder"))
            throw std::runtime_error("async decode start request is missing decoder settings");
        auto job = std::make_unique<AsyncDecodeJob>();
        job->sample_count = input.at("sample_count").get<std::uint64_t>();
        job->partial_request = json{
            {"decoder", input.at("decoder")},
            {"response_format", input.value("response_format", std::string())},
            {"response_transport", input.value("response_transport", std::string())},
            {"include_fields", input.value("include_fields", true)},
        };
        const auto observer = job->observer;
        const auto request = input;
        job->result = std::async(std::launch::async, [root, plugins, observer, request]() {
            const auto edges = ParseEdges(request);
            return DecodeWithEdges(
                root,
                plugins,
                request,
                request.at("decoder"),
                edges,
                observer.get());
        });
        found = jobs.emplace(id, std::move(job)).first;
    }

    if(found == jobs.end())
        throw std::runtime_error("async decode job was not found");

    auto& job = *found->second;
    if(action == "cancel")
    {
        job.cancel_requested = true;
        std::lock_guard lock(job.observer->mutex);
        if(job.observer->session)
            sr_session_cancel(job.observer->session);
    }
    else if(action != "start" && action != "poll")
    {
        throw std::runtime_error("unsupported async decode action '" + action + "'");
    }

    if(job.result.wait_for(std::chrono::milliseconds(0)) == std::future_status::ready)
    {
        try
        {
            auto output = job.result.get();
            const auto sample_count = job.sample_count;
            const auto cancelled = job.cancel_requested;
            jobs.erase(found);
            if(cancelled)
                return json{{"ok", true}, {"pending", false}, {"cancelled", true},
                            {"progress_sample", sample_count}};
            json response{{"ok", true}, {"pending", false}, {"cancelled", false},
                          {"progress_sample", sample_count}};
            if(output.value("async_delta", false))
            {
                response["output"] = std::move(output.at("output"));
                response["finalization"] = {
                    {"expected_frame_count", output.at("expected_frame_count")},
                    {"markers", std::move(output.at("markers"))},
                };
            }
            else
            {
                response["output"] = std::move(output);
            }
            return response;
        }
        catch(const std::exception& error)
        {
            const auto cancelled = job.cancel_requested;
            jobs.erase(found);
            if(cancelled)
                return json{{"ok", true}, {"pending", false}, {"cancelled", true},
                            {"progress_sample", 0}};
            throw std::runtime_error("async decode failed: " + std::string(error.what()));
        }
    }

    std::optional<json> partial_output;
    if(SupportsIncrementalStructuredOutput(job.partial_request.at("decoder")))
    {
        std::lock_guard lock(job.observer->mutex);
        if(job.observer->session && !job.observer->finalizing)
        {
            const auto frame_count = sr_session_frame_count(job.observer->session);
            if(frame_count > job.emitted_structured_frames)
            {
                const auto partial_started = Clock::now();
                const auto begin_frame = job.emitted_structured_frames;
                partial_output = IncrementalStructuredOutput(
                    job.observer->session,
                    job.partial_request,
                    job.partial_request.at("decoder"),
                    job.emitted_structured_frames,
                    frame_count);
                job.emitted_structured_frames = frame_count;
                job.observer->emitted_structured_frames = frame_count;
                TraceTiming(
                    "incremental_result_conversion",
                    partial_started,
                    "frames=" + std::to_string(frame_count - begin_frame));
            }
        }
    }
    else
    {
        std::lock_guard lock(job.observer->mutex);
        if(job.observer->session && !job.observer->finalizing)
        {
            const auto frame_count = sr_session_incremental_legacy_frame_count(
                job.observer->session);
            if(frame_count > job.emitted_legacy_frames)
            {
                const auto partial_started = Clock::now();
                const auto begin_frame = job.emitted_legacy_frames;
                partial_output = IncrementalLegacyOutput(
                    job.observer->session,
                    job.partial_request,
                    job.partial_request.at("decoder"),
                    job.emitted_legacy_frames,
                    frame_count);
                job.emitted_legacy_frames = frame_count;
                TraceTiming(
                    "incremental_legacy_result_conversion",
                    partial_started,
                    "frames=" + std::to_string(frame_count - begin_frame));
            }
        }
    }
    json response{{"ok", true}, {"pending", true}, {"cancelled", job.cancel_requested},
                  {"progress_sample", AsyncDecodeProgress(job)}};
    if(partial_output)
        response["output"] = std::move(*partial_output);
    return response;
}

json Simulate(const fs::path& root, const json& input)
{
    const auto& decoder = input.at("decoder");
    const auto protocol = decoder.at("protocol").get<std::string>();
    auto session = Open(FindPlugin(root, protocol));
    const auto sample_rate = input.at("sample_rate_hz").get<unsigned>();
    for(const auto& [key, value] : decoder.at("channels").items())
    {
        if(value.is_null()) continue;
        const auto title = SpecializedChannelTitle(protocol, key);
        Check(session.get(), sr_session_add_channel(session.get(), title.c_str(), value.get<unsigned>(),
              0, nullptr, 0), "set channel " + title);
    }
    for(const auto& [key, value] : decoder.at("options").items())
    {
        if(const auto specialized = SpecializedOption(protocol, key, value)) ApplyOption(session.get(), specialized->first, specialized->second);
        else ApplyOption(session.get(), key, value);
    }
    Check(session.get(), sr_session_set_sample_rate(session.get(), sample_rate), "set sample rate");
    Check(session.get(), sr_session_commit_settings(session.get()), "commit settings");
    Check(session.get(), sr_session_generate_simulation(
        session.get(), input.at("sample_count").get<unsigned long long>(), sample_rate), "generate simulation");
    json channels = json::array();
    for(size_t index = 0; index < sr_session_simulation_channel_count(session.get()); ++index)
    {
        sr_simulation_channel_view channel{};
        if(sr_session_simulation_channel(session.get(), index, &channel) != 0) continue;
        if(channel.channel_index > 255) continue;
        channels.push_back({{"channel", channel.channel_index}, {"initial_high", channel.initial_high != 0},
                            {"sample_count", channel.sample_count},
                            {"transitions", std::vector<std::uint64_t>(
                                channel.transition_samples, channel.transition_samples + channel.transition_count)}});
    }
    return {{"protocol", sr_session_analyzer_name(session.get())}, {"channels", channels}};
}

void Serve(const fs::path& root)
{
    const auto plugins = Plugins(root);
    const auto probe = Probe(root, false);
    std::unordered_map<std::string, std::unique_ptr<AsyncDecodeJob>> async_jobs;
    std::cout << json{{"ok", true}, {"ready", true},
                      {"analyzer_name", probe.value("analyzer_name", "")},
                      {"protocols", probe.value("protocols", json::array())},
                      {"transports", json::array({"framed_binary_v1"})}}
                     .dump()
              << '\n'
              << std::flush;

    while(true)
    {
        bool framed_binary_transport = false;
        try
        {
            const auto parse_started = Clock::now();
            json input;
            size_t request_bytes = 0;
            if(!ReadServeRequest(input, request_bytes))
                break;
            if(input.is_null())
                continue;
            framed_binary_transport = FramedBinaryTransportRequested(input);
            TraceTiming("request_json_parse", parse_started,
                        "request_bytes=" + std::to_string(request_bytes));

            const auto decode_started = Clock::now();
            json response_json;
            if(input.contains("async_decode_id"))
            {
                response_json = HandleAsyncDecode(root, plugins, input, async_jobs);
                TraceTiming("async_decode_step", decode_started,
                            "pending=" + std::string(response_json.value("pending", false) ? "true" : "false") +
                            " progress_sample=" + std::to_string(response_json.value("progress_sample", 0ULL)));
            }
            else
            {
                auto output = DecodeRequest(root, plugins, input);
                TraceTiming("decode", decode_started,
                            "frames=" + std::to_string(OutputFrameCount(output)));
                response_json = json{{"ok", true}, {"output", std::move(output)}};
            }

            const auto dump_started = Clock::now();
            if(framed_binary_transport)
            {
                WriteFramedResponse(std::move(response_json));
                TraceTiming("response_framed_write", dump_started,
                            "binary_transport=true");
                continue;
            }
            const auto response = response_json.dump();
            TraceTiming("response_json_dump", dump_started,
                        "response_bytes=" + std::to_string(response.size()));

            std::cout << response << '\n' << std::flush;
        }
        catch(const std::exception& error)
        {
            auto response = json{{"ok", false}, {"error", error.what()}};
            if(framed_binary_transport)
                WriteFramedResponse(std::move(response));
            else
                std::cout << response.dump() << '\n' << std::flush;
        }
    }
}

} // namespace

int main(int argc, char** argv)
{
    UseBinaryStandardStreams();
    try
    {
        fs::path runtime_root;
        bool probe = false;
        bool catalog = false;
        bool decode = false;
        bool simulate = false;
        bool serve = false;
        for(int index = 1; index < argc; ++index)
        {
            const std::string argument = argv[index];
            if(argument == "--runtime-root" && index + 1 < argc) runtime_root = argv[++index];
            else if(argument == "--probe") probe = true;
            else if(argument == "--catalog") catalog = true;
            else if(argument == "--decode") decode = true;
            else if(argument == "--simulate") simulate = true;
            else if(argument == "--serve") serve = true;
        }
        if(runtime_root.empty()) throw std::runtime_error("--runtime-root is required");
        if(probe) std::cout << Probe(runtime_root, catalog).dump() << '\n';
        else if(decode) { json input; std::cin >> input; std::cout << Decode(runtime_root, input).dump() << '\n'; }
        else if(simulate) { json input; std::cin >> input; std::cout << Simulate(runtime_root, input).dump() << '\n'; }
        else if(serve) Serve(runtime_root);
        else throw std::runtime_error("choose --probe, --decode, --simulate, or --serve");
        return 0;
    }
    catch(const std::exception& error)
    {
        std::cerr << error.what() << '\n';
        return 1;
    }
}
