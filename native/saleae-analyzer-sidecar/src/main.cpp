#include "MockChannelData.h"
#include "MockSettings.h"
#include "TestAnalyzerData.h"
#include "TestInstance.h"
#include "result_capture.h"

#include <Analyzer.h>
#include <AnalyzerSettingInterface.h>
#include <CommonCrypto/CommonDigest.h>
#include <dlfcn.h>
#include <nlohmann/json.hpp>

#include <algorithm>
#include <array>
#include <cctype>
#include <cstdlib>
#include <filesystem>
#include <fstream>
#include <iomanip>
#include <iostream>
#include <map>
#include <memory>
#include <optional>
#include <sstream>
#include <stdexcept>
#include <string>
#include <type_traits>
#include <vector>

using json = nlohmann::json;
namespace fs = std::filesystem;

namespace
{

constexpr const char* kRuntimeSha256 = "d7d517b59cf5f165ff4d71e04104794b4c459a96c6309a9ffc6e856b7b25c912";
constexpr const char* kSpiPluginSha256 = "366dfc0b312385f5e608245a9493c33194ed81723a785cc10248fe70593c1ce3";

struct RuntimePaths
{
    fs::path root;
    fs::path runtime_library;
    fs::path spi_plugin;
};

struct SpiSettings
{
    std::optional<U32> mosi;
    std::optional<U32> miso;
    U32 clock = 0;
    std::optional<U32> enable;
    bool enable_active_low = true;
    bool clock_polarity = false;
    bool clock_phase = false;
    U32 bits_per_transfer = 8;
    bool msb_first = true;
};

std::string Sha256(const fs::path& path)
{
    std::ifstream input(path, std::ios::binary);
    if (!input) {
        throw std::runtime_error("cannot open " + path.string());
    }

    CC_SHA256_CTX context;
    CC_SHA256_Init(&context);
    std::array<char, 64 * 1024> buffer{};
    while (input) {
        input.read(buffer.data(), buffer.size());
        const auto count = input.gcount();
        if (count > 0) {
            CC_SHA256_Update(&context, buffer.data(), static_cast<CC_LONG>(count));
        }
    }
    std::array<unsigned char, CC_SHA256_DIGEST_LENGTH> digest{};
    CC_SHA256_Final(digest.data(), &context);

    std::ostringstream output;
    output << std::hex << std::setfill('0');
    for (const auto byte : digest) {
        output << std::setw(2) << static_cast<unsigned int>(byte);
    }
    return output.str();
}

RuntimePaths ValidateRuntimeRoot(const fs::path& root)
{
    RuntimePaths paths{root, root / "libAnalyzer.dylib", root / "Analyzers" / "libspi_analyzer.so"};
    if (!fs::is_regular_file(paths.runtime_library) || !fs::is_regular_file(paths.spi_plugin)) {
        throw std::runtime_error("Saleae runtime root must contain libAnalyzer.dylib and Analyzers/libspi_analyzer.so: " +
                                 root.string());
    }
    return paths;
}

RuntimePaths LocateRuntime(const std::optional<fs::path>& explicit_root)
{
    if (explicit_root.has_value()) {
        return ValidateRuntimeRoot(*explicit_root);
    }
    if (const char* environment_root = std::getenv("PXLOGIC_SALEAE_RUNTIME_ROOT")) {
        return ValidateRuntimeRoot(environment_root);
    }

    const char* home = std::getenv("HOME");
    std::vector<fs::path> candidates = {
        "/Applications/Saleae Logic.app/Contents/Resources/macos-arm64",
        "/Applications/Logic 2.app/Contents/Resources/macos-arm64",
    };
    if (home != nullptr) {
        candidates.emplace_back(fs::path(home) / "Applications/Saleae Logic.app/Contents/Resources/macos-arm64");
        candidates.emplace_back(fs::path(home) / "Applications/Logic 2.app/Contents/Resources/macos-arm64");
    }
    for (const auto& candidate : candidates) {
        if (fs::is_regular_file(candidate / "Analyzers" / "libspi_analyzer.so")) {
            return ValidateRuntimeRoot(candidate);
        }
    }
    throw std::runtime_error(
        "Saleae Logic runtime was not found; pass --runtime-root or PXLOGIC_SALEAE_RUNTIME_ROOT");
}

class Plugin
{
  public:
    explicit Plugin(const fs::path& path)
    {
        handle_ = dlopen(path.c_str(), RTLD_NOW | RTLD_LOCAL);
        if (handle_ == nullptr) {
            throw std::runtime_error("dlopen failed: " + std::string(dlerror()));
        }
        create_ = Load<CreateAnalyzer>("CreateAnalyzer");
        destroy_ = Load<DestroyAnalyzer>("DestroyAnalyzer");
        get_name_ = Load<GetAnalyzerName>("GetAnalyzerName");
    }

    ~Plugin()
    {
        if (analyzer_ != nullptr) {
            destroy_(analyzer_);
        }
        if (handle_ != nullptr) {
            dlclose(handle_);
        }
    }

    Plugin(const Plugin&) = delete;
    Plugin& operator=(const Plugin&) = delete;

    const char* Name() const
    {
        return get_name_();
    }

    Analyzer* Create()
    {
        if (analyzer_ != nullptr) {
            throw std::runtime_error("analyzer already created");
        }
        analyzer_ = create_();
        if (analyzer_ == nullptr) {
            throw std::runtime_error("CreateAnalyzer returned null");
        }
        return analyzer_;
    }

  private:
    using CreateAnalyzer = Analyzer* (*)();
    using DestroyAnalyzer = void (*)(Analyzer*);
    using GetAnalyzerName = const char* (*)();

    template <typename Function>
    Function Load(const char* symbol)
    {
        dlerror();
        auto* address = dlsym(handle_, symbol);
        if (const char* error = dlerror()) {
            throw std::runtime_error(std::string("dlsym ") + symbol + " failed: " + error);
        }
        return reinterpret_cast<Function>(address);
    }

    void* handle_ = nullptr;
    CreateAnalyzer create_ = nullptr;
    DestroyAnalyzer destroy_ = nullptr;
    GetAnalyzerName get_name_ = nullptr;
    Analyzer* analyzer_ = nullptr;
};

std::string Lower(std::string value)
{
    std::transform(value.begin(), value.end(), value.begin(),
                   [](unsigned char character) { return static_cast<char>(std::tolower(character)); });
    return value;
}

AnalyzerSettingInterface* FindSetting(AnalyzerSettings* settings, const std::string& title)
{
    auto* mock = AnalyzerTest::MockSettings::MockFromSettings(settings);
    for (auto* interface : mock->mInterfaces) {
        const auto* candidate = AnalyzerTest::MockSettingInterface::MockFromInterface(interface);
        if (candidate->mTitle == title) {
            return interface;
        }
    }
    throw std::runtime_error("SPI setting not found: " + title);
}

void SetChannelSetting(AnalyzerSettings* settings, const std::string& title, const std::optional<U32>& channel_index)
{
    auto* interface = FindSetting(settings, title);
    if (interface->GetType() != INTERFACE_CHANNEL) {
        throw std::runtime_error(title + " is not a channel setting");
    }
    const Channel channel = channel_index.has_value()
                                ? Channel(0, *channel_index, DIGITAL_CHANNEL)
                                : Channel(0xFFFFFFFFFFFFFFFFull, 0xFFFFFFFF, DIGITAL_CHANNEL);
    static_cast<AnalyzerSettingInterfaceChannel*>(interface)->SetChannel(channel);
}

void SetNumberSetting(AnalyzerSettings* settings, const std::string& title, double value)
{
    auto* interface = FindSetting(settings, title);
    if (interface->GetType() != INTERFACE_NUMBER_LIST) {
        throw std::runtime_error(title + " is not a number-list setting");
    }
    auto* mock = AnalyzerTest::MockSettingInterface::MockFromInterface(interface);
    const auto match = std::find_if(mock->mNamedValueList.begin(), mock->mNamedValueList.end(),
                                    [value](const auto& item) { return item.value == value; });
    if (match == mock->mNamedValueList.end()) {
        std::ostringstream available;
        for (const auto& item : mock->mNamedValueList) {
            available << item.value << " (" << item.name << "), ";
        }
        throw std::runtime_error("unsupported " + title + " value " + std::to_string(value) + "; available: " +
                                 available.str());
    }
    static_cast<AnalyzerSettingInterfaceNumberList*>(interface)->SetNumber(value);
}

void ConfigureAnalyzer(Analyzer* analyzer, const SpiSettings& settings)
{
    auto* analyzer_data = AnalyzerTest::GetDataFromAnalyzer(analyzer);
    if (analyzer_data->settings == nullptr) {
        throw std::runtime_error("SPI plugin did not install AnalyzerSettings");
    }
    SetChannelSetting(analyzer_data->settings, "MOSI", settings.mosi);
    SetChannelSetting(analyzer_data->settings, "MISO", settings.miso);
    SetChannelSetting(analyzer_data->settings, "Clock", settings.clock);
    SetChannelSetting(analyzer_data->settings, "Enable", settings.enable);
    SetNumberSetting(analyzer_data->settings, "Significant Bit", settings.msb_first ? 0.0 : 1.0);
    SetNumberSetting(analyzer_data->settings, "Bits per Transfer", settings.bits_per_transfer);
    SetNumberSetting(analyzer_data->settings, "Clock State", settings.clock_polarity ? 1.0 : 0.0);
    SetNumberSetting(analyzer_data->settings, "Clock Phase", settings.clock_phase ? 1.0 : 0.0);
    SetNumberSetting(analyzer_data->settings, "Enable Line", settings.enable_active_low ? 0.0 : 1.0);
    if (!analyzer_data->settings->SetSettingsFromInterfaces()) {
        throw std::runtime_error("SPI plugin rejected the requested settings");
    }
}

std::optional<U32> OptionalChannel(const json& channels, const char* key)
{
    if (!channels.contains(key) || channels.at(key).is_null()) {
        return std::nullopt;
    }
    return channels.at(key).get<U32>();
}

SpiSettings ParseSettings(const json& input)
{
    const auto& decoder = input.contains("decoder") ? input.at("decoder") : input;
    const auto& channels = decoder.contains("channels") ? decoder.at("channels") : decoder.at("settings");
    const auto& options = decoder.contains("options") ? decoder.at("options") : decoder.at("settings");
    SpiSettings settings;
    settings.mosi = OptionalChannel(channels, "mosi");
    settings.miso = OptionalChannel(channels, "miso");
    settings.clock = channels.contains("clk") ? channels.at("clk").get<U32>() : channels.at("clock").get<U32>();
    settings.enable = channels.contains("cs") ? OptionalChannel(channels, "cs") : OptionalChannel(channels, "enable");
    settings.clock_polarity = options.value("cpol", options.value("clock_polarity", 0)) != 0;
    settings.clock_phase = options.value("cpha", options.value("clock_phase", 0)) != 0;
    settings.bits_per_transfer = options.value("word_size", options.value("bits_per_transfer", 8));
    settings.msb_first = options.value("bit_order", std::string("msb_first")) == "msb_first";
    settings.enable_active_low =
        options.value("cs_polarity", std::string("active_low")) == "active_low";
    return settings;
}

std::map<U32, std::vector<U64>> ParseEdges(const json& input)
{
    std::map<U32, std::vector<U64>> edges;
    for (const auto& edge_set : input.at("edges")) {
        edges[edge_set.at("channel").get<U32>()] = edge_set.at("samples").get<std::vector<U64>>();
    }
    return edges;
}

std::string HexLabel(U64 value, U32 bits)
{
    std::ostringstream output;
    output << "0x" << std::uppercase << std::hex << std::setfill('0') << std::setw((bits + 3) / 4) << value;
    return output.str();
}

bool FitsTransferWidth(U64 value, U32 bits)
{
    return bits >= 64 || value < (U64{1} << bits);
}

bool HasHexadecimalResultText(const std::vector<std::string>& texts)
{
    return std::any_of(texts.begin(), texts.end(), [](const std::string& text) {
        return text.size() >= 3 && text[0] == '0' && (text[1] == 'x' || text[1] == 'X');
    });
}

std::string MarkerKind(AnalyzerResults::MarkerType type)
{
    static const std::array<const char*, 12> names = {"dot",       "error_dot", "square", "error_square",
                                                     "up_arrow",  "down_arrow", "x",      "error_x",
                                                     "start",     "stop",       "one",    "zero"};
    const auto index = static_cast<std::size_t>(type);
    return index < names.size() ? names[index] : "unknown";
}

json FieldValue(const PxlogicSaleaeFieldValue& value)
{
    return std::visit(
        [](const auto& item) -> json {
            using Type = std::decay_t<decltype(item)>;
            if constexpr (std::is_same_v<Type, std::string>) {
                return json{{"Text", item}};
            } else if constexpr (std::is_same_v<Type, double>) {
                return json{{"Text", std::to_string(item)}};
            } else if constexpr (std::is_same_v<Type, std::int64_t>) {
                return item < 0 ? json{{"Signed", item}} : json{{"Unsigned", static_cast<U64>(item)}};
            } else if constexpr (std::is_same_v<Type, bool>) {
                return json{{"Boolean", item}};
            } else if constexpr (std::is_same_v<Type, std::uint8_t>) {
                return json{{"Unsigned", item}};
            } else {
                return json{{"Bytes", item}};
            }
        },
        value);
}

std::optional<U64> NumericFieldValue(const PxlogicSaleaeFieldValue& value)
{
    return std::visit(
        [](const auto& item) -> std::optional<U64> {
            using Type = std::decay_t<decltype(item)>;
            if constexpr (std::is_same_v<Type, std::int64_t>) {
                return item >= 0 ? std::optional<U64>(static_cast<U64>(item)) : std::nullopt;
            } else if constexpr (std::is_same_v<Type, std::uint8_t>) {
                return item;
            } else if constexpr (std::is_same_v<Type, std::vector<std::uint8_t>>) {
                if (item.empty() || item.size() > sizeof(U64)) {
                    return std::nullopt;
                }
                U64 result = 0;
                for (const auto byte : item) {
                    result = (result << 8) | byte;
                }
                return result;
            } else {
                return std::nullopt;
            }
        },
        value);
}

void PushUnique(std::vector<std::string>& values, const std::string& value)
{
    if (!value.empty() && std::find(values.begin(), values.end(), value) == values.end()) {
        values.push_back(value);
    }
}

std::vector<std::string> GenerateTexts(AnalyzerResults* results, U64 legacy_frame_id,
                                       const SpiSettings& settings)
{
    std::vector<std::string> texts;
    auto* store = PxlogicSaleae::GetResultStore(results);
    for (const auto channel_index : {settings.mosi, settings.miso}) {
        if (!channel_index.has_value()) {
            continue;
        }
        results->ClearResultStrings();
        Channel channel(0, *channel_index, DIGITAL_CHANNEL);
        results->GenerateBubbleText(legacy_frame_id, channel, Hexadecimal);
        for (const auto& value : store->strings) {
            PushUnique(texts, value);
        }
    }
    results->ClearTabularText();
    results->GenerateFrameTabularText(legacy_frame_id, Hexadecimal);
    for (const auto& value : store->tabular_text) {
        PushUnique(texts, value);
    }
    return texts;
}

json Decode(const RuntimePaths& runtime, const json& input)
{
    const auto sample_rate = input.at("sample_rate_hz").get<U64>();
    const auto sample_count = input.at("sample_count").get<U64>();
    const auto channel_count = input.at("channel_count").get<U32>();
    const auto initial_levels = input.at("initial_levels").get<std::vector<U8>>();
    if (initial_levels.size() != channel_count) {
        throw std::runtime_error("initial_levels length does not match channel_count");
    }
    const auto settings = ParseSettings(input);
    const auto edges = ParseEdges(input);

    Plugin plugin(runtime.spi_plugin);
    Analyzer* analyzer = plugin.Create();
    ConfigureAnalyzer(analyzer, settings);

    AnalyzerTest::Instance cancellation_probe;
    std::vector<std::unique_ptr<AnalyzerTest::MockChannelData>> channel_data;
    channel_data.reserve(channel_count);
    for (U32 channel_index = 0; channel_index < channel_count; ++channel_index) {
        auto data = std::make_unique<AnalyzerTest::MockChannelData>(&cancellation_probe);
        data->TestSetInitialBitState(initial_levels.at(channel_index) == 0 ? BIT_LOW : BIT_HIGH);
        if (const auto found = edges.find(channel_index); found != edges.end()) {
            for (const auto sample : found->second) {
                if (sample == 0 || sample >= sample_count) {
                    throw std::runtime_error("edge outside capture on channel " + std::to_string(channel_index));
                }
                data->TestAppendTransitionAtSamples(sample);
            }
        }
        data->ResetCurrentSample(0);
        Channel channel(0, channel_index, DIGITAL_CHANNEL);
        AnalyzerTest::GetDataFromAnalyzer(analyzer)->channelData[channel] = data.get();
        channel_data.push_back(std::move(data));
    }
    AnalyzerTest::GetDataFromAnalyzer(analyzer)->sampleRateHz = sample_rate;

    auto* analyzer2 = dynamic_cast<Analyzer2*>(analyzer);
    if (analyzer2 != nullptr) {
        analyzer2->SetupResults();
    }

    std::string worker_status = "completed";
    try {
        analyzer->WorkerThread();
    } catch (const AnalyzerTest::OutOfDataException&) {
        worker_status = "ran_out_of_data";
    } catch (const std::exception& error) {
        worker_status = std::string("error: ") + error.what();
    }

    auto* results = AnalyzerTest::GetResultsFromAnalyzer(analyzer);
    if (results == nullptr) {
        throw std::runtime_error("SPI plugin did not produce AnalyzerResults");
    }
    auto* store = PxlogicSaleae::GetResultStore(results);

    json frames = json::array();
    for (U64 frame_index = 0; frame_index < store->frames.size(); ++frame_index) {
        const auto& captured = store->frames.at(frame_index);
        std::vector<std::string> texts;
        if (captured.legacy_frame_id.has_value()) {
            texts = GenerateTexts(results, *captured.legacy_frame_id, settings);
        }
        json fields = json::array();
        json channel_values = json::array();

        for (const auto& [name, value] : captured.fields) {
            fields.push_back({{"name", name}, {"value", FieldValue(value)}});
            const auto lower_name = Lower(name);
            const auto numeric = NumericFieldValue(value);
            if (numeric.has_value() && lower_name.find("mosi") != std::string::npos && settings.mosi.has_value()) {
                channel_values.push_back({{"channel", *settings.mosi},
                                          {"role", "MOSI"},
                                          {"label", HexLabel(*numeric, settings.bits_per_transfer)},
                                          {"value", *numeric}});
            }
            if (numeric.has_value() && lower_name.find("miso") != std::string::npos && settings.miso.has_value()) {
                channel_values.push_back({{"channel", *settings.miso},
                                          {"role", "MISO"},
                                          {"label", HexLabel(*numeric, settings.bits_per_transfer)},
                                          {"value", *numeric}});
            }
        }

        const bool legacy_data_frame =
            captured.fields.empty() && captured.legacy_frame_id.has_value() && HasHexadecimalResultText(texts) &&
            (!settings.mosi.has_value() || FitsTransferWidth(captured.data1, settings.bits_per_transfer)) &&
            (!settings.miso.has_value() || FitsTransferWidth(captured.data2, settings.bits_per_transfer));
        if (legacy_data_frame) {
            if (settings.mosi.has_value()) {
                fields.push_back({{"name", "mosi"}, {"value", json{{"Unsigned", captured.data1}}}});
                channel_values.push_back({{"channel", *settings.mosi},
                                          {"role", "MOSI"},
                                          {"label", HexLabel(captured.data1, settings.bits_per_transfer)},
                                          {"value", captured.data1}});
            }
            if (settings.miso.has_value()) {
                fields.push_back({{"name", "miso"}, {"value", json{{"Unsigned", captured.data2}}}});
                channel_values.push_back({{"channel", *settings.miso},
                                          {"role", "MISO"},
                                          {"label", HexLabel(captured.data2, settings.bits_per_transfer)},
                                          {"value", captured.data2}});
            }
        }

        json markers = json::array();
        for (const auto& marker : store->markers) {
            if (marker.sample >= static_cast<U64>(std::max<S64>(captured.start_sample, 0)) &&
                marker.sample <= static_cast<U64>(std::max<S64>(captured.end_sample, 0))) {
                markers.push_back({{"row", captured.row.empty() ? "SPI" : captured.row},
                                   {"channel", marker.channel.mChannelIndex},
                                   {"sample", marker.sample},
                                   {"kind", MarkerKind(marker.type)}});
            }
        }

        frames.push_back({{"frame_id", frame_index},
                          {"start_sample", std::max<S64>(captured.start_sample, 0)},
                          {"end_sample", std::max<S64>(captured.end_sample, 0)},
                          {"row", captured.row.empty() ? "SPI" : captured.row},
                          {"texts", texts},
                          {"fields", fields},
                          {"channel_values", channel_values},
                          {"markers", markers}});
    }

    json diagnostics = json::array({{{"level", "info"}, {"message", "Saleae worker " + worker_status}}});
    return {{"backend", "saleae_native"},
            {"protocol", "SPI"},
            {"frames", frames},
            {"diagnostics", diagnostics}};
}

json Probe(const RuntimePaths& runtime)
{
    Plugin plugin(runtime.spi_plugin);
    const auto runtime_hash = Sha256(runtime.runtime_library);
    const auto plugin_hash = Sha256(runtime.spi_plugin);
    return {{"kind", "saleae_native"},
            {"display_name", "Saleae Native analyzer sidecar"},
            {"available", runtime_hash == kRuntimeSha256 && plugin_hash == kSpiPluginSha256},
            {"protocols", json::array({"SPI"})},
            {"supports_streaming", false},
            {"isolation", "sidecar"},
            {"analyzer_name", plugin.Name()},
            {"runtime_root", runtime.root.string()},
            {"runtime_sha256", runtime_hash},
            {"runtime_sha256_expected", kRuntimeSha256},
            {"plugin_sha256", plugin_hash},
            {"plugin_sha256_expected", kSpiPluginSha256},
            {"abi_match", runtime_hash == kRuntimeSha256 && plugin_hash == kSpiPluginSha256}};
}

std::vector<U64> ValuesForRole(const json& output, const std::string& role)
{
    std::vector<U64> values;
    for (const auto& frame : output.at("frames")) {
        for (const auto& value : frame.at("channel_values")) {
            if (value.at("role") == role) {
                values.push_back(value.at("value").get<U64>());
            }
        }
    }
    return values;
}

json RunFixtures(const RuntimePaths& runtime, const fs::path& path)
{
    std::ifstream input(path);
    if (!input) {
        throw std::runtime_error("cannot open fixture file " + path.string());
    }
    json fixtures = json::parse(input);
    json cases = json::array();
    bool all_matched = true;
    for (const auto& fixture : fixtures.at("cases")) {
        const auto output = Decode(runtime, fixture);
        std::vector<U64> expected_mosi;
        std::vector<U64> expected_miso;
        for (const auto& word : fixture.at("expected_words")) {
            expected_mosi.push_back(word.at("mosi").get<U64>());
            expected_miso.push_back(word.at("miso").get<U64>());
        }
        const auto actual_mosi = ValuesForRole(output, "MOSI");
        const auto actual_miso = ValuesForRole(output, "MISO");
        const bool matched = actual_mosi == expected_mosi && actual_miso == expected_miso;
        all_matched &= matched;
        cases.push_back({{"id", fixture.at("id")},
                         {"matched", matched},
                         {"expected_mosi", expected_mosi},
                         {"actual_mosi", actual_mosi},
                         {"expected_miso", expected_miso},
                         {"actual_miso", actual_miso},
                         {"output", output}});
    }
    return {{"format", "pxlogic.saleae.fixture-results.v1"},
            {"backend", Probe(runtime)},
            {"all_matched", all_matched},
            {"cases", cases}};
}

} // namespace

int main(int argc, char** argv)
{
    try {
        std::optional<fs::path> runtime_root;
        std::optional<fs::path> fixture_path;
        bool probe = false;
        bool decode = false;
        for (int index = 1; index < argc; ++index) {
            const std::string argument = argv[index];
            if (argument == "--runtime-root" && index + 1 < argc) {
                runtime_root = argv[++index];
            } else if (argument == "--probe") {
                probe = true;
            } else if (argument == "--decode") {
                decode = true;
            } else if (argument == "--run-fixtures" && index + 1 < argc) {
                fixture_path = argv[++index];
            } else {
                throw std::runtime_error("unknown or incomplete argument: " + argument);
            }
        }

        const auto runtime = LocateRuntime(runtime_root);
        json output;
        if (probe) {
            output = Probe(runtime);
        } else if (fixture_path.has_value()) {
            if (!Probe(runtime).at("available").get<bool>()) {
                throw std::runtime_error("Saleae runtime hash/ABI does not match Logic 2.4.43");
            }
            output = RunFixtures(runtime, *fixture_path);
        } else if (decode) {
            if (!Probe(runtime).at("available").get<bool>()) {
                throw std::runtime_error("Saleae runtime hash/ABI does not match Logic 2.4.43");
            }
            output = Decode(runtime, json::parse(std::cin));
        } else {
            throw std::runtime_error("choose --probe, --decode, or --run-fixtures <path>");
        }
        std::cout << output.dump(2) << '\n';
        return 0;
    } catch (const std::exception& error) {
        std::cerr << "pxlogic-saleae-analyzer-sidecar: " << error.what() << '\n';
        return 1;
    }
}
