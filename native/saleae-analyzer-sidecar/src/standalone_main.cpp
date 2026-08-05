#include <saleae_compat.h>
#include <nlohmann/json.hpp>

#include <algorithm>
#include <cctype>
#include <cstdint>
#include <filesystem>
#include <fstream>
#include <iostream>
#include <limits>
#include <map>
#include <memory>
#include <optional>
#include <sstream>
#include <stdexcept>
#include <string>
#include <vector>

using json = nlohmann::json;
namespace fs = std::filesystem;

namespace
{

struct SessionDeleter
{
    void operator()(sr_session* session) const { sr_session_destroy(session); }
};
using Session = std::unique_ptr<sr_session, SessionDeleter>;

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
        auto session = Open(plugin);
        names.push_back(sr_session_analyzer_name(session.get()));
        protocols.push_back(sr_session_analyzer_name(session.get()));
        if(include_catalog)
            catalog.push_back(CatalogItem(plugin));
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
    const auto decode_base64 = [](const std::string& encoded) {
        const auto value = [](unsigned char character) -> int {
            if(character >= 'A' && character <= 'Z') return character - 'A';
            if(character >= 'a' && character <= 'z') return character - 'a' + 26;
            if(character >= '0' && character <= '9') return character - '0' + 52;
            if(character == '+') return 62;
            if(character == '/') return 63;
            return -1;
        };
        std::vector<std::uint8_t> bytes;
        bytes.reserve(encoded.size() * 3 / 4);
        std::uint32_t accumulator = 0;
        unsigned bits = 0;
        for(const unsigned char character : encoded)
        {
            if(character == '=') break;
            const int digit = value(character);
            if(digit < 0) throw std::runtime_error("invalid base64 edge payload");
            accumulator = (accumulator << 6) | static_cast<unsigned>(digit);
            bits += 6;
            if(bits >= 8)
            {
                bits -= 8;
                bytes.push_back(static_cast<std::uint8_t>((accumulator >> bits) & 0xff));
            }
        }
        return bytes;
    };
    const auto decode_deltas = [&](const std::string& encoded) {
        const auto bytes = decode_base64(encoded);
        std::vector<std::uint64_t> samples;
        samples.reserve(bytes.size());
        std::uint64_t sample = 0;
        std::uint64_t delta = 0;
        unsigned shift = 0;
        for(const auto byte : bytes)
        {
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

    std::map<unsigned, std::vector<std::uint64_t>> edges;
    for(const auto& edge_set : input.at("edges"))
    {
        const auto channel = edge_set.at("channel").get<unsigned>();
        if(edge_set.value("encoding", "") == "delta_varint_base64")
            edges[channel] = decode_deltas(edge_set.at("samples_b64").get<std::string>());
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

std::string RoleForField(const std::string& protocol, const std::string& key)
{
    const auto id = Lower(protocol);
    const auto field = Lower(key);
    if(id == "spi") return field == "mosi" ? "MOSI" : field == "miso" ? "MISO" : "Data";
    if(id == "can")
    {
        if(field == "identifier") return "Identifier";
        if(field == "num_data_bytes") return "DLC";
        if(field == "crc") return "CRC";
        if(field == "ack") return "ACK";
        if(field == "data") return "Data";
    }
    if(id == "lin") return "LIN";
    return "Data";
}

unsigned ChannelForField(
    const std::string& protocol,
    const std::string& key,
    const json& channels,
    unsigned primary_channel)
{
    const auto configured = [&](const char* name) -> std::optional<unsigned> {
        for(const auto& [key, value] : channels.items())
            if(Lower(key) == Lower(name) && !value.is_null()) return value.get<unsigned>();
        return std::nullopt;
    };
    const auto id = Lower(protocol);
    const auto field = Lower(key);
    if(id == "spi")
    {
        if(field == "mosi") return configured("mosi").value_or(primary_channel);
        if(field == "miso") return configured("miso").value_or(primary_channel);
    }
    if(id == "i2c") return configured("sda").value_or(primary_channel);
    if(id == "uart" || id == "serial" || id == "async_serial")
        return configured("rx").value_or(primary_channel);
    if(id == "i2s" || id == "i2s_pcm")
    {
        if(const auto channel = configured("sd")) return *channel;
        return configured("data").value_or(primary_channel);
    }
    if(id == "can")
    {
        if(const auto channel = configured("can_rx")) return *channel;
        return configured("can").value_or(primary_channel);
    }
    if(id == "lin")
    {
        if(const auto channel = configured("rx")) return *channel;
        return configured("serial").value_or(primary_channel);
    }
    return primary_channel;
}

bool ExposeField(const std::string& protocol, const std::string& row, const std::string& key)
{
    const auto id = Lower(protocol);
    const auto field = Lower(key);
    if(id == "uart" || id == "serial" || id == "async_serial") return field == "data";
    if(id == "i2c") return field == "address" || field == "data";
    if(id == "spi") return field == "mosi" || field == "miso";
    if(id == "i2s" || id == "i2s_pcm") return field == "data";
    if(id == "can") return field == "identifier" || field == "num_data_bytes" || field == "data" || field == "crc" || field == "ack";
    if(id == "lin")
    {
        if(row == "data_or_checksum") return field == "checksum";
        return field == "protected_id" || field == "data" || field == "checksum";
    }
    return true;
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

std::optional<size_t> MatchingLegacyFrame(
    sr_session* session,
    const sr_frame_view& frame,
    size_t& cursor)
{
    const auto count = sr_session_legacy_frame_count(session);
    while(cursor < count)
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

json Markers(sr_session* session)
{
    json markers = json::array();
    for(size_t index = 0; index < sr_session_marker_count(session); ++index)
    {
        sr_marker_view marker{};
        if(sr_session_marker(session, index, &marker) == 0)
        {
            if(marker.channel_index > 255) continue;
            markers.push_back({{"row", "marker"}, {"channel", marker.channel_index},
                               {"sample", marker.sample}, {"kind", MarkerKind(marker.kind)}});
        }
    }
    return markers;
}

json Decode(const fs::path& root, const json& input)
{
    const auto& decoder = input.at("decoder");
    const auto protocol = decoder.at("protocol").get<std::string>();
    auto session = Open(FindPlugin(root, protocol));
    Check(session.get(), sr_session_set_sample_rate(session.get(), input.at("sample_rate_hz").get<unsigned long long>()), "set sample rate");

    const auto initial_levels = input.at("initial_levels").get<std::vector<unsigned char>>();
    const auto edges = ParseEdges(input);
    unsigned primary_channel = decoder.value("primary_channel", 0u);
    for(const auto& [key, value] : decoder.at("channels").items())
    {
        if(value.is_null()) continue;
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
    Check(session.get(), sr_session_run(session.get()), "run analyzer");

    json frames = json::array();
    const auto structured_count = sr_session_frame_count(session.get());
    if(structured_count)
    {
        size_t legacy_cursor = 0;
        for(size_t index = 0; index < structured_count; ++index)
        {
            sr_frame_view frame{};
            if(sr_session_frame(session.get(), index, &frame) != 0) continue;
            json fields = json::array();
            std::vector<std::string> texts;
            json channel_values = json::array();
            const std::string row = frame.type ? frame.type : sr_session_analyzer_name(session.get());
            const auto legacy_match = MatchingLegacyFrame(session.get(), frame, legacy_cursor);
            if(legacy_match)
                texts = BubbleText(session.get(), *legacy_match, primary_channel);
            for(size_t field_index = 0; field_index < frame.field_count; ++field_index)
            {
                sr_field_view field{};
                if(sr_session_frame_field(session.get(), index, field_index, &field) != 0) continue;
                fields.push_back({{"name", field.key ? field.key : "value"}, {"value", FieldValue(field)}});
                const auto text = FieldText(field);
                if(texts.empty() && !text.empty()) texts.push_back(text);
                if(const auto numeric = NumericField(field); numeric && ExposeField(protocol, row, field.key ? field.key : "value"))
                {
                    const auto role = RoleForField(protocol, field.key ? field.key : "value");
                    const auto channel = ChannelForField(
                        protocol,
                        field.key ? field.key : "value",
                        decoder.at("channels"),
                        primary_channel);
                    std::ostringstream label;
                    label << "0x" << std::uppercase << std::hex << *numeric;
                    channel_values.push_back({{"channel", channel}, {"role", role},
                                              {"label", label.str()}, {"value", *numeric}});
                    if(Lower(protocol) == "spi") texts.push_back(label.str());
                }
            }
            if(texts.empty()) texts.push_back(frame.type ? frame.type : sr_session_analyzer_name(session.get()));
            if(Lower(protocol) == "lin" && channel_values.empty())
            {
                const unsigned long long value = row == "header_sync" ? 0x55 : 0;
                channel_values.push_back({{"channel", primary_channel}, {"role", "LIN"},
                                          {"label", row}, {"value", value}});
            }
            if(Lower(protocol) == "swd" && legacy_match && !channel_values.empty())
            {
                const auto value = channel_values.front().at("value");
                json swd_values = json::array();
                for(const auto& [role, configured_channel] : decoder.at("channels").items())
                {
                    if(configured_channel.is_null()) continue;
                    const auto channel = configured_channel.get<unsigned>();
                    const auto candidates = BubbleText(session.get(), *legacy_match, channel);
                    swd_values.push_back({{"channel", channel}, {"role", role},
                                          {"label", candidates.empty() ? row : candidates.back()},
                                          {"texts", candidates}, {"value", value}});
                }
                channel_values = std::move(swd_values);
            }
            if(legacy_match)
            {
                for(auto& value : channel_values)
                {
                    const auto candidates = BubbleText(
                        session.get(), *legacy_match, value.at("channel").get<unsigned>());
                    value["texts"] = candidates.empty()
                        ? json::array({value.at("label")})
                        : json(candidates);
                }
            }
            frames.push_back({{"frame_id", index}, {"start_sample", frame.start_sample}, {"end_sample", frame.end_sample},
                              {"row", frame.type ? frame.type : sr_session_analyzer_name(session.get())}, {"texts", texts},
                              {"fields", fields}, {"channel_values", channel_values}, {"markers", json::array()}});
        }
    }
    else
    {
        const auto count = sr_session_legacy_frame_count(session.get());
        for(size_t index = 0; index < count; ++index)
        {
            sr_legacy_frame_view frame{};
            if(sr_session_legacy_frame(session.get(), index, &frame) != 0) continue;
            auto texts = BubbleText(session.get(), index, primary_channel);
            std::ostringstream label;
            label << "0x" << std::hex << frame.data1;
            if(texts.empty()) texts.push_back(label.str());
            json legacy_channel_values = json::array();
            if(Lower(protocol) == "swd")
            {
                for(const auto& [role, configured_channel] : decoder.at("channels").items())
                {
                    if(configured_channel.is_null()) continue;
                    const auto channel = configured_channel.get<unsigned>();
                    const auto candidates = BubbleText(session.get(), index, channel);
                    legacy_channel_values.push_back({{"channel", channel}, {"role", role},
                        {"label", candidates.empty() ? label.str() : candidates.back()},
                        {"texts", candidates.empty() ? json::array({label.str()}) : json(candidates)},
                        {"value", frame.data1}});
                }
            }
            else
            {
                legacy_channel_values.push_back({{"channel", primary_channel}, {"role", "Data"},
                    {"label", label.str()}, {"texts", texts}, {"value", frame.data1}});
            }
            frames.push_back({{"frame_id", index}, {"start_sample", std::max<long long>(frame.start_sample, 0)},
                              {"end_sample", std::max<long long>(frame.end_sample, 0)}, {"row", "frame_" + std::to_string(frame.type)},
                              {"texts", texts}, {"fields", json::array({
                                {{"name", "data1"}, {"value", json{{"Unsigned", frame.data1}}}},
                                {{"name", "data2"}, {"value", json{{"Unsigned", frame.data2}}}},
                                {{"name", "flags"}, {"value", json{{"Unsigned", frame.flags}}}}
                              })}, {"channel_values", legacy_channel_values}, {"markers", json::array()}});
        }
    }
    const auto markers = Markers(session.get());
    if(!frames.empty()) frames.front()["markers"] = markers;
    return {{"backend", "saleae_native"}, {"protocol", sr_session_analyzer_name(session.get())},
            {"frames", frames}, {"diagnostics", json::array({{{"level", "info"},
             {"message", "Saleae standalone sparse analyzer completed"}}})}};
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

} // namespace

int main(int argc, char** argv)
{
    try
    {
        fs::path runtime_root;
        bool probe = false;
        bool catalog = false;
        bool decode = false;
        bool simulate = false;
        for(int index = 1; index < argc; ++index)
        {
            const std::string argument = argv[index];
            if(argument == "--runtime-root" && index + 1 < argc) runtime_root = argv[++index];
            else if(argument == "--probe") probe = true;
            else if(argument == "--catalog") catalog = true;
            else if(argument == "--decode") decode = true;
            else if(argument == "--simulate") simulate = true;
        }
        if(runtime_root.empty()) throw std::runtime_error("--runtime-root is required");
        if(probe) std::cout << Probe(runtime_root, catalog).dump() << '\n';
        else if(decode) { json input; std::cin >> input; std::cout << Decode(runtime_root, input).dump() << '\n'; }
        else if(simulate) { json input; std::cin >> input; std::cout << Simulate(runtime_root, input).dump() << '\n'; }
        else throw std::runtime_error("choose --probe, --decode, or --simulate");
        return 0;
    }
    catch(const std::exception& error)
    {
        std::cerr << error.what() << '\n';
        return 1;
    }
}
