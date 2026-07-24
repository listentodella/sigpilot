#include <dlfcn.h>

#include <algorithm>
#include <chrono>
#include <cmath>
#include <cstring>
#include <cstdint>
#include <cstdlib>
#include <filesystem>
#include <fstream>
#include <iostream>
#include <map>
#include <nlohmann/json.hpp>
#include <optional>
#include <sstream>
#include <stdexcept>
#include <string>
#include <thread>
#include <vector>

#include <spawn.h>
#include <sys/wait.h>
#include <unistd.h>

extern char** environ;

namespace fs = std::filesystem;
using Json = nlohmann::json;

namespace
{

struct RuntimePaths
{
    fs::path root;
    fs::path analyzer_library;
    fs::path graph_library;
    fs::path python_home;
};

std::string JsonEscape(const std::string& value)
{
    std::ostringstream output;
    for (const unsigned char character : value) {
        switch (character) {
        case '\\': output << "\\\\"; break;
        case '"': output << "\\\""; break;
        case '\n': output << "\\n"; break;
        case '\r': output << "\\r"; break;
        case '\t': output << "\\t"; break;
        default:
            if (character < 0x20) {
                output << "?";
            } else {
                output << character;
            }
        }
    }
    return output.str();
}

RuntimePaths ValidateRuntimeRoot(const fs::path& root)
{
    RuntimePaths paths{
        root,
        root / "libAnalyzer.dylib",
        root / "libgraph_server_shared.dylib",
        root / "pythonlibs",
    };
    if (!fs::is_regular_file(paths.analyzer_library) || !fs::is_regular_file(paths.graph_library) ||
        !fs::is_directory(paths.python_home)) {
        throw std::runtime_error(
            "Saleae runtime root must contain libAnalyzer.dylib, libgraph_server_shared.dylib, and pythonlibs: " +
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
        if (fs::is_regular_file(candidate / "libgraph_server_shared.dylib")) {
            return ValidateRuntimeRoot(candidate);
        }
    }
    throw std::runtime_error(
        "Saleae Logic runtime was not found; pass --runtime-root or PXLOGIC_SALEAE_RUNTIME_ROOT");
}

class GraphRuntime
{
  public:
    explicit GraphRuntime(const RuntimePaths& paths)
    {
        if (setenv("SALEAE_PYTHONHOME", paths.python_home.c_str(), 1) != 0) {
            throw std::runtime_error("failed to set SALEAE_PYTHONHOME");
        }

        // The GraphServer bundle supplies the private Saleae C++ runtime symbols
        // required by libAnalyzer. Loading libAnalyzer first leaves those
        // symbols unresolved, so let dyld load both in dependency order.
        graph_handle_ = dlopen(paths.graph_library.c_str(), RTLD_NOW | RTLD_GLOBAL);
        if (graph_handle_ == nullptr) {
            throw std::runtime_error("dlopen libgraph_server_shared.dylib failed: " + std::string(dlerror()));
        }
        analyzer_handle_ = dlopen(paths.analyzer_library.c_str(), RTLD_NOW | RTLD_GLOBAL);
        if (analyzer_handle_ == nullptr) {
            throw std::runtime_error("dlopen libAnalyzer.dylib failed: " + std::string(dlerror()));
        }

        create_ = Load<CreateGraphServer>("CreateGraphServer");
        destroy_ = Load<DestroyGraphServer>("DestroyGraphServer");
        drive_ = Load<DriveRequest>("DriveRequest");
        pop_ = Load<PopResponse>("PopResponse");
        queue_size_ = Load<ResponseQueueSize>("ResponseQueueSize");
        free_response_ = Load<FreeResponseBuffer>("FreeResponseBuffer");
        set_log_file_name_ = Load<SetLogFileName>("SetLogFileName");
        flush_log_ = Load<FlushLog>("FlushLog");

        // The original direct graph-interface addon uses a null port pointer.
        // A live int pointer selects the separate WebSocket server mode, whose
        // event loop does not consume DriveRequest calls from this process.
        const fs::path log_file = fs::temp_directory_path() / "pxlogic-saleae-graph-sidecar.log";
        set_log_file_name_(log_file.c_str());
        server_ = create_(nullptr, 100, false);
        if (server_ == nullptr) {
            throw std::runtime_error("CreateGraphServer returned null");
        }
    }

    ~GraphRuntime()
    {
        // Logic 2.4.43 can leave an ExportNode worker holding a private
        // mutex after DeleteGraphData has replied. Calling DestroyGraphServer
        // at that point throws `mutex lock failed: Invalid argument`. The
        // sidecar is intentionally one-shot, so let the OS reclaim the graph
        // and its dylibs with the process. This keeps the failure isolated
        // from Tauri and matches the original Electron process boundary.
        server_ = nullptr;
        graph_handle_ = nullptr;
        analyzer_handle_ = nullptr;
    }

    GraphRuntime(const GraphRuntime&) = delete;
    GraphRuntime& operator=(const GraphRuntime&) = delete;

    void Drive(const std::string& request)
    {
        drive_(server_, request.data(), request.size());
    }

    std::size_t QueueSize() const
    {
        return queue_size_(server_);
    }

    bool Pop(std::string& response)
    {
        char* buffer = nullptr;
        std::size_t size = 0;
        if (!pop_(server_, &buffer, &size, &NoopNotify, nullptr)) {
            return false;
        }
        response.assign(buffer, size);
        free_response_(buffer);
        return true;
    }

    void Abandon()
    {
        server_ = nullptr;
        graph_handle_ = nullptr;
        analyzer_handle_ = nullptr;
    }

  private:
    using CreateGraphServer = void* (*)(std::int32_t*, std::int32_t, bool);
    using DestroyGraphServer = void (*)(void*);
    using DriveRequest = void (*)(void*, const char*, std::size_t);
    using PopResponse = bool (*)(void*, char**, std::size_t*, void (*)(void*), void*);
    using ResponseQueueSize = std::uint32_t (*)(void*);
    using FreeResponseBuffer = void (*)(char*);
    using SetLogFileName = void (*)(const char*);
    using FlushLog = void (*)();

    static void NoopNotify(void*) {}

    template <typename Function>
    Function Load(const char* symbol)
    {
        dlerror();
        auto* address = dlsym(graph_handle_, symbol);
        if (const char* error = dlerror()) {
            throw std::runtime_error(std::string("dlsym ") + symbol + " failed: " + error);
        }
        return reinterpret_cast<Function>(address);
    }

    void* analyzer_handle_ = nullptr;
    void* graph_handle_ = nullptr;
    void* server_ = nullptr;
    CreateGraphServer create_ = nullptr;
    DestroyGraphServer destroy_ = nullptr;
    DriveRequest drive_ = nullptr;
    PopResponse pop_ = nullptr;
    ResponseQueueSize queue_size_ = nullptr;
    FreeResponseBuffer free_response_ = nullptr;
    SetLogFileName set_log_file_name_ = nullptr;
    FlushLog flush_log_ = nullptr;
};

void RelayRequest(GraphRuntime& graph, const std::string& request)
{
    graph.Drive(request);

    const auto deadline = std::chrono::steady_clock::now() + std::chrono::seconds(60);
    auto quiet_deadline = std::chrono::steady_clock::time_point::max();
    bool received = false;
    while (std::chrono::steady_clock::now() < deadline) {
        std::string response;
        while (graph.Pop(response)) {
            received = true;
            quiet_deadline = std::chrono::steady_clock::now() + std::chrono::milliseconds(150);
            std::cout << response << '\n';
        }
        if (received && std::chrono::steady_clock::now() >= quiet_deadline) {
            return;
        }
        std::this_thread::sleep_for(std::chrono::milliseconds(2));
    }
    throw std::runtime_error("timed out waiting for a GraphServer response");
}

std::vector<Json> CollectResponses(GraphRuntime& graph, std::chrono::milliseconds quiet_time)
{
    std::vector<Json> responses;
    const auto deadline = std::chrono::steady_clock::now() + std::chrono::seconds(60);
    auto quiet_deadline = std::chrono::steady_clock::time_point::max();
    while (std::chrono::steady_clock::now() < deadline) {
        std::string response;
        while (graph.Pop(response)) {
            try {
                responses.push_back(Json::parse(response));
            } catch (const Json::parse_error&) {
                // GraphServer logs are written to stdout by the private
                // runtime. They are not protocol responses.
            }
            quiet_deadline = std::chrono::steady_clock::now() + quiet_time;
        }
        if (!responses.empty() && std::chrono::steady_clock::now() >= quiet_deadline) {
            return responses;
        }
        std::this_thread::sleep_for(std::chrono::milliseconds(2));
    }
    throw std::runtime_error("timed out waiting for GraphServer responses");
}

Json GraphRequest(int id, const std::string& type, const Json& contents, std::int32_t session_id)
{
    Json request = contents;
    request["id"] = id;
    request["type"] = type;
    request["meta"] = Json{{"sessionId", session_id}, {"destination", "GraphServer"}};
    return Json{{"type", "request"}, {"contents", request}};
}

void WaitForRequest(GraphRuntime& graph, const Json& request, int request_id)
{
    graph.Drive(request.dump());
    const auto deadline = std::chrono::steady_clock::now() + std::chrono::seconds(60);
    while (std::chrono::steady_clock::now() < deadline) {
        std::string response;
        while (graph.Pop(response)) {
            Json parsed;
            try {
                parsed = Json::parse(response);
            } catch (const Json::parse_error&) {
                continue;
            }
            if (!parsed.contains("contents")) {
                continue;
            }
            const Json& contents = parsed["contents"];
            if (!contents.contains("id") || contents["id"].get<int>() != request_id) {
                continue;
            }
            if (parsed.value("type", "") == "error") {
                throw std::runtime_error(contents.value("message", "GraphServer request failed"));
            }
            return;
        }
        std::this_thread::sleep_for(std::chrono::milliseconds(2));
    }
    throw std::runtime_error("timed out waiting for GraphServer request response");
}

struct SaleaeStore {
    std::uint8_t channel = 0;
    std::int32_t node_id = 0;
    fs::path source_file;
    fs::path exported_file;
    Json processed_begin;
    Json processed_end;
    std::uint64_t sample_rate_hz = 0;
    bool deserialization_complete = false;
    bool initial_high = false;
};

struct SaleaeExportChannel {
    std::uint8_t channel = 0;
    std::int32_t node_id = 0;
    std::string label;
    bool initial_high = false;
    std::vector<std::uint64_t> transitions;
    fs::path seed_file;
    fs::path serialized_file;
    bool serialization_complete = false;
};

struct SaleaeExportCapture {
    std::string name;
    std::string source_device;
    std::uint64_t sample_rate_hz = 0;
    std::uint8_t channel_count = 0;
    std::uint64_t sample_count = 0;
    std::int64_t captured_at_unix_milliseconds = 0;
    std::vector<SaleaeExportChannel> channels;
};

Json ReadJsonFile(const fs::path& path)
{
    std::ifstream input(path);
    if (!input) {
        throw std::runtime_error("failed to open JSON file: " + path.string());
    }
    Json value;
    input >> value;
    return value;
}

bool ReadSaleaeInitialState(const fs::path& path)
{
    std::ifstream input(path, std::ios::binary);
    char header[43] = {};
    if (!input.read(header, sizeof(header)) || std::string(header, 8) != "<SALEAE>") {
        throw std::runtime_error("invalid Saleae DigitalStore header: " + path.string());
    }
    const std::uint32_t version = static_cast<std::uint8_t>(header[8]) |
                                  (static_cast<std::uint32_t>(static_cast<std::uint8_t>(header[9])) << 8) |
                                  (static_cast<std::uint32_t>(static_cast<std::uint8_t>(header[10])) << 16) |
                                  (static_cast<std::uint32_t>(static_cast<std::uint8_t>(header[11])) << 24);
    if (version < 1 || version > 3) {
        throw std::runtime_error("unsupported Saleae DigitalStore version " + std::to_string(version));
    }
    return header[42] != 0;
}

std::vector<std::uint64_t> ReadTransitionIndexes(const fs::path& path, std::uint64_t sample_count)
{
    const std::uintmax_t byte_count = fs::file_size(path);
    if (byte_count % sizeof(std::uint64_t) != 0 || byte_count / sizeof(std::uint64_t) > SIZE_MAX) {
        throw std::runtime_error("invalid transition index file length: " + path.string());
    }
    std::ifstream input(path, std::ios::binary);
    if (!input) {
        throw std::runtime_error("failed to open transition index file: " + path.string());
    }
    std::vector<std::uint64_t> transitions(static_cast<std::size_t>(byte_count / sizeof(std::uint64_t)));
    for (std::uint64_t& transition : transitions) {
        if (!input.read(reinterpret_cast<char*>(&transition), sizeof(transition))) {
            throw std::runtime_error("failed to read transition index file: " + path.string());
        }
    }
    if (std::any_of(transitions.begin(), transitions.end(), [sample_count](std::uint64_t transition) {
            return transition >= sample_count;
        }) ||
        std::adjacent_find(transitions.begin(), transitions.end(), std::greater_equal<std::uint64_t>()) !=
            transitions.end()) {
        throw std::runtime_error("transition indexes must be strictly increasing and inside the capture: " +
                                 path.string());
    }
    return transitions;
}

SaleaeExportCapture ReadSaleaeExportManifest(const fs::path& path)
{
    const Json manifest = ReadJsonFile(path);
    if (manifest.value("format", "") != "pxlogic.saleae-export.v1") {
        throw std::runtime_error("unsupported Saleae export manifest format");
    }
    SaleaeExportCapture capture{
        manifest.value("name", "PXLogic Capture"),
        manifest.value("source_device", "PXLogic"),
        manifest.value("sample_rate_hz", std::uint64_t{0}),
        static_cast<std::uint8_t>(manifest.value("channel_count", 0)),
        manifest.value("sample_count", std::uint64_t{0}),
        manifest.value("captured_at_unix_milliseconds", std::int64_t{0}),
        {},
    };
    if (capture.sample_rate_hz == 0 || capture.sample_count == 0 || capture.channel_count == 0 ||
        capture.channel_count > 32 || !manifest.contains("channels") || !manifest["channels"].is_array()) {
        throw std::runtime_error("Saleae export manifest metadata is invalid");
    }

    const fs::path directory = path.parent_path();
    for (const Json& channel_json : manifest["channels"]) {
        const int channel = channel_json.value("channel", -1);
        const std::string relative_file = channel_json.value("transitions_file", "");
        if (channel < 0 || channel >= capture.channel_count || relative_file.empty()) {
            throw std::runtime_error("Saleae export manifest contains an invalid channel");
        }
        fs::path transition_file = directory / fs::path(relative_file).lexically_normal();
        if (!fs::is_regular_file(transition_file)) {
            throw std::runtime_error("Saleae export transition file is missing: " + transition_file.string());
        }
        SaleaeExportChannel export_channel{
            static_cast<std::uint8_t>(channel),
            static_cast<std::int32_t>(10000 + channel),
            channel_json.value("label", "D" + std::to_string(channel)),
            channel_json.value("initial_high", false),
            ReadTransitionIndexes(transition_file, capture.sample_count),
            {},
            {},
        };
        if (!export_channel.transitions.empty() && export_channel.transitions.front() == 0) {
            export_channel.initial_high = !export_channel.initial_high;
            export_channel.transitions.erase(export_channel.transitions.begin());
        }
        capture.channels.push_back(std::move(export_channel));
    }
    std::sort(capture.channels.begin(), capture.channels.end(), [](const auto& left, const auto& right) {
        return left.channel < right.channel;
    });
    if (capture.channels.empty() ||
        std::adjacent_find(capture.channels.begin(), capture.channels.end(), [](const auto& left, const auto& right) {
            return left.channel == right.channel;
        }) != capture.channels.end()) {
        throw std::runtime_error("Saleae export manifest has no channels or duplicate channels");
    }
    return capture;
}

void WriteU32(std::ostream& output, std::uint32_t value)
{
    output.write(reinterpret_cast<const char*>(&value), sizeof(value));
}

void WriteU64(std::ostream& output, std::uint64_t value)
{
    output.write(reinterpret_cast<const char*>(&value), sizeof(value));
}

void WriteI64(std::ostream& output, std::int64_t value)
{
    output.write(reinterpret_cast<const char*>(&value), sizeof(value));
}

void WriteF64(std::ostream& output, double value)
{
    output.write(reinterpret_cast<const char*>(&value), sizeof(value));
}

double GraphTimeSeconds(const Json& time)
{
    return time.value("unixTimeMilliseconds", 0.0) / 1000.0 +
           time.value("fractionalMilliseconds", 0.0) / 1000.0;
}

double ReadCaptureDuration(const Json& meta)
{
    if (!meta.contains("data")) {
        return 0.0;
    }
    const Json& data = meta["data"];
    if (data.contains("captureProgress")) {
        const Json& progress = data["captureProgress"];
        const double maximum = progress.value("maxCollectedTime", 0.0);
        if (maximum > 0.0 && std::isfinite(maximum)) {
            return maximum;
        }
        if (progress.contains("processedInterval")) {
            const Json& interval = progress["processedInterval"];
            const double duration = interval.value("end", 0.0) - interval.value("begin", 0.0);
            if (duration > 0.0 && std::isfinite(duration)) {
                return duration;
            }
        }
    }
    return 0.0;
}

void WriteConstantSaleaeBinary(const fs::path& path, bool initial_high, double duration_seconds)
{
    std::ofstream output(path, std::ios::binary);
    if (!output) {
        throw std::runtime_error("failed to create constant Saleae digital binary: " + path.string());
    }
    output.write("<SALEAE>", 8);
    WriteU32(output, 0);
    WriteU32(output, 0);
    WriteU32(output, initial_high ? 1 : 0);
    WriteF64(output, 0.0);
    WriteF64(output, duration_seconds);
    WriteU64(output, 0);
    if (!output) {
        throw std::runtime_error("failed while writing constant Saleae digital binary: " + path.string());
    }
}

std::vector<std::uint8_t> EncodeSaleaeRun(std::uint64_t run_length)
{
    if (run_length == 0) {
        throw std::runtime_error("Saleae RLE run length cannot be zero");
    }
    std::uint64_t value = run_length - 1;
    std::vector<std::uint8_t> groups;
    do {
        groups.push_back(static_cast<std::uint8_t>(value & 0x7f));
        value >>= 7;
    } while (value != 0);
    std::reverse(groups.begin(), groups.end());
    if (groups.front() > 0x3f) {
        groups.insert(groups.begin(), 0);
    }
    if (groups.size() == 1) {
        return groups;
    }
    groups.front() |= 0x40;
    for (std::size_t index = 1; index + 1 < groups.size(); ++index) {
        groups[index] |= 0x80;
    }
    return groups;
}

struct SaleaeRecord {
    std::uint64_t begin = 0;
    std::uint64_t end = 0;
};

std::vector<SaleaeRecord> BuildSaleaeRecords(const std::vector<std::uint64_t>& transitions,
                                             std::uint64_t sample_count)
{
    constexpr std::uint64_t maximum_span = 2'796'192;
    constexpr std::size_t maximum_internal_transitions = 63;
    std::vector<SaleaeRecord> records;
    std::uint64_t begin = 0;
    while (begin < sample_count) {
        std::uint64_t target = begin + std::min(maximum_span, sample_count - begin);
        const auto first = std::upper_bound(transitions.begin(), transitions.end(), begin);
        if (static_cast<std::size_t>(transitions.end() - first) > maximum_internal_transitions) {
            const std::uint64_t run_limit = first[maximum_internal_transitions];
            target = std::min(target, run_limit);
        }

        std::uint64_t end = target;
        if (target < sample_count) {
            const std::size_t transition_count = static_cast<std::size_t>(
                std::upper_bound(transitions.begin(), transitions.end(), target) - transitions.begin());
            if (transition_count % 2 != 0) {
                const bool has_previous_return = transition_count >= 2 && transitions[transition_count - 2] > begin;
                if (has_previous_return) {
                    end = transitions[transition_count - 2];
                } else if (transition_count < transitions.size()) {
                    end = transitions[transition_count];
                } else {
                    end = sample_count;
                }
            }
        }
        if (end <= begin) {
            throw std::runtime_error("could not find a Saleae RLE record boundary at the initial signal level");
        }
        records.push_back({begin, end});
        begin = end;
    }
    return records;
}

void WriteSaleaeSeedStore(const fs::path& path, const SaleaeExportCapture& capture,
                          const SaleaeExportChannel& channel)
{
    const std::vector<SaleaeRecord> records = BuildSaleaeRecords(channel.transitions, capture.sample_count);
    std::ofstream output(path, std::ios::binary);
    if (!output) {
        throw std::runtime_error("failed to create Saleae seed store: " + path.string());
    }
    output.write("<SALEAE>", 8);
    WriteU32(output, 1);
    WriteU32(output, 100);
    output.put(1);
    WriteF64(output, static_cast<double>(capture.sample_rate_hz));
    WriteI64(output, capture.captured_at_unix_milliseconds);
    WriteF64(output, 0.0);
    output.put(0);
    output.put(channel.initial_high ? 1 : 0);
    WriteU64(output, records.size());

    for (const SaleaeRecord& record : records) {
        std::vector<std::uint8_t> rle;
        std::uint64_t run_begin = record.begin;
        auto transition = std::upper_bound(channel.transitions.begin(), channel.transitions.end(), record.begin);
        const auto transition_end = std::lower_bound(channel.transitions.begin(), channel.transitions.end(), record.end);
        for (; transition != transition_end; ++transition) {
            const auto encoded = EncodeSaleaeRun(*transition - run_begin);
            rle.insert(rle.end(), encoded.begin(), encoded.end());
            run_begin = *transition;
        }
        const auto encoded = EncodeSaleaeRun(record.end - run_begin);
        rle.insert(rle.end(), encoded.begin(), encoded.end());

        WriteU64(output, record.begin);
        WriteU64(output, record.end);
        WriteU64(output, record.end - record.begin);
        WriteU64(output, capture.sample_rate_hz);
        WriteU64(output, 1);
        WriteU64(output, rle.size());
        output.write(reinterpret_cast<const char*>(rle.data()), static_cast<std::streamsize>(rle.size()));
        WriteU64(output, 1);
        const char metadata[20] = {};
        output.write(metadata, sizeof(metadata));
    }
    if (!output) {
        throw std::runtime_error("failed while writing Saleae seed store: " + path.string());
    }
}

void RunDittoExtract(const fs::path& archive, const fs::path& destination)
{
    fs::create_directories(destination);
    std::string archive_string = archive.string();
    std::string destination_string = destination.string();
    char* arguments[] = {
        const_cast<char*>("/usr/bin/ditto"),
        const_cast<char*>("-x"),
        const_cast<char*>("-k"),
        archive_string.data(),
        destination_string.data(),
        nullptr,
    };
    pid_t child = 0;
    const int spawn_error = posix_spawn(&child, "/usr/bin/ditto", nullptr, nullptr, arguments, environ);
    if (spawn_error != 0) {
        throw std::runtime_error("failed to start /usr/bin/ditto: " + std::to_string(spawn_error));
    }
    int status = 0;
    if (waitpid(child, &status, 0) < 0 || !WIFEXITED(status) || WEXITSTATUS(status) != 0) {
        throw std::runtime_error("ditto could not extract the Saleae capture: " + archive.string());
    }
}

std::vector<SaleaeStore> ReadSaleaeStores(const fs::path& extracted, const Json& meta)
{
    if (!meta.contains("binData") || !meta["binData"].is_array()) {
        throw std::runtime_error(".sal meta.json does not contain binData");
    }
    std::vector<SaleaeStore> stores;
    for (const Json& entry : meta["binData"]) {
        if (entry.value("category", "") != "legacy" || entry.value("type", "") != "Digital") {
            continue;
        }
        const int channel = entry.value("deviceChannel", -1);
        const std::string relative = entry.value("file", "");
        if (channel < 0 || channel > 31 || relative.empty()) {
            continue;
        }
        fs::path source = extracted / fs::path(relative).lexically_normal();
        if (!fs::is_regular_file(source)) {
            throw std::runtime_error(".sal digital store is missing: " + source.string());
        }
        stores.push_back(SaleaeStore{
            static_cast<std::uint8_t>(channel),
            static_cast<std::int32_t>(10000 + channel),
            source,
            {},
            {},
            {},
            0,
            false,
            ReadSaleaeInitialState(source),
        });
    }
    std::sort(stores.begin(), stores.end(), [](const SaleaeStore& left, const SaleaeStore& right) {
        return left.channel < right.channel;
    });
    if (stores.empty()) {
        throw std::runtime_error(".sal capture has no legacy digital channels");
    }
    return stores;
}

std::uint8_t ReadSaleaeChannelCount(const Json& meta, const std::vector<SaleaeStore>& stores)
{
    int maximum_channel = stores.back().channel;
    if (meta.contains("data") && meta["data"].contains("rowsSettings")) {
        for (const Json& row : meta["data"]["rowsSettings"]) {
            const Json channel = row.value("channel", Json::object());
            if (channel.value("type", "") == "Digital" && channel.value("category", "") == "legacy") {
                maximum_channel = std::max(maximum_channel, channel.value("deviceChannel", maximum_channel));
            }
        }
    }
    return static_cast<std::uint8_t>(std::clamp(maximum_channel + 1, 1, 32));
}

bool UpdateStoresFromGraphState(std::vector<SaleaeStore>& stores, const Json& response)
{
    if (!response.contains("contents")) {
        return false;
    }
    const Json& contents = response["contents"];
    if (contents.value("type", "") != "Saleae::GraphState2Data" || !contents.contains("state")) {
        return false;
    }
    const Json& state = contents["state"];
    for (SaleaeStore& store : stores) {
        const std::string key = std::to_string(store.node_id);
        if (!state.contains(key)) {
            continue;
        }
        const Json& node_state = state[key].at("state");
        const Json& status = node_state.at("serializationStatus");
        const std::string mode = status.value("mode", "");
        if (mode == "DeserializationErrored") {
            throw std::runtime_error("Saleae DigitalStore failed to deserialize " + store.source_file.string());
        }
        store.deserialization_complete = mode == "DeserializationComplete";
        if (node_state.contains("processedInterval")) {
            store.processed_begin = node_state["processedInterval"].at("begin");
            store.processed_end = node_state["processedInterval"].at("end");
        }
        if (node_state.contains("samplingConfiguration")) {
            const double rate = node_state["samplingConfiguration"].value("sampleRate", 0.0);
            if (rate > 0.0) {
                store.sample_rate_hz = static_cast<std::uint64_t>(rate);
            }
        }
    }
    return std::all_of(stores.begin(), stores.end(), [](const SaleaeStore& store) {
        return store.deserialization_complete;
    });
}

void WaitForDeserialization(GraphRuntime& graph, std::vector<SaleaeStore>& stores, const Json& request)
{
    graph.Drive(request.dump());
    const auto deadline = std::chrono::steady_clock::now() + std::chrono::minutes(15);
    while (std::chrono::steady_clock::now() < deadline) {
        bool complete = false;
        std::string response;
        while (graph.Pop(response)) {
            try {
                complete = UpdateStoresFromGraphState(stores, Json::parse(response)) || complete;
            } catch (const Json::parse_error&) {
                continue;
            }
        }
        if (complete) {
            return;
        }
        std::this_thread::sleep_for(std::chrono::milliseconds(10));
    }
    throw std::runtime_error("timed out waiting for Saleae DigitalStore deserialization");
}

bool UpdateExportState(const Json& response, std::string& error)
{
    if (!response.contains("contents")) {
        return false;
    }
    const Json& contents = response["contents"];
    if (contents.value("type", "") != "Saleae::GraphState2Data" || !contents.contains("state")) {
        return false;
    }
    const Json& state = contents["state"];
    if (!state.contains("200")) {
        return false;
    }
    const Json& export_state = state["200"].at("state");
    error = export_state.value("errorMessage", "");
    return export_state.value("status", "") == "Idle" && export_state.value("exportProgress", 0.0) >= 1.0;
}

void WaitForExport(GraphRuntime& graph, const Json& request)
{
    WaitForRequest(graph, request, request.at("contents").at("id").get<int>());
    const auto deadline = std::chrono::steady_clock::now() + std::chrono::minutes(15);
    std::string error;
    while (std::chrono::steady_clock::now() < deadline) {
        std::string response;
        while (graph.Pop(response)) {
            try {
                if (UpdateExportState(Json::parse(response), error)) {
                    if (!error.empty()) {
                        throw std::runtime_error("Saleae export failed: " + error);
                    }
                    return;
                }
            } catch (const Json::parse_error&) {
                continue;
            }
        }
        std::this_thread::sleep_for(std::chrono::milliseconds(10));
    }
    throw std::runtime_error("timed out waiting for Saleae binary export");
}

bool UpdateSerializationState(const Json& response, std::vector<SaleaeExportChannel>& channels,
                              std::string& error)
{
    if (!response.contains("contents")) {
        return false;
    }
    const Json& contents = response["contents"];
    if (contents.value("type", "") != "Saleae::GraphState2Data" || !contents.contains("state")) {
        return false;
    }
    const Json& state = contents["state"];
    for (SaleaeExportChannel& channel : channels) {
        const std::string key = std::to_string(channel.node_id);
        if (!state.contains(key)) {
            continue;
        }
        const Json& node_state = state[key].at("state");
        if (!node_state.contains("serializationStatus")) {
            continue;
        }
        const Json& status = node_state["serializationStatus"];
        const std::string mode = status.value("mode", "");
        error = status.value("errorMessage", "");
        if (mode == "SerializationErrored") {
            throw std::runtime_error("Saleae DigitalStore serialization failed for D" +
                                     std::to_string(channel.channel) +
                                     (error.empty() ? "" : ": " + error));
        }
        channel.serialization_complete = mode == "SerializationComplete";
    }
    return std::all_of(channels.begin(), channels.end(), [](const SaleaeExportChannel& channel) {
        return channel.serialization_complete;
    });
}

void WaitForSerialization(GraphRuntime& graph, std::vector<SaleaeExportChannel>& channels,
                           const Json& request)
{
    graph.Drive(request.dump());
    const auto deadline = std::chrono::steady_clock::now() + std::chrono::minutes(15);
    std::string error;
    while (std::chrono::steady_clock::now() < deadline) {
        bool complete = false;
        std::string response;
        while (graph.Pop(response)) {
            try {
                complete = UpdateSerializationState(Json::parse(response), channels, error) || complete;
            } catch (const Json::parse_error&) {
                continue;
            }
        }
        if (complete) {
            return;
        }
        std::this_thread::sleep_for(std::chrono::milliseconds(10));
    }
    throw std::runtime_error("timed out waiting for Saleae DigitalStore serialization");
}

Json RenderSaleaeMeta(const SaleaeExportCapture& capture)
{
    const double duration_seconds = static_cast<double>(capture.sample_count) /
                                    static_cast<double>(capture.sample_rate_hz);
    const Json graph_time{{"unixTimeMilliseconds", capture.captured_at_unix_milliseconds},
                          {"fractionalMilliseconds", 0.0}};
    Json rows = Json::array();
    for (std::uint8_t channel = 0; channel < capture.channel_count; ++channel) {
        const auto captured_channel = std::find_if(
            capture.channels.begin(), capture.channels.end(), [channel](const SaleaeExportChannel& candidate) {
                return candidate.channel == channel;
            });
        const std::string label = captured_channel == capture.channels.end()
                                      ? "D" + std::to_string(channel)
                                      : captured_channel->label;
        rows.push_back({
            {"id", "pxlogic-channel-" + std::to_string(channel)},
            {"height", 100},
            {"isMarkedHidden", false},
            {"type", "channel"},
            {"name", label},
            {"channel", Json{{"category", "legacy"}, {"type", "Digital"}, {"deviceChannel", channel}}},
        });
    }

    Json capabilities = Json{{"channelCapabilities", Json::array()},
                             {"sampleRateOptions", Json::array({Json{{"digital", capture.sample_rate_hz}}})},
                             {"digitalThresholdOptions", Json::array({Json{{"description", "1.2 Volts"}},
                                                                         Json{{"description", "1.8 Volts"}},
                                                                         Json{{"description", "3.3+ Volts"}}})},
                             {"isPhysicalDevice", false}};
    for (std::uint8_t channel = 0; channel < capture.channel_count; ++channel) {
        capabilities["channelCapabilities"].push_back(
            Json{{"type", "Digital"}, {"index", channel}, {"capability", "Toggleable"}});
    }

    Json enabled_channels = Json::array();
    for (const SaleaeExportChannel& channel : capture.channels) {
        enabled_channels.push_back(Json{{"type", "Digital"}, {"index", channel.channel}});
    }
    const Json connected_device{
        {"name", "PXLogic"},
        {"deviceId", "pxlogic-export"},
        {"deviceType", capture.channel_count <= 8 ? "LogicPro8" : "LogicPro16"},
        {"isSimulation", true},
        {"capabilities", capabilities},
        {"settings", Json{{"enabledChannels", enabled_channels},
                           {"sampleRate", Json{{"digital", capture.sample_rate_hz}}},
                           {"digitalThreshold", Json{{"description", "3.3+ Volts"}}}}},
    };
    const Json capture_settings{
        {"bufferSizeMb", 3072},
        {"captureMode", "Circular"},
        {"stopAfterSeconds", duration_seconds},
        {"trimAfterCapture", false},
        {"trimTimeSeconds", 5},
        {"digitalTriggerSettings",
         Json{{"type", Json{{"mode", "Edge"}, {"name", "Rising"}, {"pattern", "Rising"}}},
              {"timeAfterTriggerToStop", 1},
              {"linkedChannels", Json::array()},
              {"duration", Json{{"min", 0.001}, {"max", 0.01}}}}},
        {"glitchFilter", Json{{"enabled", false}, {"channels", Json::array()}}},
        {"connectedDevice", connected_device},
    };
    const Json columns{
        {"analyzerIdentifier", Json{{"isActive", true},
                                     {"width", 18},
                                     {"isDefault", true},
                                     {"baseKey", "analyzerIdentifier"},
                                     {"excludeFromSearch", true}}},
        {"frameType", Json{{"isActive", true},
                            {"width", 75},
                            {"isDefault", true},
                            {"baseKey", "frameType"},
                            {"excludeFromSearch", false}}},
        {"start", Json{{"isActive", true},
                        {"width", 110},
                        {"isDefault", true},
                        {"baseKey", "start"},
                        {"excludeFromSearch", true}}},
        {"duration", Json{{"isActive", true},
                           {"width", 80},
                           {"isDefault", true},
                           {"baseKey", "duration"},
                           {"excludeFromSearch", true}}},
    };
    const Json data{
        {"captureProgress", Json{{"maxCollectedTime", duration_seconds},
                                  {"processedInterval", Json{{"begin", 0.0}, {"end", duration_seconds}}},
                                  {"memoryUsedMb", 0.0},
                                  {"isProcessing", false}}},
        {"captureStartTime", graph_time},
        {"highLevelAnalyzers", Json::array()},
        {"measurements", Json::array()},
        {"timingMarkers", Json{{"markers", Json::object()}, {"pairs", Json::object()}}},
        {"renderViewState", Json{{"leftEdgeTimeSec", 0.0},
                                  {"timeSecPerPixel", duration_seconds / 1200.0},
                                  {"navigationViewMode", "Timeline"}}},
        {"analyzers", Json::array()},
        {"rowsSettings", rows},
        {"captureSettings", capture_settings},
        {"digitalTriggerTime", -1},
        {"name", capture.name},
        {"dataTable", Json{{"columns", columns}}},
        {"analyzerTrigger",
         Json{{"settings", Json{{"enabled", false}, {"searchQuery", ""}, {"holdoffSeconds", 0.2}}}}},
        {"timeManager", Json{{"t0", Json{{"type", "startOfCapture"}}}}},
        {"captureNotes", ""},
    };

    Json bin_data = Json::array();
    for (const SaleaeExportChannel& channel : capture.channels) {
        bin_data.push_back({{"category", "legacy"},
                            {"type", "Digital"},
                            {"deviceChannel", channel.channel},
                            {"file", "./digital-" + std::to_string(channel.channel) + ".bin"}});
    }
    return Json{{"version", 16}, {"data", data}, {"binData", bin_data}};
}

void WriteSaleaeMeta(const fs::path& path, const SaleaeExportCapture& capture)
{
    std::ofstream output(path);
    if (!output) {
        throw std::runtime_error("failed to create Saleae meta.json: " + path.string());
    }
    output << RenderSaleaeMeta(capture).dump(2) << '\n';
}

void RunDittoCreate(const fs::path& source, const fs::path& archive)
{
    std::string source_string = source.string();
    std::string archive_string = archive.string();
    char* arguments[] = {
        const_cast<char*>("/usr/bin/ditto"),
        const_cast<char*>("-c"),
        const_cast<char*>("-k"),
        const_cast<char*>("--norsrc"),
        source_string.data(),
        archive_string.data(),
        nullptr,
    };
    pid_t child = 0;
    const int spawn_error = posix_spawn(&child, "/usr/bin/ditto", nullptr, nullptr, arguments, environ);
    if (spawn_error != 0) {
        throw std::runtime_error("failed to start /usr/bin/ditto for .sal export: " + std::to_string(spawn_error));
    }
    int status = 0;
    if (waitpid(child, &status, 0) < 0 || !WIFEXITED(status) || WEXITSTATUS(status) != 0) {
        throw std::runtime_error("ditto could not create the Saleae capture: " + archive.string());
    }
}

std::uint64_t SampleCountFromDuration(double duration_seconds, std::uint64_t sample_rate_hz)
{
    if (!(duration_seconds > 0.0) || sample_rate_hz == 0) {
        throw std::runtime_error("Saleae capture has invalid duration or sample rate");
    }
    const long double samples = static_cast<long double>(duration_seconds) * sample_rate_hz;
    if (samples > static_cast<long double>(UINT64_MAX)) {
        throw std::runtime_error("Saleae capture sample count exceeds uint64");
    }
    return static_cast<std::uint64_t>(samples + 0.5L);
}

double ReadSaleaeBinaryDuration(const fs::path& path)
{
    std::ifstream file(path, std::ios::binary);
    char magic[8] = {};
    double duration = 0.0;
    if (!file.read(magic, sizeof(magic)) || std::string(magic, sizeof(magic)) != "<SALEAE>" ||
        !file.seekg(28) || !file.read(reinterpret_cast<char*>(&duration), sizeof(duration)) || !(duration > 0.0)) {
        throw std::runtime_error("invalid Saleae digital binary export: " + path.string());
    }
    return duration;
}

void WriteSaleaeManifest(const fs::path& output, const fs::path& input, const std::vector<SaleaeStore>& stores,
                         std::uint8_t channel_count, double duration_seconds, std::uint64_t sample_rate_hz)
{
    Json manifest{
        {"format", "pxlogic.saleae-transition.v1"},
        {"source", input.filename().string()},
        {"sample_rate_hz", sample_rate_hz},
        {"channel_count", channel_count},
        {"duration_seconds", duration_seconds},
        {"sample_count", SampleCountFromDuration(duration_seconds, sample_rate_hz)},
        {"channels", Json::array()},
    };
    for (const SaleaeStore& store : stores) {
        manifest["channels"].push_back({
            {"channel", store.channel},
            {"file", store.exported_file.filename().string()},
        });
    }
    std::ofstream file(output / "manifest.json");
    if (!file) {
        throw std::runtime_error("failed to create Saleae transition manifest: " + (output / "manifest.json").string());
    }
    file << manifest.dump(2) << '\n';
}

void ConvertSal(GraphRuntime& graph, const fs::path& input, const fs::path& output)
{
    const fs::path extracted = fs::temp_directory_path() /
                               ("pxlogic-saleae-sal-" + std::to_string(static_cast<long long>(getpid())));
    RunDittoExtract(input, extracted);
    const Json meta = ReadJsonFile(extracted / "meta.json");
    std::vector<SaleaeStore> stores = ReadSaleaeStores(extracted, meta);
    const std::uint8_t channel_count = ReadSaleaeChannelCount(meta, stores);
    fs::create_directories(output);

    constexpr std::int32_t session_id = 1;
    WaitForRequest(graph, GraphRequest(1, "Saleae::Graph::GraphInitRequestData", Json{{"newSessionId", session_id}}, session_id), 1);

    Json add_actions = Json::array();
    for (const SaleaeStore& store : stores) {
        add_actions.push_back({
            {"type", "Saleae::Graph::GraphActions::AddNode"},
            {"id", store.node_id},
            {"name", "store-" + std::to_string(store.channel)},
            {"nodeType", "Saleae::Graph::DigitalStore"},
        });
    }
    WaitForRequest(graph, GraphRequest(2, "Saleae::Graph::GraphActionData",
                                       Json{{"runInParallel", false}, {"actions", add_actions}}, session_id), 2);
    WaitForRequest(graph, GraphRequest(3, "Saleae::Graph::GraphActionData",
                                       Json{{"runInParallel", false},
                                            {"actions", Json::array({Json{{"type", "Saleae::Graph::GraphActions::Start"}}})}},
                                       session_id),
                   3);

    Json deserialize_actions = Json::array();
    for (SaleaeStore& store : stores) {
        deserialize_actions.push_back({
            {"type", "Saleae::Graph::GraphActions::RouteAction"},
            {"nodeId", store.node_id},
            {"action", Json{{"type", "Saleae::Graph::NodeActions::StartDeserialization"},
                             {"path", store.source_file.string()}}},
        });
    }
    WaitForDeserialization(graph, stores,
                           GraphRequest(4, "Saleae::Graph::GraphActionData",
                                        Json{{"runInParallel", false}, {"actions", deserialize_actions}}, session_id));

    const std::uint64_t sample_rate = stores.front().sample_rate_hz;
    if (sample_rate == 0 || std::any_of(stores.begin(), stores.end(), [sample_rate](const SaleaeStore& store) {
            return store.sample_rate_hz != sample_rate;
        })) {
        throw std::runtime_error("Saleae DigitalStore did not report sampling metadata");
    }
    std::vector<SaleaeStore*> stores_with_data;
    for (SaleaeStore& store : stores) {
        store.exported_file = output / ("digital_" + std::to_string(store.channel) + ".bin");
        if (!store.processed_begin.is_null() && !store.processed_end.is_null() &&
            GraphTimeSeconds(store.processed_end) > GraphTimeSeconds(store.processed_begin)) {
            stores_with_data.push_back(&store);
        }
    }

    double exported_duration = 0.0;
    if (!stores_with_data.empty()) {
        Json export_setup = Json::array({Json{{"type", "Saleae::Graph::GraphActions::AddNode"},
                                              {"id", 200},
                                              {"name", "export"},
                                              {"nodeType", "Saleae::Graph::ExportNode"}}});
        Json digital_channels = Json::object();
        for (const SaleaeStore* store : stores_with_data) {
            export_setup.push_back({
                {"type", "Saleae::Graph::GraphActions::ConnectApi"},
                {"id", 300 + store->channel},
                {"connection", Json{{"fromNodeId", store->node_id}, {"toNodeId", 200}, {"toApiIndex", store->node_id}}},
            });
            digital_channels[std::to_string(store->node_id)] = {
                {"label", "D" + std::to_string(store->channel)},
                {"binaryFilepath", store->exported_file.string()},
            };
        }
        WaitForRequest(graph, GraphRequest(5, "Saleae::Graph::GraphActionData",
                                           Json{{"runInParallel", false}, {"actions", export_setup}}, session_id), 5);

        const Json begin = stores_with_data.front()->processed_begin;
        const Json end = stores_with_data.front()->processed_end;
        const Json export_action{
            {"type", "Saleae::Graph::ExportActions::ExportData"},
            {"graphInterval", Json{{"begin", begin}, {"end", end}}},
            {"digitalChannels", digital_channels},
            {"analogChannels", Json::object()},
            {"waveformChannels", Json::object()},
            {"digitalBinaryVersion", "Initial"},
            {"analogDownsample", 1},
            {"format", "Binary"},
            {"useWallClockTime", false},
            {"zeroTime", begin},
            {"analogCsvFilepath", (output / "analog.csv").string()},
            {"digitalCsvFilepath", (output / "digital.csv").string()},
            {"exportIntersectionOfData", true},
        };
        const Json export_request = GraphRequest(
            6, "Saleae::Graph::GraphActionData",
            Json{{"runInParallel", false},
                 {"actions", Json::array({Json{{"type", "Saleae::Graph::GraphActions::RouteAction"},
                                                {"nodeId", 200},
                                                {"action", export_action}}})}},
            session_id);
        WaitForExport(graph, export_request);
        exported_duration = ReadSaleaeBinaryDuration(stores_with_data.front()->exported_file);
    } else {
        exported_duration = ReadCaptureDuration(meta);
    }

    if (!(exported_duration > 0.0)) {
        throw std::runtime_error("Saleae capture metadata does not contain a usable duration");
    }
    for (SaleaeStore& store : stores) {
        if (std::find(stores_with_data.begin(), stores_with_data.end(), &store) == stores_with_data.end()) {
            WriteConstantSaleaeBinary(store.exported_file, store.initial_high, exported_duration);
        }
    }

    for (const SaleaeStore& store : stores) {
        if (!fs::is_regular_file(store.exported_file) || fs::file_size(store.exported_file) < 44) {
            throw std::runtime_error("Saleae export did not produce " + store.exported_file.string());
        }
    }
    WriteSaleaeManifest(output, input, stores, channel_count, exported_duration, sample_rate);

    // DeleteGraphData is the same cleanup request used by Logic 2. We still
    // abandon the native object after its reply because the private runtime's
    // destructor races an internal export worker on this SDK build.
    WaitForRequest(graph, GraphRequest(7, "Saleae::Graph::DeleteGraphData", Json::object(), session_id), 7);
    std::error_code cleanup_error;
    fs::remove_all(extracted, cleanup_error);
    graph.Abandon();
}

void CreateSal(GraphRuntime& graph, const fs::path& manifest_path, const fs::path& output)
{
    SaleaeExportCapture capture = ReadSaleaeExportManifest(manifest_path);
    const auto suffix = std::chrono::steady_clock::now().time_since_epoch().count();
    const fs::path work = fs::temp_directory_path() /
                          ("pxlogic-saleae-export-" + std::to_string(static_cast<long long>(getpid())) + "-" +
                           std::to_string(suffix));
    const fs::path seeds = work / "seeds";
    const fs::path staging = work / "capture";
    fs::create_directories(seeds);
    fs::create_directories(staging);

    try {
        for (SaleaeExportChannel& channel : capture.channels) {
            channel.seed_file = seeds / ("digital-" + std::to_string(channel.channel) + ".bin");
            channel.serialized_file = staging / ("digital-" + std::to_string(channel.channel) + ".bin");
            WriteSaleaeSeedStore(channel.seed_file, capture, channel);
        }

        constexpr std::int32_t session_id = 1;
        WaitForRequest(graph,
                       GraphRequest(101, "Saleae::Graph::GraphInitRequestData", Json{{"newSessionId", session_id}},
                                    session_id),
                       101);
        Json add_actions = Json::array();
        for (const SaleaeExportChannel& channel : capture.channels) {
            add_actions.push_back({
                {"type", "Saleae::Graph::GraphActions::AddNode"},
                {"id", channel.node_id},
                {"name", "store-" + std::to_string(channel.channel)},
                {"nodeType", "Saleae::Graph::DigitalStore"},
            });
        }
        WaitForRequest(graph, GraphRequest(102, "Saleae::Graph::GraphActionData",
                                           Json{{"runInParallel", false}, {"actions", add_actions}}, session_id),
                       102);
        WaitForRequest(graph,
                       GraphRequest(103, "Saleae::Graph::GraphActionData",
                                    Json{{"runInParallel", false},
                                         {"actions",
                                          Json::array({Json{{"type", "Saleae::Graph::GraphActions::Start"}}})}},
                                    session_id),
                       103);

        std::vector<SaleaeStore> stores;
        Json deserialize_actions = Json::array();
        for (const SaleaeExportChannel& channel : capture.channels) {
            stores.push_back(SaleaeStore{channel.channel, channel.node_id, channel.seed_file, {}, {}, {}, 0});
            deserialize_actions.push_back({
                {"type", "Saleae::Graph::GraphActions::RouteAction"},
                {"nodeId", channel.node_id},
                {"action", Json{{"type", "Saleae::Graph::NodeActions::StartDeserialization"},
                                 {"path", channel.seed_file.string()}}},
            });
        }
        WaitForDeserialization(graph, stores,
                               GraphRequest(104, "Saleae::Graph::GraphActionData",
                                            Json{{"runInParallel", false}, {"actions", deserialize_actions}},
                                            session_id));

        Json serialize_actions = Json::array();
        for (const SaleaeExportChannel& channel : capture.channels) {
            serialize_actions.push_back({
                {"type", "Saleae::Graph::GraphActions::RouteAction"},
                {"nodeId", channel.node_id},
                {"action", Json{{"type", "Saleae::Graph::NodeActions::StartSerialization"},
                                 {"path", channel.serialized_file.string()}}},
            });
        }
        WaitForSerialization(graph, capture.channels,
                             GraphRequest(105, "Saleae::Graph::GraphActionData",
                                          Json{{"runInParallel", false}, {"actions", serialize_actions}}, session_id));

        for (const SaleaeExportChannel& channel : capture.channels) {
            if (!fs::is_regular_file(channel.serialized_file) || fs::file_size(channel.serialized_file) < 8) {
                throw std::runtime_error("Saleae serialization did not produce " + channel.serialized_file.string());
            }
        }
        WriteSaleaeMeta(staging / "meta.json", capture);
        fs::create_directories(output.parent_path().empty() ? fs::path(".") : output.parent_path());
        RunDittoCreate(staging, output);
        if (!fs::is_regular_file(output) || fs::file_size(output) == 0) {
            throw std::runtime_error("Saleae archive was not created: " + output.string());
        }

        WaitForRequest(graph, GraphRequest(106, "Saleae::Graph::DeleteGraphData", Json::object(), session_id), 106);
        graph.Abandon();
        std::error_code cleanup_error;
        fs::remove_all(work, cleanup_error);
    } catch (...) {
        std::error_code cleanup_error;
        fs::remove_all(work, cleanup_error);
        throw;
    }
}

void Relay(GraphRuntime& graph)
{
    std::string request;
    bool received_request = false;
    while (std::getline(std::cin, request)) {
        if (request.empty()) {
            continue;
        }
        received_request = true;
        RelayRequest(graph, request);
    }
    if (!received_request) {
        throw std::runtime_error("relay request is empty");
    }
}

} // namespace

int main(int argc, char** argv)
{
    try {
        std::optional<fs::path> runtime_root;
        bool probe = false;
        bool relay = false;
        std::optional<fs::path> sal_input;
        std::optional<fs::path> sal_output;
        std::optional<fs::path> export_manifest;
        std::optional<fs::path> export_output;
        for (int index = 1; index < argc; ++index) {
            const std::string argument = argv[index];
            if (argument == "--runtime-root" && index + 1 < argc) {
                runtime_root = argv[++index];
            } else if (argument == "--probe") {
                probe = true;
            } else if (argument == "--relay") {
                relay = true;
            } else if (argument == "--convert-sal" && index + 2 < argc) {
                sal_input = argv[++index];
                sal_output = argv[++index];
            } else if (argument == "--create-sal" && index + 2 < argc) {
                export_manifest = argv[++index];
                export_output = argv[++index];
            } else {
                throw std::runtime_error("unknown or incomplete argument: " + argument);
            }
        }
        const int operation_count = static_cast<int>(probe) + static_cast<int>(relay) +
                                    static_cast<int>(sal_input.has_value()) +
                                    static_cast<int>(export_manifest.has_value());
        if (operation_count != 1 || sal_input.has_value() != sal_output.has_value() ||
            export_manifest.has_value() != export_output.has_value()) {
            throw std::runtime_error(
                "choose exactly one of --probe, --relay, --convert-sal INPUT OUTPUT, or --create-sal MANIFEST OUTPUT");
        }

        const RuntimePaths paths = LocateRuntime(runtime_root);
        GraphRuntime graph(paths);
        if (probe) {
            std::cout << "{\"available\":true,\"runtime_root\":\"" << JsonEscape(paths.root.string())
                      << "\",\"protocol\":\"saleae.graph-server-json.v1\"}\n";
            return 0;
        }
        if (sal_input.has_value()) {
            if (!fs::is_regular_file(*sal_input)) {
                throw std::runtime_error("Saleae capture does not exist: " + sal_input->string());
            }
            ConvertSal(graph, *sal_input, *sal_output);
            return 0;
        }
        if (export_manifest.has_value()) {
            if (!fs::is_regular_file(*export_manifest)) {
                throw std::runtime_error("Saleae export manifest does not exist: " + export_manifest->string());
            }
            CreateSal(graph, *export_manifest, *export_output);
            return 0;
        }
        Relay(graph);
        return 0;
    } catch (const std::exception& error) {
        std::cerr << error.what() << '\n';
        return 2;
    }
}
