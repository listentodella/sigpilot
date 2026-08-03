#include "compat_internal.hpp"
#include "saleae_compat.h"

#include <Analyzer.h>
#include <AnalyzerSettingInterface.h>
#include <AnalyzerSettings.h>

#include <MockChannelData.h>
#include <MockResults.h>
#include <MockSettings.h>
#include <MockSimulatedChannelDescriptor.h>
#include <TestAnalyzerData.h>
#include <TestInstance.h>

#include <dlfcn.h>

#include <exception>
#include <cstdlib>
#include <memory>
#include <string>
#include <unordered_map>
#include <utility>

struct GeneratedChannel
{
    uint32_t channel_index = 0;
    bool initial_high = false;
    uint64_t sample_count = 0;
    std::vector<uint64_t> transitions;
};

struct sr_session
{
    using CreateAnalyzerFn = Analyzer* (*)();
    using DestroyAnalyzerFn = void (*)(Analyzer*);
    using GetAnalyzerNameFn = const char* (*)();

    void* plugin = nullptr;
    Analyzer* analyzer = nullptr;
    DestroyAnalyzerFn destroy_analyzer = nullptr;
    std::string analyzer_name;
    std::string error;
    AnalyzerTest::Instance cancellation_context;
    std::unordered_map<std::string, std::unique_ptr<AnalyzerTest::MockChannelData>> channel_data;
    std::vector<GeneratedChannel> simulation_channels;
    bool settings_committed = false;
    bool ran = false;

    ~sr_session()
    {
        SaleaeCompat::ClearChannelDataGroup(this);
        if(analyzer)
        {
            auto* results = AnalyzerTest::GetResultsFromAnalyzer(analyzer);
            if(results)
                SaleaeCompat::ClearFramesFor(results);
            destroy_analyzer(analyzer);
        }
        if(plugin)
            dlclose(plugin);
    }
};

namespace
{

template <typename Function>
Function LoadSymbol(void* plugin, const char* name)
{
    dlerror();
    auto* symbol = dlsym(plugin, name);
    return reinterpret_cast<Function>(symbol);
}

int Fail(sr_session* session, const std::string& message)
{
    if(session)
        session->error = message;
    return -1;
}

AnalyzerSettings* Settings(sr_session* session)
{
    return AnalyzerTest::GetDataFromAnalyzer(session->analyzer)->settings;
}

const std::vector<SaleaeCompat::Frame>& Frames(const sr_session* session)
{
    if(!session || !session->analyzer)
    {
        static const std::vector<SaleaeCompat::Frame> empty;
        return empty;
    }
    return SaleaeCompat::FramesFor(AnalyzerTest::GetResultsFromAnalyzer(session->analyzer));
}

AnalyzerTest::MockResultData* LegacyResults(const sr_session* session)
{
    if(!session || !session->analyzer)
        return nullptr;
    auto* results = AnalyzerTest::GetResultsFromAnalyzer(session->analyzer);
    return results ? AnalyzerTest::MockResultData::MockFromResults(results) : nullptr;
}

} // namespace

extern "C" sr_session* sr_session_create(const char* plugin_path)
{
    if(!plugin_path)
        return nullptr;

    auto session = std::make_unique<sr_session>();
    session->plugin = dlopen(plugin_path, RTLD_NOW | RTLD_LOCAL);
    if(!session->plugin)
    {
        session->error = dlerror();
        return session.release();
    }

    const auto create = LoadSymbol<sr_session::CreateAnalyzerFn>(session->plugin, "CreateAnalyzer");
    session->destroy_analyzer = LoadSymbol<sr_session::DestroyAnalyzerFn>(session->plugin, "DestroyAnalyzer");
    const auto get_name = LoadSymbol<sr_session::GetAnalyzerNameFn>(session->plugin, "GetAnalyzerName");
    if(!create || !session->destroy_analyzer || !get_name)
    {
        session->error = "plugin does not export the Saleae analyzer entry points";
        return session.release();
    }

    try
    {
        session->analyzer = create();
        session->analyzer_name = get_name();
    }
    catch(const std::exception& exception)
    {
        session->error = exception.what();
    }
    catch(...)
    {
        session->error = "plugin constructor threw an unknown exception";
    }

    return session.release();
}

extern "C" void sr_session_destroy(sr_session* session)
{
    delete session;
}

extern "C" const char* sr_session_analyzer_name(const sr_session* session)
{
    return session ? session->analyzer_name.c_str() : "";
}

extern "C" const char* sr_session_last_error(const sr_session* session)
{
    return session ? session->error.c_str() : "invalid session";
}

extern "C" int sr_session_set_sample_rate(sr_session* session, uint64_t sample_rate_hz)
{
    if(!session || !session->analyzer || sample_rate_hz == 0 || sample_rate_hz > UINT32_MAX)
        return Fail(session, "invalid session or sample rate");
    AnalyzerTest::GetDataFromAnalyzer(session->analyzer)->sampleRateHz = static_cast<U32>(sample_rate_hz);
    return 0;
}

extern "C" int sr_session_set_number_setting(sr_session* session, const char* setting_title, double value)
{
    if(!session || !session->analyzer || !setting_title)
        return Fail(session, "invalid number setting arguments");

    try
    {
        auto* setting = AnalyzerTest::MockSettings::MockFromSettings(Settings(session))->GetSetting(setting_title);
        if(setting->mTypeId != INTERFACE_NUMBER_LIST)
            return Fail(session, std::string(setting_title) + " is not a number-list setting");
        setting->SetNumberedListIndexByValue(value);
        return 0;
    }
    catch(const std::exception& exception)
    {
        return Fail(session, exception.what());
    }
}

extern "C" int sr_session_set_integer_setting(sr_session* session, const char* setting_title, int value)
{
    if(!session || !session->analyzer || !setting_title)
        return Fail(session, "invalid integer setting arguments");
    try
    {
        auto* setting = AnalyzerTest::MockSettings::MockFromSettings(Settings(session))->GetSetting(setting_title);
        if(setting->mTypeId != INTERFACE_INTEGER)
            return Fail(session, std::string(setting_title) + " is not an integer setting");
        setting->mValue = value;
        return 0;
    }
    catch(const std::exception& exception)
    {
        return Fail(session, exception.what());
    }
}

extern "C" int sr_session_set_bool_setting(sr_session* session, const char* setting_title, int value)
{
    if(!session || !session->analyzer || !setting_title)
        return Fail(session, "invalid bool setting arguments");
    try
    {
        auto* setting = AnalyzerTest::MockSettings::MockFromSettings(Settings(session))->GetSetting(setting_title);
        if(setting->mTypeId != INTERFACE_BOOL)
            return Fail(session, std::string(setting_title) + " is not a bool setting");
        setting->mValue = value != 0;
        return 0;
    }
    catch(const std::exception& exception)
    {
        return Fail(session, exception.what());
    }
}

extern "C" int sr_session_set_text_setting(sr_session* session, const char* setting_title, const char* value)
{
    if(!session || !session->analyzer || !setting_title || !value)
        return Fail(session, "invalid text setting arguments");
    try
    {
        auto* setting = AnalyzerTest::MockSettings::MockFromSettings(Settings(session))->GetSetting(setting_title);
        if(setting->mTypeId != INTERFACE_TEXT)
            return Fail(session, std::string(setting_title) + " is not a text setting");
        setting->mText = value;
        return 0;
    }
    catch(const std::exception& exception)
    {
        return Fail(session, exception.what());
    }
}

extern "C" size_t sr_session_setting_count(sr_session* session)
{
    if(!session || !session->analyzer)
        return 0;
    auto* settings = AnalyzerTest::MockSettings::MockFromSettings(Settings(session));
    size_t count = 0;
    while(settings->GetSetting(static_cast<U32>(count)))
        ++count;
    return count;
}

extern "C" int sr_session_setting(sr_session* session, size_t index, sr_setting_view* output)
{
    if(!session || !session->analyzer || !output)
        return -1;
    auto* setting = AnalyzerTest::MockSettings::MockFromSettings(Settings(session))->GetSetting(static_cast<U32>(index));
    if(!setting)
        return -1;

    *output = {};
    output->title = setting->mTitle.c_str();
    output->tooltip = setting->mTooltip.c_str();
    switch(setting->mTypeId)
    {
    case INTERFACE_CHANNEL:
        output->kind = SR_SETTING_CHANNEL;
        output->channel_required = setting->mNoneChannelAllowed ? 0 : 1;
        break;
    case INTERFACE_NUMBER_LIST:
        output->kind = SR_SETTING_NUMBER_LIST;
        output->option_count = setting->mNamedValueList.size();
        if(!setting->mNamedValueList.empty() && setting->mValue >= 0 &&
           static_cast<size_t>(setting->mValue) < setting->mNamedValueList.size())
            output->number_value = setting->mNamedValueList[setting->mValue].value;
        break;
    case INTERFACE_INTEGER:
        output->kind = SR_SETTING_INTEGER;
        output->integer_value = setting->mValue;
        output->minimum_value = setting->mMinValue;
        output->maximum_value = setting->mMaxValue;
        break;
    case INTERFACE_BOOL:
        output->kind = SR_SETTING_BOOL;
        output->integer_value = setting->mValue;
        break;
    case INTERFACE_TEXT:
        output->kind = SR_SETTING_TEXT;
        output->text_value = setting->mText.c_str();
        break;
    default:
        return -1;
    }
    return 0;
}

extern "C" int sr_session_number_option(
    sr_session* session,
    size_t setting_index,
    size_t option_index,
    sr_number_option_view* output)
{
    if(!session || !session->analyzer || !output)
        return -1;
    auto* setting = AnalyzerTest::MockSettings::MockFromSettings(Settings(session))->GetSetting(static_cast<U32>(setting_index));
    if(!setting || setting->mTypeId != INTERFACE_NUMBER_LIST || option_index >= setting->mNamedValueList.size())
        return -1;
    const auto& option = setting->mNamedValueList[option_index];
    output->label = option.name.c_str();
    output->tooltip = option.tooltip.c_str();
    output->value = option.value;
    return 0;
}

extern "C" size_t sr_session_channel_setting_count(sr_session* session)
{
    if(!session || !session->analyzer)
        return 0;
    size_t count = 0;
    auto* settings = AnalyzerTest::MockSettings::MockFromSettings(Settings(session));
    for(U32 index = 0;; ++index)
    {
        auto* setting = settings->GetSetting(index);
        if(!setting)
            break;
        if(setting->mTypeId == INTERFACE_CHANNEL)
            ++count;
    }
    return count;
}

extern "C" const char* sr_session_channel_setting_title(sr_session* session, size_t index)
{
    if(!session || !session->analyzer)
        return nullptr;
    size_t channel_index = 0;
    auto* settings = AnalyzerTest::MockSettings::MockFromSettings(Settings(session));
    for(U32 setting_index = 0;; ++setting_index)
    {
        auto* setting = settings->GetSetting(setting_index);
        if(!setting)
            return nullptr;
        if(setting->mTypeId == INTERFACE_CHANNEL && channel_index++ == index)
            return setting->mTitle.c_str();
    }
}

extern "C" int sr_session_add_channel(
    sr_session* session,
    const char* setting_title,
    uint32_t channel_index,
    int initial_high,
    const uint64_t* transition_samples,
    size_t transition_count)
{
    if(!session || !session->analyzer || !setting_title || (transition_count && !transition_samples))
        return Fail(session, "invalid channel arguments");

    for(size_t index = 0; index < transition_count; ++index)
    {
        if(transition_samples[index] == 0 || (index && transition_samples[index - 1] >= transition_samples[index]))
            return Fail(session, "channel transitions must be strictly increasing and greater than zero");
    }

    try
    {
        auto* settings = Settings(session);
        auto* mock_settings = AnalyzerTest::MockSettings::MockFromSettings(settings);
        auto* setting = mock_settings->GetSetting(setting_title);
        if(setting->mTypeId != INTERFACE_CHANNEL)
            return Fail(session, std::string(setting_title) + " is not a channel setting");

        const Channel channel(0, channel_index, DIGITAL_CHANNEL);
        setting->mChannel = channel;

        auto data = std::make_unique<AnalyzerTest::MockChannelData>(&session->cancellation_context);
        data->TestSetInitialBitState(initial_high ? BIT_HIGH : BIT_LOW);
        for(size_t index = 0; index < transition_count; ++index)
            data->TestAppendTransitionAtSamples(transition_samples[index]);
        data->ResetCurrentSample(0);

        AnalyzerTest::GetDataFromAnalyzer(session->analyzer)->channelData[channel] = data.get();
        SaleaeCompat::RegisterChannelData(session, data.get());
        session->channel_data[setting_title] = std::move(data);
        return 0;
    }
    catch(const std::exception& exception)
    {
        return Fail(session, exception.what());
    }
}

extern "C" int sr_session_commit_settings(sr_session* session)
{
    if(!session || !session->analyzer)
        return Fail(session, "invalid session");
    try
    {
        if(!Settings(session)->SetSettingsFromInterfaces())
            return Fail(session, "analyzer rejected channel settings");
        session->settings_committed = true;
        return 0;
    }
    catch(const std::exception& exception)
    {
        return Fail(session, exception.what());
    }
}

extern "C" int sr_session_run(sr_session* session)
{
    if(!session || !session->analyzer || !session->settings_committed || session->ran)
        return Fail(session, "session is invalid, unconfigured, or already ran");

    session->ran = true;
    try
    {
        if(auto* analyzer2 = dynamic_cast<Analyzer2*>(session->analyzer))
            analyzer2->SetupResults();
        session->analyzer->WorkerThread();
        return Fail(session, "analyzer worker returned unexpectedly");
    }
    catch(const AnalyzerTest::OutOfDataException&)
    {
        return 0;
    }
    catch(const std::exception& exception)
    {
        return Fail(session, exception.what());
    }
    catch(...)
    {
        return Fail(session, "analyzer worker threw an unknown exception");
    }
}

extern "C" int sr_session_generate_simulation(sr_session* session, uint64_t sample_count, uint32_t sample_rate_hz)
{
    if(!session || !session->analyzer || !session->settings_committed || sample_count == 0 || sample_rate_hz == 0)
        return Fail(session, "simulation session is invalid or unconfigured");

    try
    {
        session->simulation_channels.clear();
        AnalyzerTest::GetDataFromAnalyzer(session->analyzer)->simulationRateHz = sample_rate_hz;
        SimulationChannelDescriptor* descriptors = nullptr;
        std::srand(0);
        const U32 count = session->analyzer->GenerateSimulationData(sample_count, sample_rate_hz, &descriptors);
        if(count && !descriptors)
            return Fail(session, "analyzer returned a null simulation channel array");

        session->simulation_channels.reserve(count);
        for(U32 index = 0; index < count; ++index)
        {
            auto* data = AnalyzerTest::SimulatedChannel::FromSimulatedChannelDescriptor(&descriptors[index]);
            GeneratedChannel output;
            output.channel_index = descriptors[index].GetChannel().mChannelIndex;
            output.sample_count = data->GetSampleCount();
            data->ResetToStart();
            output.initial_high = data->GetCurrentState() == BIT_HIGH;
            while(data->AdvanceToNextTransition())
                output.transitions.push_back(data->GetCurrentSample());
            session->simulation_channels.push_back(std::move(output));
        }
        return 0;
    }
    catch(const std::exception& exception)
    {
        return Fail(session, exception.what());
    }
    catch(...)
    {
        return Fail(session, "simulation generator threw an unknown exception");
    }
}

extern "C" size_t sr_session_simulation_channel_count(const sr_session* session)
{
    return session ? session->simulation_channels.size() : 0;
}

extern "C" int sr_session_simulation_channel(
    const sr_session* session,
    size_t index,
    sr_simulation_channel_view* output)
{
    if(!session || !output || index >= session->simulation_channels.size())
        return -1;
    const auto& channel = session->simulation_channels[index];
    output->channel_index = channel.channel_index;
    output->initial_high = channel.initial_high ? 1 : 0;
    output->sample_count = channel.sample_count;
    output->transition_samples = channel.transitions.data();
    output->transition_count = channel.transitions.size();
    return 0;
}

extern "C" size_t sr_session_frame_count(const sr_session* session)
{
    return Frames(session).size();
}

extern "C" int sr_session_frame(const sr_session* session, size_t index, sr_frame_view* output)
{
    if(!output || index >= Frames(session).size())
        return -1;
    const auto& frame = Frames(session)[index];
    output->type = frame.type.c_str();
    output->start_sample = frame.start_sample;
    output->end_sample = frame.end_sample;
    output->field_count = frame.fields.size();
    return 0;
}

extern "C" int sr_session_frame_field(const sr_session* session, size_t frame_index, size_t field_index, sr_field_view* output)
{
    if(!output || frame_index >= Frames(session).size() || field_index >= Frames(session)[frame_index].fields.size())
        return -1;

    const auto& field = Frames(session)[frame_index].fields[field_index];
    *output = {};
    output->key = field.key.c_str();
    output->string_value = field.string_value.c_str();
    output->bytes_value = field.bytes_value.data();
    output->bytes_length = field.bytes_value.size();
    output->integer_value = field.integer_value;
    output->double_value = field.double_value;
    output->boolean_value = field.boolean_value ? 1 : 0;
    output->kind = static_cast<sr_field_kind>(static_cast<int>(field.kind) + 1);
    return 0;
}

extern "C" size_t sr_session_legacy_frame_count(const sr_session* session)
{
    const auto* results = LegacyResults(session);
    return results ? static_cast<size_t>(results->TotalFrameCount()) : 0;
}

extern "C" int sr_session_legacy_frame(const sr_session* session, size_t index, sr_legacy_frame_view* output)
{
    const auto* results = LegacyResults(session);
    if(!results || !output || index >= results->TotalFrameCount())
        return -1;

    const auto& frame = results->GetFrame(index);
    output->start_sample = frame.mStartingSampleInclusive;
    output->end_sample = frame.mEndingSampleInclusive;
    output->data1 = frame.mData1;
    output->data2 = frame.mData2;
    output->type = frame.mType;
    output->flags = frame.mFlags;
    return 0;
}
