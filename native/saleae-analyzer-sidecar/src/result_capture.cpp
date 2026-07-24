#include "result_capture.h"

#include <algorithm>
#include <cstring>
#include <stdexcept>

#define RESULT_STORE() auto* store = reinterpret_cast<PxlogicSaleae::ResultStore*>(mData)

namespace
{

std::string JoinStrings(const char* first, const char* second, const char* third, const char* fourth,
                        const char* fifth, const char* sixth)
{
    std::string result = first == nullptr ? "" : first;
    for (const char* part : {second, third, fourth, fifth, sixth}) {
        if (part != nullptr) {
            result += part;
        }
    }
    return result;
}

class ResultsDataExtractor : public AnalyzerResults
{
  public:
    PxlogicSaleae::ResultStore* Store()
    {
        return reinterpret_cast<PxlogicSaleae::ResultStore*>(mData);
    }
};

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
    mInternals->fields.emplace_back(key, std::string(value));
}

void FrameV2::AddDouble(const char* key, double value)
{
    mInternals->fields.emplace_back(key, value);
}

void FrameV2::AddInteger(const char* key, S64 value)
{
    mInternals->fields.emplace_back(key, static_cast<std::int64_t>(value));
}

void FrameV2::AddBoolean(const char* key, bool value)
{
    mInternals->fields.emplace_back(key, value);
}

void FrameV2::AddByte(const char* key, U8 value)
{
    mInternals->fields.emplace_back(key, static_cast<std::uint8_t>(value));
}

void FrameV2::AddByteArray(const char* key, const U8* data, U64 length)
{
    mInternals->fields.emplace_back(key, std::vector<std::uint8_t>(data, data + length));
}

Frame::Frame() = default;

Frame::Frame(const Frame& frame) = default;

Frame::~Frame() = default;

bool Frame::HasFlag(U8 flag)
{
    return (mFlags & flag) != 0;
}

AnalyzerResults::AnalyzerResults()
    : mData(reinterpret_cast<AnalyzerResultsData*>(new PxlogicSaleae::ResultStore()))
{
}

AnalyzerResults::~AnalyzerResults()
{
    RESULT_STORE();
    delete store;
}

void AnalyzerResults::AddFrameV2(const FrameV2& frame, const char* type, U64 starting_sample, U64 ending_sample)
{
    RESULT_STORE();
    const std::string row = type == nullptr ? "" : type;
    if (!store->legacy_frame_indices.empty()) {
        auto& legacy = store->frames.at(store->legacy_frame_indices.back());
        const auto v2_end = static_cast<S64>(ending_sample);
        if (legacy.start_sample == static_cast<S64>(starting_sample) &&
            (legacy.end_sample == v2_end || legacy.end_sample + 1 == v2_end)) {
            legacy.row = row;
            legacy.fields = frame.mInternals->fields;
            return;
        }
    }
    PxlogicSaleae::CapturedFrame captured;
    captured.start_sample = static_cast<S64>(starting_sample);
    captured.end_sample = static_cast<S64>(ending_sample);
    captured.row = row;
    captured.fields = frame.mInternals->fields;
    store->frames.push_back(std::move(captured));
}

void AnalyzerResults::AddMarker(U64 sample_number, MarkerType marker_type, Channel& channel)
{
    RESULT_STORE();
    store->markers.push_back({sample_number, marker_type, channel});
}

U64 AnalyzerResults::AddFrame(const Frame& frame)
{
    RESULT_STORE();
    const U64 legacy_frame_id = store->legacy_frame_indices.size();
    store->frames.push_back({frame.mStartingSampleInclusive, frame.mEndingSampleInclusive, frame.mData1,
                             frame.mData2, frame.mType, frame.mFlags, "", {}, legacy_frame_id});
    store->legacy_frame_indices.push_back(store->frames.size() - 1);
    return legacy_frame_id;
}

void AnalyzerResults::CommitResults()
{
    RESULT_STORE();
    store->commit_frames.push_back(store->frames.empty() ? 0 : store->frames.size() - 1);
}

U64 AnalyzerResults::CommitPacketAndStartNewPacket()
{
    RESULT_STORE();
    store->packet_starts.push_back(store->frames.size());
    return store->frames.empty() ? 0 : store->frames.size() - 1;
}

void AnalyzerResults::CancelPacketAndStartNewPacket()
{
}

void AnalyzerResults::AddPacketToTransaction(U64, U64)
{
}

void AnalyzerResults::AddChannelBubblesWillAppearOn(const Channel&)
{
}

U64 AnalyzerResults::GetNumFrames()
{
    RESULT_STORE();
    return store->legacy_frame_indices.size();
}

U64 AnalyzerResults::GetNumPackets()
{
    RESULT_STORE();
    return store->packet_starts.size();
}

Frame AnalyzerResults::GetFrame(U64 frame_id)
{
    RESULT_STORE();
    const auto& captured = store->frames.at(store->legacy_frame_indices.at(frame_id));
    Frame frame;
    frame.mStartingSampleInclusive = captured.start_sample;
    frame.mEndingSampleInclusive = captured.end_sample;
    frame.mData1 = captured.data1;
    frame.mData2 = captured.data2;
    frame.mType = captured.type;
    frame.mFlags = captured.flags;
    return frame;
}

U64 AnalyzerResults::GetPacketContainingFrame(U64 frame_id)
{
    RESULT_STORE();
    U64 packet = 0;
    for (U64 index = 0; index < store->packet_starts.size(); ++index) {
        if (store->packet_starts[index] > frame_id) {
            break;
        }
        packet = index;
    }
    return packet;
}

U64 AnalyzerResults::GetPacketContainingFrameSequential(U64 frame_id)
{
    return GetPacketContainingFrame(frame_id);
}

void AnalyzerResults::GetFramesContainedInPacket(U64 packet_id, U64* first_frame_id, U64* last_frame_id)
{
    RESULT_STORE();
    *first_frame_id = store->packet_starts.at(packet_id);
    *last_frame_id = packet_id + 1 < store->packet_starts.size()
                         ? store->packet_starts.at(packet_id + 1) - 1
                         : store->frames.size() - 1;
}

U64 AnalyzerResults::GetTransactionContainingPacket(U64 packet_id)
{
    return packet_id;
}

void AnalyzerResults::GetPacketsContainedInTransaction(U64 transaction_id, U64** packet_id_array,
                                                       U64* packet_id_count)
{
    static U64 packet;
    packet = transaction_id;
    *packet_id_array = &packet;
    *packet_id_count = 1;
}

void AnalyzerResults::ClearResultStrings()
{
    RESULT_STORE();
    store->strings.clear();
}

void AnalyzerResults::AddResultString(const char* first, const char* second, const char* third,
                                      const char* fourth, const char* fifth, const char* sixth)
{
    RESULT_STORE();
    store->strings.push_back(JoinStrings(first, second, third, fourth, fifth, sixth));
}

void AnalyzerResults::GetResultStrings(const char*** result_string_array, U32* num_strings)
{
    RESULT_STORE();
    static std::vector<const char*> pointers;
    pointers.clear();
    for (const auto& value : store->strings) {
        pointers.push_back(value.c_str());
    }
    *result_string_array = pointers.data();
    *num_strings = static_cast<U32>(pointers.size());
}

bool AnalyzerResults::UpdateExportProgressAndCheckForCancel(U64, U64)
{
    RESULT_STORE();
    return store->cancelled;
}

void AnalyzerResults::ClearTabularText()
{
    RESULT_STORE();
    store->tabular_text.clear();
}

void AnalyzerResults::AddTabularText(const char* first, const char* second, const char* third,
                                     const char* fourth, const char* fifth, const char* sixth)
{
    RESULT_STORE();
    store->tabular_text.push_back(JoinStrings(first, second, third, fourth, fifth, sixth));
}

void AnalyzerResults::GetSearchData(const char*** result_string_array, U32* num_strings)
{
    static const char* empty = nullptr;
    *result_string_array = &empty;
    *num_strings = 0;
}

namespace PxlogicSaleae
{

ResultStore* GetResultStore(AnalyzerResults* results)
{
    return static_cast<ResultsDataExtractor*>(results)->Store();
}

} // namespace PxlogicSaleae
