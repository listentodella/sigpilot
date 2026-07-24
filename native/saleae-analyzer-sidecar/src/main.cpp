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
#include <variant>
#include <vector>

using json = nlohmann::json;
namespace fs = std::filesystem;

namespace
{

constexpr const char* kRuntimeSha256 = "d7d517b59cf5f165ff4d71e04104794b4c459a96c6309a9ffc6e856b7b25c912";
constexpr const char* kSerialPluginSha256 = "d4bda764fc99ff552962f615f8bcbbf320f6015a2ab788155af4cbb190569117";
constexpr const char* kI2cPluginSha256 = "e3467f6e8183e57d324798e99cc8d680b2411e3fef11aeae42a52ae8e74781f9";
constexpr const char* kSpiPluginSha256 = "366dfc0b312385f5e608245a9493c33194ed81723a785cc10248fe70593c1ce3";
constexpr const char* kI2sPluginSha256 = "28c6864400d3f6f6baa3f71a4598f8cff8a00fa7b634148015d1707d9b443974";
constexpr const char* kCanPluginSha256 = "ec1fcaa48d25930c43fe315e1c30917a475d01e7b85ad81d71e674ad81d1e251";

enum class DecoderProtocol
{
    Uart,
    I2c,
    Spi,
    I2s,
    Can,
};

struct RuntimePaths
{
    fs::path root;
    fs::path runtime_library;
    fs::path serial_plugin;
    fs::path i2c_plugin;
    fs::path spi_plugin;
    fs::path i2s_plugin;
    fs::path can_plugin;

    const fs::path& PluginPath(DecoderProtocol protocol) const
    {
        switch (protocol) {
        case DecoderProtocol::Uart:
            return serial_plugin;
        case DecoderProtocol::I2c:
            return i2c_plugin;
        case DecoderProtocol::Spi:
            return spi_plugin;
        case DecoderProtocol::I2s:
            return i2s_plugin;
        case DecoderProtocol::Can:
            return can_plugin;
        }
        throw std::runtime_error("unknown Saleae decoder protocol");
    }
};

struct UartSettings
{
    U32 channel = 0;
    U32 baud_rate = 115200;
    U32 data_bits = 8;
    double stop_bits = 1.0;
    U32 parity = 0;
    bool msb_first = false;
    bool inverted = false;
};

struct I2cSettings
{
    U32 sda = 0;
    U32 scl = 1;
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

struct I2sSettings
{
    U32 clock = 0;
    U32 frame = 1;
    U32 data = 2;
    bool msb_first = true;
    bool rising_edge = true;
    U32 bit_depth = 16;
    U32 frame_transitions = 1;
    bool left_aligned = true;
    bool shifted_by_one = true;
    bool signed_values = false;
    bool word_select_high_is_right = true;
};

struct CanSettings
{
    U32 channel = 0;
    U32 bit_rate = 1'000'000;
    bool inverted = false;
};

using DecoderSettings = std::variant<UartSettings, I2cSettings, SpiSettings, I2sSettings, CanSettings>;

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
    RuntimePaths paths{root,
                       root / "libAnalyzer.dylib",
                       root / "Analyzers" / "libserial_analyzer.so",
                       root / "Analyzers" / "libi2c_analyzer.so",
                       root / "Analyzers" / "libspi_analyzer.so",
                       root / "Analyzers" / "libi2s_analyzer.so",
                       root / "Analyzers" / "libcan_analyzer.so"};
    if (!fs::is_regular_file(paths.runtime_library) || !fs::is_regular_file(paths.serial_plugin) ||
        !fs::is_regular_file(paths.i2c_plugin) || !fs::is_regular_file(paths.spi_plugin) ||
        !fs::is_regular_file(paths.i2s_plugin) || !fs::is_regular_file(paths.can_plugin)) {
        throw std::runtime_error(
            "Saleae runtime root must contain libAnalyzer.dylib plus Serial, I2C, SPI, I2S, and CAN analyzer plugins: " +
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
        if (fs::is_regular_file(candidate / "Analyzers" / "libserial_analyzer.so") &&
            fs::is_regular_file(candidate / "Analyzers" / "libi2c_analyzer.so") &&
            fs::is_regular_file(candidate / "Analyzers" / "libspi_analyzer.so") &&
            fs::is_regular_file(candidate / "Analyzers" / "libi2s_analyzer.so") &&
            fs::is_regular_file(candidate / "Analyzers" / "libcan_analyzer.so")) {
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

json SettingsSchema(Plugin& plugin)
{
    Analyzer* analyzer = plugin.Create();
    auto* settings = AnalyzerTest::GetDataFromAnalyzer(analyzer)->settings;
    if (settings == nullptr) {
        throw std::runtime_error("Saleae plugin did not install AnalyzerSettings");
    }
    auto* mock_settings = AnalyzerTest::MockSettings::MockFromSettings(settings);
    json schema = json::array();
    for (auto* interface : mock_settings->mInterfaces) {
        const auto* mock = AnalyzerTest::MockSettingInterface::MockFromInterface(interface);
        json values = json::array();
        for (const auto& value : mock->mNamedValueList) {
            values.push_back({{"name", value.name}, {"value", value.value}, {"tooltip", value.tooltip}});
        }
        schema.push_back({{"title", mock->mTitle},
                          {"tooltip", mock->mTooltip},
                          {"type", static_cast<int>(mock->mTypeId)},
                          {"selected_index", mock->mValue},
                          {"values", values}});
    }
    return schema;
}

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
    throw std::runtime_error("Saleae analyzer setting not found: " + title);
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
    if (interface->GetType() == INTERFACE_INTEGER) {
        static_cast<AnalyzerSettingInterfaceInteger*>(interface)->SetInteger(static_cast<int>(value));
        return;
    }
    if (interface->GetType() == INTERFACE_BOOL) {
        static_cast<AnalyzerSettingInterfaceBool*>(interface)->SetValue(value != 0.0);
        return;
    }
    if (interface->GetType() == INTERFACE_NUMBER_LIST) {
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
        return;
    }
    throw std::runtime_error(title + " is not a numeric Saleae analyzer setting");
}

AnalyzerSettings* AnalyzerSettingsFor(Analyzer* analyzer)
{
    auto* analyzer_data = AnalyzerTest::GetDataFromAnalyzer(analyzer);
    if (analyzer_data->settings == nullptr) {
        throw std::runtime_error("Saleae plugin did not install AnalyzerSettings");
    }
    return analyzer_data->settings;
}

void CommitSettings(AnalyzerSettings* settings, const char* protocol)
{
    if (!settings->SetSettingsFromInterfaces()) {
        throw std::runtime_error(std::string(protocol) + " plugin rejected the requested settings");
    }
}

void ConfigureAnalyzer(Analyzer* analyzer, const UartSettings& settings)
{
    auto* analyzer_settings = AnalyzerSettingsFor(analyzer);
    SetChannelSetting(analyzer_settings, "Input Channel", settings.channel);
    SetNumberSetting(analyzer_settings, "Bit Rate (Bits/s)", settings.baud_rate);
    SetNumberSetting(analyzer_settings, "Bits per Frame", settings.data_bits);
    SetNumberSetting(analyzer_settings, "Stop Bits", settings.stop_bits);
    SetNumberSetting(analyzer_settings, "Parity Bit", settings.parity);
    SetNumberSetting(analyzer_settings, "Significant Bit", settings.msb_first ? 1.0 : 0.0);
    SetNumberSetting(analyzer_settings, "Signal inversion", settings.inverted ? 1.0 : 0.0);
    SetNumberSetting(analyzer_settings, "Mode", 0.0);
    CommitSettings(analyzer_settings, "Async Serial");
}

void ConfigureAnalyzer(Analyzer* analyzer, const I2cSettings& settings)
{
    auto* analyzer_settings = AnalyzerSettingsFor(analyzer);
    SetChannelSetting(analyzer_settings, "SDA", settings.sda);
    SetChannelSetting(analyzer_settings, "SCL", settings.scl);
    CommitSettings(analyzer_settings, "I2C");
}

void ConfigureAnalyzer(Analyzer* analyzer, const SpiSettings& settings)
{
    auto* analyzer_settings = AnalyzerSettingsFor(analyzer);
    SetChannelSetting(analyzer_settings, "MOSI", settings.mosi);
    SetChannelSetting(analyzer_settings, "MISO", settings.miso);
    SetChannelSetting(analyzer_settings, "Clock", settings.clock);
    SetChannelSetting(analyzer_settings, "Enable", settings.enable);
    SetNumberSetting(analyzer_settings, "Significant Bit", settings.msb_first ? 0.0 : 1.0);
    SetNumberSetting(analyzer_settings, "Bits per Transfer", settings.bits_per_transfer);
    SetNumberSetting(analyzer_settings, "Clock State", settings.clock_polarity ? 1.0 : 0.0);
    SetNumberSetting(analyzer_settings, "Clock Phase", settings.clock_phase ? 1.0 : 0.0);
    SetNumberSetting(analyzer_settings, "Enable Line", settings.enable_active_low ? 0.0 : 1.0);
    CommitSettings(analyzer_settings, "SPI");
}

void ConfigureAnalyzer(Analyzer* analyzer, const I2sSettings& settings)
{
    auto* analyzer_settings = AnalyzerSettingsFor(analyzer);
    SetChannelSetting(analyzer_settings, "CLOCK channel", settings.clock);
    SetChannelSetting(analyzer_settings, "FRAME", settings.frame);
    SetChannelSetting(analyzer_settings, "DATA", settings.data);
    SetNumberSetting(analyzer_settings, "DATA Significant Bit", settings.msb_first ? 0.0 : 1.0);
    SetNumberSetting(analyzer_settings, "CLOCK State", settings.rising_edge ? 0.0 : 1.0);
    SetNumberSetting(analyzer_settings, "Audio Bit Depth (bits/sample)", settings.bit_depth);
    SetNumberSetting(analyzer_settings, "FRAME Signal Transitions", settings.frame_transitions);
    SetNumberSetting(analyzer_settings, "DATA Bits Alignment", settings.left_aligned ? 0.0 : 1.0);
    SetNumberSetting(analyzer_settings, "DATA Bits Shift", settings.shifted_by_one ? 0.0 : 1.0);
    SetNumberSetting(analyzer_settings, "Signed/Unsigned", settings.signed_values ? 1.0 : 0.0);
    SetNumberSetting(analyzer_settings, "Word Select High", settings.word_select_high_is_right ? 1.0 : 0.0);
    CommitSettings(analyzer_settings, "I2S / PCM");
}

void ConfigureAnalyzer(Analyzer* analyzer, const CanSettings& settings)
{
    auto* analyzer_settings = AnalyzerSettingsFor(analyzer);
    SetChannelSetting(analyzer_settings, "CAN", settings.channel);
    SetNumberSetting(analyzer_settings, "Bit Rate (Bits/s)", settings.bit_rate);
    SetNumberSetting(analyzer_settings, "", settings.inverted ? 1.0 : 0.0);
    CommitSettings(analyzer_settings, "CAN");
}

std::optional<U32> OptionalChannel(const json& channels, const char* key)
{
    if (!channels.contains(key) || channels.at(key).is_null()) {
        return std::nullopt;
    }
    return channels.at(key).get<U32>();
}

DecoderProtocol ParseProtocol(const json& input)
{
    const auto& decoder = input.contains("decoder") ? input.at("decoder") : input;
    const auto protocol = Lower(decoder.value("protocol", std::string("")));
    if (protocol == "uart" || protocol == "serial" || protocol == "async_serial") {
        return DecoderProtocol::Uart;
    }
    if (protocol == "i2c") {
        return DecoderProtocol::I2c;
    }
    if (protocol == "spi") {
        return DecoderProtocol::Spi;
    }
    if (protocol == "i2s" || protocol == "i2s_pcm") {
        return DecoderProtocol::I2s;
    }
    if (protocol == "can") {
        return DecoderProtocol::Can;
    }
    throw std::runtime_error("decoder.protocol must be uart, i2c, spi, i2s, or can");
}

UartSettings ParseUartSettings(const json& input)
{
    const auto& decoder = input.contains("decoder") ? input.at("decoder") : input;
    const auto& channels = decoder.contains("channels") ? decoder.at("channels") : decoder.at("settings");
    const auto& options = decoder.contains("options") ? decoder.at("options") : decoder.at("settings");
    UartSettings settings;
    const auto channel = channels.contains("rx") ? OptionalChannel(channels, "rx") : OptionalChannel(channels, "channel");
    if (!channel.has_value()) {
        throw std::runtime_error("Async Serial requires an input channel");
    }
    settings.channel = *channel;
    settings.baud_rate = options.value("baudrate", options.value("baud_rate", 115200u));
    settings.data_bits = options.value("data_bits", 8u);
    settings.stop_bits = options.value("stop_bits", 1.0);
    const auto parity = Lower(options.value("parity", std::string("none")));
    settings.parity = parity == "even" ? 1u : parity == "odd" ? 2u : 0u;
    const auto bit_order = Lower(options.value("bit_order", std::string("lsb-first")));
    settings.msb_first = bit_order == "msb-first" || bit_order == "msb_first";
    settings.inverted = options.value("invert_rx", options.value("inverted", 0)) != 0;
    if (settings.baud_rate == 0 || settings.data_bits == 0 || settings.data_bits > 64) {
        throw std::runtime_error("invalid Async Serial settings");
    }
    return settings;
}

I2cSettings ParseI2cSettings(const json& input)
{
    const auto& decoder = input.contains("decoder") ? input.at("decoder") : input;
    const auto& channels = decoder.contains("channels") ? decoder.at("channels") : decoder.at("settings");
    I2cSettings settings;
    settings.sda = channels.at("sda").get<U32>();
    settings.scl = channels.at("scl").get<U32>();
    if (settings.sda == settings.scl) {
        throw std::runtime_error("I2C requires distinct SDA and SCL channels");
    }
    return settings;
}

SpiSettings ParseSpiSettings(const json& input)
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

I2sSettings ParseI2sSettings(const json& input)
{
    const auto& decoder = input.contains("decoder") ? input.at("decoder") : input;
    const auto& channels = decoder.contains("channels") ? decoder.at("channels") : decoder.at("settings");
    const auto& options = decoder.contains("options") ? decoder.at("options") : decoder.at("settings");
    I2sSettings settings;
    settings.clock = channels.contains("sck") ? channels.at("sck").get<U32>() : channels.at("clock").get<U32>();
    settings.frame = channels.contains("ws") ? channels.at("ws").get<U32>() : channels.at("frame").get<U32>();
    settings.data = channels.contains("sd") ? channels.at("sd").get<U32>() : channels.at("data").get<U32>();
    const auto bit_order = Lower(options.value("bit_order", std::string("msb-first")));
    const auto clock_edge = Lower(options.value("clk_edge", std::string("rising-edge")));
    const auto frame_transitions = Lower(options.value("frame_transitions", std::string("once-each-word")));
    const auto bit_align = Lower(options.value("bit_align", std::string("left-aligned")));
    const auto bit_shift = Lower(options.value("bit_shift", std::string("right-shifted by one")));
    const auto ws_polarity = Lower(options.value("ws_polarity", std::string("right-high")));
    settings.msb_first = bit_order != "lsb-first";
    settings.rising_edge = clock_edge != "falling-edge";
    settings.bit_depth = options.value("word_size", options.value("wordsize", 16u));
    settings.frame_transitions = frame_transitions == "twice-each-word"
                                     ? 0u
                                     : frame_transitions == "twice-every-4-words" ? 2u : 1u;
    settings.left_aligned = bit_align != "right-aligned";
    settings.shifted_by_one = bit_shift != "none";
    settings.signed_values = options.value("signed", false);
    settings.word_select_high_is_right = ws_polarity != "left-high";
    if (settings.clock == settings.frame || settings.clock == settings.data || settings.frame == settings.data ||
        settings.bit_depth == 0 || settings.bit_depth > 64) {
        throw std::runtime_error("invalid I2S / PCM settings");
    }
    return settings;
}

CanSettings ParseCanSettings(const json& input)
{
    const auto& decoder = input.contains("decoder") ? input.at("decoder") : input;
    const auto& channels = decoder.contains("channels") ? decoder.at("channels") : decoder.at("settings");
    const auto& options = decoder.contains("options") ? decoder.at("options") : decoder.at("settings");
    CanSettings settings;
    const auto channel = channels.contains("can_rx") ? OptionalChannel(channels, "can_rx")
                                                     : OptionalChannel(channels, "channel");
    if (!channel.has_value()) {
        throw std::runtime_error("CAN requires an input channel");
    }
    settings.channel = *channel;
    settings.bit_rate = options.value("bitrate", options.value("bit_rate", 1'000'000u));
    settings.inverted = options.value("inverted", false);
    if (settings.bit_rate < 10'000 || settings.bit_rate > 25'000'000) {
        throw std::runtime_error("CAN bit rate must be between 10000 and 25000000 bits/s");
    }
    return settings;
}

DecoderSettings ParseSettings(const json& input, DecoderProtocol protocol)
{
    switch (protocol) {
    case DecoderProtocol::Uart:
        return ParseUartSettings(input);
    case DecoderProtocol::I2c:
        return ParseI2cSettings(input);
    case DecoderProtocol::Spi:
        return ParseSpiSettings(input);
    case DecoderProtocol::I2s:
        return ParseI2sSettings(input);
    case DecoderProtocol::Can:
        return ParseCanSettings(input);
    }
    throw std::runtime_error("unknown Saleae decoder protocol");
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
            } else if constexpr (std::is_same_v<Type, bool>) {
                return item ? U64{1} : U64{0};
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

const char* ProtocolName(DecoderProtocol protocol)
{
    switch (protocol) {
    case DecoderProtocol::Uart:
        return "Async Serial";
    case DecoderProtocol::I2c:
        return "I2C";
    case DecoderProtocol::Spi:
        return "SPI";
    case DecoderProtocol::I2s:
        return "I2S / PCM";
    case DecoderProtocol::Can:
        return "CAN";
    }
    return "Unknown";
}

std::vector<U32> BubbleChannels(const DecoderSettings& settings)
{
    return std::visit(
        [](const auto& value) {
            using Type = std::decay_t<decltype(value)>;
            if constexpr (std::is_same_v<Type, UartSettings>) {
                return std::vector<U32>{value.channel};
            } else if constexpr (std::is_same_v<Type, I2cSettings>) {
                return std::vector<U32>{value.sda};
            } else if constexpr (std::is_same_v<Type, SpiSettings>) {
                std::vector<U32> channels;
                if (value.mosi.has_value()) {
                    channels.push_back(*value.mosi);
                }
                if (value.miso.has_value()) {
                    channels.push_back(*value.miso);
                }
                return channels;
            } else if constexpr (std::is_same_v<Type, CanSettings>) {
                return std::vector<U32>{value.channel};
            } else {
                return std::vector<U32>{value.data};
            }
        },
        settings);
}

std::vector<std::string> GenerateTexts(AnalyzerResults* results, U64 legacy_frame_id,
                                       const DecoderSettings& settings)
{
    std::vector<std::string> texts;
    auto* store = PxlogicSaleae::GetResultStore(results);
    for (const auto channel_index : BubbleChannels(settings)) {
        results->ClearResultStrings();
        Channel channel(0, channel_index, DIGITAL_CHANNEL);
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

void AddChannelValue(json& values, U32 channel, const char* role, U64 value, U32 bits)
{
    values.push_back({{"channel", channel},
                      {"role", role},
                      {"label", HexLabel(value, bits)},
                      {"value", value}});
}

void AddFieldChannelValue(json& values, const DecoderSettings& settings, const std::string& name, U64 value)
{
    const auto lower_name = Lower(name);
    std::visit(
        [&](const auto& decoder) {
            using Type = std::decay_t<decltype(decoder)>;
            if constexpr (std::is_same_v<Type, UartSettings>) {
                if (lower_name == "data") {
                    AddChannelValue(values, decoder.channel, "Data", value, decoder.data_bits);
                }
            } else if constexpr (std::is_same_v<Type, I2cSettings>) {
                if (lower_name == "address") {
                    AddChannelValue(values, decoder.sda, "Address", value, 7);
                } else if (lower_name == "data") {
                    AddChannelValue(values, decoder.sda, "Data", value, 8);
                }
            } else if constexpr (std::is_same_v<Type, SpiSettings>) {
                if (lower_name.find("mosi") != std::string::npos && decoder.mosi.has_value()) {
                    AddChannelValue(values, *decoder.mosi, "MOSI", value, decoder.bits_per_transfer);
                }
                if (lower_name.find("miso") != std::string::npos && decoder.miso.has_value()) {
                    AddChannelValue(values, *decoder.miso, "MISO", value, decoder.bits_per_transfer);
                }
            } else if constexpr (std::is_same_v<Type, CanSettings>) {
                if (lower_name == "identifier") {
                    AddChannelValue(values, decoder.channel, "Identifier", value, 11);
                } else if (lower_name == "num_data_bytes") {
                    AddChannelValue(values, decoder.channel, "DLC", value, 4);
                } else if (lower_name == "data") {
                    AddChannelValue(values, decoder.channel, "Data", value, 8);
                } else if (lower_name == "crc") {
                    AddChannelValue(values, decoder.channel, "CRC", value, 15);
                } else if (lower_name == "ack") {
                    AddChannelValue(values, decoder.channel, "ACK", value, 1);
                }
            }
        },
        settings);
}

void AddI2sFrameValues(const PxlogicSaleae::CapturedFrame& captured, const DecoderSettings& settings,
                       std::vector<std::string>& texts, json& channel_values)
{
    const auto* decoder = std::get_if<I2sSettings>(&settings);
    if (decoder == nullptr) {
        return;
    }
    std::optional<U64> data;
    std::string channel = "Channel";
    for (const auto& [name, value] : captured.fields) {
        const auto lower_name = Lower(name);
        if (lower_name == "data") {
            data = NumericFieldValue(value);
        } else if (lower_name == "channel") {
            if (const auto* label = std::get_if<std::string>(&value)) {
                channel = *label;
            } else if (const auto index = NumericFieldValue(value); index.has_value()) {
                channel = *index == 0 ? "Ch 1" : *index == 1 ? "Ch 2" : "Channel " + std::to_string(*index + 1);
            }
        }
    }
    if (!data.has_value()) {
        return;
    }
    const auto hex = HexLabel(*data, decoder->bit_depth);
    PushUnique(texts, channel + ": " + hex);
    PushUnique(texts, hex);
    AddChannelValue(channel_values, decoder->data, channel.c_str(), *data, decoder->bit_depth);
}

void AddLegacyFields(const PxlogicSaleae::CapturedFrame& captured, const std::vector<std::string>& texts,
                     const DecoderSettings& settings, json& fields, json& channel_values)
{
    if (!captured.fields.empty() || !captured.legacy_frame_id.has_value()) {
        return;
    }
    std::visit(
        [&](const auto& decoder) {
            using Type = std::decay_t<decltype(decoder)>;
            if constexpr (std::is_same_v<Type, UartSettings>) {
                fields.push_back({{"name", "data"}, {"value", json{{"Unsigned", captured.data1}}}});
                AddChannelValue(channel_values, decoder.channel, "Data", captured.data1, decoder.data_bits);
            } else if constexpr (std::is_same_v<Type, I2cSettings>) {
                if (captured.type == 0) {
                    const auto address = captured.data1 >> 1;
                    fields.push_back({{"name", "address"}, {"value", json{{"Unsigned", address}}}});
                    AddChannelValue(channel_values, decoder.sda, "Address", address, 7);
                } else {
                    fields.push_back({{"name", "data"}, {"value", json{{"Unsigned", captured.data1}}}});
                    AddChannelValue(channel_values, decoder.sda, "Data", captured.data1, 8);
                }
            } else if constexpr (std::is_same_v<Type, SpiSettings>) {
                const bool data_frame = HasHexadecimalResultText(texts) &&
                                        (!decoder.mosi.has_value() ||
                                         FitsTransferWidth(captured.data1, decoder.bits_per_transfer)) &&
                                        (!decoder.miso.has_value() ||
                                         FitsTransferWidth(captured.data2, decoder.bits_per_transfer));
                if (!data_frame) {
                    return;
                }
                if (decoder.mosi.has_value()) {
                    fields.push_back({{"name", "mosi"}, {"value", json{{"Unsigned", captured.data1}}}});
                    AddChannelValue(channel_values, *decoder.mosi, "MOSI", captured.data1,
                                    decoder.bits_per_transfer);
                }
                if (decoder.miso.has_value()) {
                    fields.push_back({{"name", "miso"}, {"value", json{{"Unsigned", captured.data2}}}});
                    AddChannelValue(channel_values, *decoder.miso, "MISO", captured.data2,
                                    decoder.bits_per_transfer);
                }
            }
        },
        settings);
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
    const auto protocol = ParseProtocol(input);
    const auto settings = ParseSettings(input, protocol);
    const auto edges = ParseEdges(input);

    Plugin plugin(runtime.PluginPath(protocol));
    Analyzer* analyzer = plugin.Create();
    std::visit([&](const auto& value) { ConfigureAnalyzer(analyzer, value); }, settings);

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
        throw std::runtime_error(std::string(ProtocolName(protocol)) + " plugin did not produce AnalyzerResults");
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
            const auto numeric = NumericFieldValue(value);
            if (numeric.has_value()) {
                AddFieldChannelValue(channel_values, settings, name, *numeric);
            }
        }
        AddI2sFrameValues(captured, settings, texts, channel_values);
        AddLegacyFields(captured, texts, settings, fields, channel_values);

        const std::string row = captured.row.empty() ? ProtocolName(protocol) : captured.row;

        json markers = json::array();
        for (const auto& marker : store->markers) {
            if (marker.sample >= static_cast<U64>(std::max<S64>(captured.start_sample, 0)) &&
                marker.sample <= static_cast<U64>(std::max<S64>(captured.end_sample, 0))) {
                markers.push_back({{"row", row},
                                   {"channel", marker.channel.mChannelIndex},
                                   {"sample", marker.sample},
                                   {"kind", MarkerKind(marker.type)}});
            }
        }

        frames.push_back({{"frame_id", frame_index},
                          {"start_sample", std::max<S64>(captured.start_sample, 0)},
                          {"end_sample", std::max<S64>(captured.end_sample, 0)},
                          {"row", row},
                          {"texts", texts},
                          {"fields", fields},
                          {"channel_values", channel_values},
                          {"markers", markers}});
    }

    json diagnostics = json::array({{{"level", "info"}, {"message", "Saleae worker " + worker_status}}});
    return {{"backend", "saleae_native"},
            {"protocol", ProtocolName(protocol)},
            {"frames", frames},
            {"diagnostics", diagnostics}};
}

json Probe(const RuntimePaths& runtime)
{
    Plugin serial(runtime.serial_plugin);
    Plugin i2c(runtime.i2c_plugin);
    Plugin spi(runtime.spi_plugin);
    Plugin i2s(runtime.i2s_plugin);
    Plugin can(runtime.can_plugin);
    const auto runtime_hash = Sha256(runtime.runtime_library);
    const auto serial_hash = Sha256(runtime.serial_plugin);
    const auto i2c_hash = Sha256(runtime.i2c_plugin);
    const auto spi_hash = Sha256(runtime.spi_plugin);
    const auto i2s_hash = Sha256(runtime.i2s_plugin);
    const auto can_hash = Sha256(runtime.can_plugin);
    const bool abi_match = runtime_hash == kRuntimeSha256 && serial_hash == kSerialPluginSha256 &&
                           i2c_hash == kI2cPluginSha256 && spi_hash == kSpiPluginSha256 &&
                           i2s_hash == kI2sPluginSha256 && can_hash == kCanPluginSha256;
    return {{"kind", "saleae_native"},
            {"display_name", "Saleae Native analyzer sidecar"},
            {"available", abi_match},
            {"protocols", json::array({"UART", "I2C", "SPI", "I2S", "CAN"})},
            {"supports_streaming", false},
            {"isolation", "sidecar"},
            {"analyzer_name",
             std::string(serial.Name()) + ", " + i2c.Name() + ", " + spi.Name() + ", " + i2s.Name() + ", " +
                 can.Name()},
            {"runtime_root", runtime.root.string()},
            {"runtime_sha256", runtime_hash},
            {"runtime_sha256_expected", kRuntimeSha256},
            {"plugin_sha256", i2s_hash},
            {"plugin_sha256_expected", kI2sPluginSha256},
            {"plugins",
             json::array({{{"protocol", "UART"},
                           {"name", serial.Name()},
                           {"sha256", serial_hash},
                           {"sha256_expected", kSerialPluginSha256}},
                          {{"protocol", "I2C"},
                           {"name", i2c.Name()},
                           {"sha256", i2c_hash},
                           {"sha256_expected", kI2cPluginSha256}},
                          {{"protocol", "SPI"},
                           {"name", spi.Name()},
                           {"sha256", spi_hash},
                           {"sha256_expected", kSpiPluginSha256}},
                          {{"protocol", "I2S"},
                           {"name", i2s.Name()},
                           {"sha256", i2s_hash},
                           {"sha256_expected", kI2sPluginSha256},
                           {"settings_schema", SettingsSchema(i2s)}},
                          {{"protocol", "CAN"},
                           {"name", can.Name()},
                           {"sha256", can_hash},
                           {"sha256_expected", kCanPluginSha256},
                           {"settings_schema", SettingsSchema(can)}}})},
            {"abi_match", abi_match}};
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
