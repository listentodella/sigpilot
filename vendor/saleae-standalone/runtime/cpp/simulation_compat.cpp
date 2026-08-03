#include <MockSimulatedChannelDescriptor.h>

#include <limits>

namespace
{

class DescriptorDataExtractor : public SimulationChannelDescriptor
{
public:
    AnalyzerTest::SimulatedChannel* data()
    {
        return reinterpret_cast<AnalyzerTest::SimulatedChannel*>(mData);
    }
};

BitState ToggleState(BitState state)
{
    return state == BIT_HIGH ? BIT_LOW : BIT_HIGH;
}

} // namespace

namespace AnalyzerTest
{

SimulatedChannel::SimulatedChannel() = default;

SimulatedChannel* SimulatedChannel::FromSimulatedChannelDescriptor(SimulationChannelDescriptor* descriptor)
{
    return static_cast<DescriptorDataExtractor*>(descriptor)->data();
}

U64 SimulatedChannel::GetSampleCount() const
{
    return mCurrentSample;
}

void SimulatedChannel::ResetToStart()
{
    mCurrentState = mInitialBitState;
    mCurrentSample = 0;
    mTransitionIndex = 0;
}

BitState SimulatedChannel::GetCurrentState() const
{
    return mCurrentState;
}

double SimulatedChannel::GetDurationToNextTransition() const
{
    if(mTransitionIndex >= mTransitions.size())
        return std::numeric_limits<double>::infinity();
    return static_cast<double>(mTransitions[mTransitionIndex] - mCurrentSample) * GetSampleDuration();
}

bool SimulatedChannel::AdvanceToNextTransition()
{
    if(mTransitionIndex >= mTransitions.size())
        return false;
    mCurrentSample = mTransitions[mTransitionIndex++];
    mCurrentState = ToggleState(mCurrentState);
    return true;
}

double SimulatedChannel::GetSampleDuration() const
{
    return 1.0 / static_cast<double>(mSampleRateHz);
}

U64 SimulatedChannel::GetCurrentSample() const
{
    return mCurrentSample;
}

SimulatedChannelGroup::SimulatedChannelGroup() = default;

} // namespace AnalyzerTest

#define DESCRIPTOR_DATA() \
    auto* data = reinterpret_cast<AnalyzerTest::SimulatedChannel*>(mData)

SimulationChannelDescriptor::SimulationChannelDescriptor()
    : mData(reinterpret_cast<SimulationChannelDescriptorData*>(new AnalyzerTest::SimulatedChannel()))
{
}

SimulationChannelDescriptor::SimulationChannelDescriptor(const SimulationChannelDescriptor& other)
    : mData(reinterpret_cast<SimulationChannelDescriptorData*>(
          new AnalyzerTest::SimulatedChannel(*reinterpret_cast<AnalyzerTest::SimulatedChannel*>(other.mData))))
{
}

SimulationChannelDescriptor::~SimulationChannelDescriptor()
{
    DESCRIPTOR_DATA();
    delete data;
}

SimulationChannelDescriptor& SimulationChannelDescriptor::operator=(const SimulationChannelDescriptor& other)
{
    if(this != &other)
    {
        DESCRIPTOR_DATA();
        *data = *reinterpret_cast<AnalyzerTest::SimulatedChannel*>(other.mData);
    }
    return *this;
}

void SimulationChannelDescriptor::SetChannel(Channel& channel)
{
    DESCRIPTOR_DATA();
    data->mChannel = channel;
}

void SimulationChannelDescriptor::SetSampleRate(U32 sample_rate_hz)
{
    DESCRIPTOR_DATA();
    data->mSampleRateHz = sample_rate_hz;
}

void SimulationChannelDescriptor::SetInitialBitState(BitState initial_bit_state)
{
    DESCRIPTOR_DATA();
    data->mInitialBitState = initial_bit_state;
    data->mCurrentState = initial_bit_state;
}

Channel SimulationChannelDescriptor::GetChannel()
{
    DESCRIPTOR_DATA();
    return data->mChannel;
}

U32 SimulationChannelDescriptor::GetSampleRate()
{
    DESCRIPTOR_DATA();
    return data->mSampleRateHz;
}

BitState SimulationChannelDescriptor::GetInitialBitState()
{
    DESCRIPTOR_DATA();
    return data->mInitialBitState;
}

void* SimulationChannelDescriptor::GetData()
{
    return mData;
}

void SimulationChannelDescriptor::Transition()
{
    DESCRIPTOR_DATA();
    data->mTransitions.push_back(data->mCurrentSample);
    data->mCurrentState = ToggleState(data->mCurrentState);
}

void SimulationChannelDescriptor::TransitionIfNeeded(BitState bit_state)
{
    DESCRIPTOR_DATA();
    if(data->mCurrentState != bit_state)
        Transition();
}

void SimulationChannelDescriptor::Advance(U32 num_samples_to_advance)
{
    DESCRIPTOR_DATA();
    data->mCurrentSample += num_samples_to_advance;
}

BitState SimulationChannelDescriptor::GetCurrentBitState()
{
    DESCRIPTOR_DATA();
    return data->mCurrentState;
}

U64 SimulationChannelDescriptor::GetCurrentSampleNumber()
{
    DESCRIPTOR_DATA();
    return data->mCurrentSample;
}

#undef DESCRIPTOR_DATA
#define GROUP_DATA() \
    auto* data = reinterpret_cast<AnalyzerTest::SimulatedChannelGroup*>(mData)

SimulationChannelDescriptorGroup::SimulationChannelDescriptorGroup()
    : mData(reinterpret_cast<SimulationChannelDescriptorGroupData*>(new AnalyzerTest::SimulatedChannelGroup()))
{
    GROUP_DATA();
    data->mChannels.reserve(64);
}

SimulationChannelDescriptorGroup::~SimulationChannelDescriptorGroup()
{
    GROUP_DATA();
    delete data;
}

SimulationChannelDescriptor* SimulationChannelDescriptorGroup::Add(
    Channel& channel,
    U32 sample_rate,
    BitState initial_bit_state)
{
    GROUP_DATA();
    data->mChannels.emplace_back();
    auto& descriptor = data->mChannels.back();
    descriptor.SetChannel(channel);
    descriptor.SetSampleRate(sample_rate);
    descriptor.SetInitialBitState(initial_bit_state);
    return &descriptor;
}

void SimulationChannelDescriptorGroup::AdvanceAll(U32 num_samples_to_advance)
{
    GROUP_DATA();
    for(auto& channel : data->mChannels)
        channel.Advance(num_samples_to_advance);
}

SimulationChannelDescriptor* SimulationChannelDescriptorGroup::GetArray()
{
    GROUP_DATA();
    return data->mChannels.data();
}

U32 SimulationChannelDescriptorGroup::GetCount()
{
    GROUP_DATA();
    return static_cast<U32>(data->mChannels.size());
}

#undef GROUP_DATA
