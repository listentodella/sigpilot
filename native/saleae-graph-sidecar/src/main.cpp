#include <dlfcn.h>

#include <algorithm>
#include <chrono>
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
    bool all_complete = true;
    for (SaleaeStore& store : stores) {
        const std::string key = std::to_string(store.node_id);
        if (!state.contains(key)) {
            all_complete = false;
            continue;
        }
        const Json& node_state = state[key].at("state");
        const Json& status = node_state.at("serializationStatus");
        const std::string mode = status.value("mode", "");
        if (mode == "DeserializationErrored") {
            throw std::runtime_error("Saleae DigitalStore failed to deserialize " + store.source_file.string());
        }
        if (mode != "DeserializationComplete") {
            all_complete = false;
        }
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
    return all_complete;
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

    Json export_setup = Json::array({Json{{"type", "Saleae::Graph::GraphActions::AddNode"},
                                          {"id", 200},
                                          {"name", "export"},
                                          {"nodeType", "Saleae::Graph::ExportNode"}}});
    for (const SaleaeStore& store : stores) {
        export_setup.push_back({
            {"type", "Saleae::Graph::GraphActions::ConnectApi"},
            {"id", 300 + store.channel},
            {"connection", Json{{"fromNodeId", store.node_id}, {"toNodeId", 200}, {"toApiIndex", store.node_id}}},
        });
    }
    WaitForRequest(graph, GraphRequest(5, "Saleae::Graph::GraphActionData",
                                       Json{{"runInParallel", false}, {"actions", export_setup}}, session_id), 5);

    const Json begin = stores.front().processed_begin;
    const Json end = stores.front().processed_end;
    const std::uint64_t sample_rate = stores.front().sample_rate_hz;
    if (begin.is_null() || end.is_null() || sample_rate == 0) {
        throw std::runtime_error("Saleae DigitalStore did not report sampling metadata");
    }
    const double duration_seconds = end.value("unixTimeMilliseconds", 0.0) / 1000.0 +
                                    end.value("fractionalMilliseconds", 0.0) / 1000.0 -
                                    (begin.value("unixTimeMilliseconds", 0.0) / 1000.0 +
                                     begin.value("fractionalMilliseconds", 0.0) / 1000.0);
    Json digital_channels = Json::object();
    for (SaleaeStore& store : stores) {
        store.exported_file = output / ("digital_" + std::to_string(store.channel) + ".bin");
        digital_channels[std::to_string(store.node_id)] = {
            {"label", "D" + std::to_string(store.channel)},
            {"binaryFilepath", store.exported_file.string()},
        };
    }
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

    for (const SaleaeStore& store : stores) {
        if (!fs::is_regular_file(store.exported_file) || fs::file_size(store.exported_file) < 44) {
            throw std::runtime_error("Saleae export did not produce " + store.exported_file.string());
        }
    }
    const double exported_duration = ReadSaleaeBinaryDuration(stores.front().exported_file);
    WriteSaleaeManifest(output, input, stores, channel_count, exported_duration, sample_rate);

    // DeleteGraphData is the same cleanup request used by Logic 2. We still
    // abandon the native object after its reply because the private runtime's
    // destructor races an internal export worker on this SDK build.
    WaitForRequest(graph, GraphRequest(7, "Saleae::Graph::DeleteGraphData", Json::object(), session_id), 7);
    std::error_code cleanup_error;
    fs::remove_all(extracted, cleanup_error);
    graph.Abandon();
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
            } else {
                throw std::runtime_error("unknown or incomplete argument: " + argument);
            }
        }
        const int operation_count = static_cast<int>(probe) + static_cast<int>(relay) +
                                    static_cast<int>(sal_input.has_value());
        if (operation_count != 1 || sal_input.has_value() != sal_output.has_value()) {
            throw std::runtime_error("choose exactly one of --probe, --relay, or --convert-sal INPUT OUTPUT");
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
        Relay(graph);
        return 0;
    } catch (const std::exception& error) {
        std::cerr << error.what() << '\n';
        return 2;
    }
}
