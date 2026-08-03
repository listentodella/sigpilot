#include <saleae_compat.h>
#include <nlohmann/json.hpp>

#include <algorithm>
#include <cctype>
#include <cstdint>
#include <filesystem>
#include <fstream>
#include <iostream>
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
            {"decoder_catalog", catalog}, {"c_decoder_count", plugins.size()}, {"python_decoder_count", 0}};
}

std::map<unsigned, std::vector<std::uint64_t>> ParseEdges(const json& input)
{
    std::map<unsigned, std::vector<std::uint64_t>> edges;
    for(const auto& edge_set : input.at("edges"))
        edges[edge_set.at("channel").get<unsigned>()] = edge_set.at("samples").get<std::vector<std::uint64_t>>();
    return edges;
}

std::string SpecializedChannelTitle(const std::string& protocol, const std::string& key)
{
    const auto id = Lower(protocol);
    if(id == "uart" || id == "serial" || id == "async_serial") return "Input Channel";
    if(id == "i2c") return key == "sda" ? "SDA" : "SCL";
    if(id == "spi") return key == "clk" ? "Clock" : key == "cs" ? "Enable" : key == "mosi" ? "MOSI" : "MISO";
    if(id == "i2s" || id == "i2s_pcm") return key == "sck" ? "CLOCK channel" : key == "ws" ? "FRAME" : "DATA";
    if(id == "can") return "CAN";
    if(id == "lin") return "Serial";
    if(id == "parallel" || id == "simple_parallel") return key == "clk" ? "Clock" : std::string("D") + key.substr(1);
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
        const auto found = channels.find(name);
        if(found == channels.end() || found->is_null()) return std::nullopt;
        return found->get<unsigned>();
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
    if(id == "i2s" || id == "i2s_pcm") return configured("sd").value_or(primary_channel);
    if(id == "can") return configured("can_rx").value_or(primary_channel);
    if(id == "lin") return configured("rx").value_or(primary_channel);
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
        for(size_t index = 0; index < structured_count; ++index)
        {
            sr_frame_view frame{};
            if(sr_session_frame(session.get(), index, &frame) != 0) continue;
            json fields = json::array();
            std::vector<std::string> texts;
            json channel_values = json::array();
            const std::string row = frame.type ? frame.type : sr_session_analyzer_name(session.get());
            for(size_t field_index = 0; field_index < frame.field_count; ++field_index)
            {
                sr_field_view field{};
                if(sr_session_frame_field(session.get(), index, field_index, &field) != 0) continue;
                fields.push_back({{"name", field.key ? field.key : "value"}, {"value", FieldValue(field)}});
                const auto text = FieldText(field);
                if(!text.empty()) texts.push_back(text);
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
            std::ostringstream label;
            label << "0x" << std::hex << frame.data1;
            frames.push_back({{"frame_id", index}, {"start_sample", std::max<long long>(frame.start_sample, 0)},
                              {"end_sample", std::max<long long>(frame.end_sample, 0)}, {"row", "frame_" + std::to_string(frame.type)},
                              {"texts", json::array({label.str()})}, {"fields", json::array({
                                {{"name", "data1"}, {"value", json{{"Unsigned", frame.data1}}}},
                                {{"name", "data2"}, {"value", json{{"Unsigned", frame.data2}}}},
                                {{"name", "flags"}, {"value", json{{"Unsigned", frame.flags}}}}
                              })}, {"channel_values", json::array({{{"channel", primary_channel}, {"role", "Data"},
                                {"label", label.str()}, {"value", frame.data1}}})}, {"markers", json::array()}});
        }
    }
    return {{"backend", "saleae_native"}, {"protocol", sr_session_analyzer_name(session.get())},
            {"frames", frames}, {"diagnostics", json::array({{{"level", "info"},
             {"message", "Saleae standalone sparse analyzer completed"}}})}};
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
        for(int index = 1; index < argc; ++index)
        {
            const std::string argument = argv[index];
            if(argument == "--runtime-root" && index + 1 < argc) runtime_root = argv[++index];
            else if(argument == "--probe") probe = true;
            else if(argument == "--catalog") catalog = true;
            else if(argument == "--decode") decode = true;
        }
        if(runtime_root.empty()) throw std::runtime_error("--runtime-root is required");
        if(probe) std::cout << Probe(runtime_root, catalog).dump() << '\n';
        else if(decode) { json input; std::cin >> input; std::cout << Decode(runtime_root, input).dump() << '\n'; }
        else throw std::runtime_error("choose --probe or --decode");
        return 0;
    }
    catch(const std::exception& error)
    {
        std::cerr << error.what() << '\n';
        return 1;
    }
}
