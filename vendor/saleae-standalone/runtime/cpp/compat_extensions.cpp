#include "compat_internal.hpp"

#include <Analyzer.h>
#include <AnalyzerChannelData.h>
#include <AnalyzerHelpers.h>
#include <AnalyzerResults.h>

#include <MockChannelData.h>
#include <MockResults.h>
#include <TestInstance.h>

#include <algorithm>
#include <atomic>
#include <limits>
#include <mutex>
#include <unordered_map>
#include <vector>

struct FrameV2Data
{
    std::vector<SaleaeCompat::Field> fields;
};

namespace
{

std::mutex frame_mutex;
std::unordered_map<const AnalyzerResults*, std::vector<SaleaeCompat::Frame>> frame_results;
std::mutex channel_mutex;
std::unordered_map<const void*, std::vector<AnalyzerChannelData*>> channel_groups;
std::unordered_map<const AnalyzerChannelData*, const void*> channel_group_by_data;

SaleaeCompat::Field& AddField(FrameV2Data* data, const char* key, SaleaeCompat::FieldKind kind)
{
    data->fields.push_back({});
    auto& field = data->fields.back();
    field.key = key ? key : "";
    field.kind = kind;
    return field;
}

} // namespace

FrameV2::FrameV2() : mInternals(new FrameV2Data())
{
}

FrameV2::~FrameV2()
{
    delete mInternals;
}

void FrameV2::AddString(const char* key, const char* value)
{
    AddField(mInternals, key, SaleaeCompat::FieldKind::String).string_value = value ? value : "";
}

void FrameV2::AddDouble(const char* key, double value)
{
    AddField(mInternals, key, SaleaeCompat::FieldKind::Double).double_value = value;
}

void FrameV2::AddInteger(const char* key, S64 value)
{
    AddField(mInternals, key, SaleaeCompat::FieldKind::Integer).integer_value = value;
}

void FrameV2::AddBoolean(const char* key, bool value)
{
    AddField(mInternals, key, SaleaeCompat::FieldKind::Boolean).boolean_value = value;
}

void FrameV2::AddByte(const char* key, U8 value)
{
    AddField(mInternals, key, SaleaeCompat::FieldKind::Byte).integer_value = value;
}

void FrameV2::AddByteArray(const char* key, const U8* data, U64 length)
{
    auto& field = AddField(mInternals, key, SaleaeCompat::FieldKind::Bytes);
    if(data && length)
        field.bytes_value.assign(data, data + length);
}

void AnalyzerResults::AddFrameV2(const FrameV2& frame, const char* type, U64 starting_sample, U64 ending_sample)
{
    SaleaeCompat::Frame output;
    output.type = type ? type : "";
    output.start_sample = starting_sample;
    output.end_sample = ending_sample;
    output.fields = frame.mInternals->fields;

    std::lock_guard<std::mutex> lock(frame_mutex);
    frame_results[this].push_back(std::move(output));
}

void Analyzer::UseFrameV2()
{
}

namespace SaleaeCompat
{

namespace
{
std::atomic<std::uint64_t> trigger_sample{0};
} // namespace

std::uint64_t TriggerSample()
{
    return trigger_sample.load(std::memory_order_relaxed);
}

void SetTriggerSample(std::uint64_t sample)
{
    trigger_sample.store(sample, std::memory_order_relaxed);
}

} // namespace SaleaeCompat

bool AnalyzerChannelData::DoMoreTransitionsExistInCurrentData()
{
    auto* data = reinterpret_cast<AnalyzerTest::MockChannelData*>(this);
    try
    {
        data->GetSampleOfNextEdge();
        return true;
    }
    catch(const AnalyzerTest::OutOfDataException&)
    {
        std::lock_guard<std::mutex> lock(channel_mutex);
        const auto group_entry = channel_group_by_data.find(this);
        if(group_entry == channel_group_by_data.end())
            return false;
        const auto channels = channel_groups.find(group_entry->second);
        if(channels == channel_groups.end())
            return false;
        for(auto* channel : channels->second)
        {
            try
            {
                channel->GetSampleOfNextEdge();
                return false;
            }
            catch(const AnalyzerTest::OutOfDataException&)
            {
            }
        }
        throw AnalyzerTest::OutOfDataException();
    }
}

void AnalyzerChannelData::TrackMinimumPulseWidth()
{
    // Deliberately empty: the real DigitalChannelData::TrackMinimumPulseWidth is
    // also a no-op (vtable+80 in libgraph_server_shared is `nullsub`). Tracking
    // is unconditional in the original — it happens as a side effect of
    // advancing — so this call is vestigial. See
    // docs/libanalyzer-ida-analysis.md §9.
}

namespace
{

/**
 * Index of the first real transition.
 *
 * The vendored testlib's TestSetInitialBitState pushes a dummy transition at
 * sample 0 ("insert a dummy sample before the real data, so that the logic in
 * AdvanceToSample is simpler"). It is not an edge, so counting it would report
 * a bogus first pulse width of `first_edge - 0`. A genuine edge at sample 0
 * cannot be expressed through the harness API either —
 * TestAppendTransitionAtSamples asserts `sample > mCurrentSample`.
 */
std::size_t first_real_transition(const std::vector<U64>& transitions)
{
    if(transitions.size() > 1 && transitions[0] == 0)
        return 1;
    return 0;
}

} // namespace

U64 AnalyzerChannelData::GetMinimumPulseWidthSoFar()
{
    auto* data = reinterpret_cast<AnalyzerTest::MockChannelData*>(this);
    // AnalyzerChannelData is a friend of MockChannelData, so the transition list
    // and cursor are reachable without touching the vendored testlib.
    const std::vector<U64>& transitions = data->mTransitions;
    const U64 up_to = data->mCurrentSample;

    // Scanned from scratch on every call. The SDK calls this from
    // Analyzer::NeedsRerun(), i.e. after the worker thread has finished, so the
    // scan is paid a handful of times per decode rather than per edge — and
    // unlike a cursor cached against the channel pointer, it cannot go stale
    // when a channel object is recycled for a later run.
    U64 minimum = 0;
    U64 previous = 0;
    bool has_previous = false;
    for(std::size_t index = first_real_transition(transitions); index < transitions.size(); ++index)
    {
        const U64 edge = transitions[index];
        if(edge > up_to)
            break;
        if(has_previous)
        {
            const U64 gap = edge - previous;
            if(minimum == 0 || gap < minimum)
                minimum = gap;
        }
        previous = edge;
        has_previous = true;
    }

    // `0` means "nothing tracked yet"; the original reports that as -1
    // (UINT64_MAX). Note the callers compare against 0 to detect a broken
    // result, so returning UINT64_MAX rather than 0 is what keeps the degenerate
    // "< 2 edges" case on the existing "computed_bit_rate == 0 -> bail" path
    // instead of tripping AnalyzerHelpers::Assert.
    return minimum ? minimum : std::numeric_limits<U64>::max();
}

U32 AnalyzerChannelData::GetNumberOfTransitionsToAbsPositionMinimumWidth(
    U64 sample_number,
    U64 minimum_width)
{
    // The original honours minimum_width when walking to the target; we do not
    // implement the minimum-width variant yet, so advancing normally is the
    // closest behaviour. Left explicit rather than silently ignoring the
    // parameter. See docs/libanalyzer-ida-analysis.md §12 (O3).
    static_cast<void>(minimum_width);
    return AdvanceToAbsPosition(sample_number);
}

U64 AnalyzerResults::GetNumPackets()
{
    auto* data = reinterpret_cast<AnalyzerTest::MockResultData*>(mData);
    return data->TotalPacketCount();
}

void AnalyzerResults::GetFramesContainedInPacket(
    U64 packet_id,
    U64* first_frame_id,
    U64* last_frame_id)
{
    const auto* data = reinterpret_cast<AnalyzerTest::MockResultData*>(mData);
    const auto range = data->GetFrameRangeForPacket(packet_id);
    if(first_frame_id)
        *first_frame_id = range.first;
    if(last_frame_id)
        *last_frame_id = range.second;
}

void AnalyzerResults::CancelPacketAndStartNewPacket()
{
    auto* data = reinterpret_cast<AnalyzerTest::MockResultData*>(mData);
    if(data->mPacketStartFrames.empty() || data->mPacketStartFrames.back() != data->NextFrame())
        data->mPacketStartFrames.push_back(data->NextFrame());
}

U64 AnalyzerResults::GetPacketContainingFrame(U64 frame_id)
{
    const auto* data = reinterpret_cast<AnalyzerTest::MockResultData*>(mData);
    for(U64 packet = data->mPacketStartFrames.size(); packet > 0; --packet)
    {
        if(data->mPacketStartFrames[packet - 1] <= frame_id)
            return packet - 1;
    }
    return INVALID_RESULT_INDEX;
}

bool AnalyzerHelpers::IsEven(U64 value)
{
    return (value & 1U) == 0;
}

bool AnalyzerHelpers::IsOdd(U64 value)
{
    return !IsEven(value);
}

U32 AnalyzerHelpers::GetOnesCount(U64 value)
{
    U32 count = 0;
    while(value)
    {
        count += static_cast<U32>(value & 1U);
        value >>= 1U;
    }
    return count;
}

U32 AnalyzerHelpers::Diff32(U32 a, U32 b)
{
    return a >= b ? a - b : b - a;
}

S64 AnalyzerHelpers::ConvertToSignedNumber(U64 number, U32 num_bits)
{
    if(num_bits == 0 || num_bits >= 64)
        return static_cast<S64>(number);
    const U64 mask = (U64{1} << num_bits) - 1;
    number &= mask;
    const U64 sign = U64{1} << (num_bits - 1);
    return static_cast<S64>((number ^ sign) - sign);
}

namespace AnalyzerTest
{

Instance::Instance(const std::string&)
{
}

Instance::~Instance()
{
}

bool Instance::CheckCancellation() const
{
    return false;
}

OutOfDataException::OutOfDataException()
{
}

CancellationException::CancellationException()
{
}

} // namespace AnalyzerTest

namespace SaleaeCompat
{

void RegisterChannelData(const void* group, AnalyzerChannelData* channel)
{
    std::lock_guard<std::mutex> lock(channel_mutex);
    channel_groups[group].push_back(channel);
    channel_group_by_data[channel] = group;
}

void ClearChannelDataGroup(const void* group)
{
    std::lock_guard<std::mutex> lock(channel_mutex);
    const auto found = channel_groups.find(group);
    if(found == channel_groups.end())
        return;
    for(auto* channel : found->second)
        channel_group_by_data.erase(channel);
    channel_groups.erase(found);
}

const std::vector<Frame>& FramesFor(const AnalyzerResults* results)
{
    static const std::vector<Frame> empty;
    std::lock_guard<std::mutex> lock(frame_mutex);
    const auto found = frame_results.find(results);
    return found == frame_results.end() ? empty : found->second;
}

void AppendFramesFor(
    const AnalyzerResults* results,
    std::size_t start_index,
    std::vector<Frame>& output)
{
    std::lock_guard<std::mutex> lock(frame_mutex);
    const auto found = frame_results.find(results);
    if(found == frame_results.end() || start_index >= found->second.size())
        return;
    output.insert(output.end(), found->second.begin() + start_index, found->second.end());
}

void ClearFramesFor(const AnalyzerResults* results)
{
    std::lock_guard<std::mutex> lock(frame_mutex);
    frame_results.erase(results);
}

} // namespace SaleaeCompat
