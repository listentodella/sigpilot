#include "MockChannelData.h"
#include "TestAnalyzerData.h"

#include <AnalyzerHelpers.h>
#include <limits>

void Analyzer::UseFrameV2()
{
}

U32 AnalyzerHelpers::GetOnesCount(U64 value)
{
    U32 count = 0;
    while (value != 0) {
        count += static_cast<U32>(value & 1);
        value >>= 1;
    }
    return count;
}

bool AnalyzerHelpers::IsEven(U64 value)
{
    return (value & 1) == 0;
}

bool AnalyzerHelpers::IsOdd(U64 value)
{
    return (value & 1) != 0;
}

U32 AnalyzerHelpers::Diff32(U32 a, U32 b)
{
    return a >= b ? a - b : b - a;
}

bool AnalyzerChannelData::DoMoreTransitionsExistInCurrentData()
{
    auto* data = reinterpret_cast<AnalyzerTest::MockChannelData*>(this);
    const auto next = std::upper_bound(data->mTransitions.begin(), data->mTransitions.end(), data->mCurrentSample);
    return next != data->mTransitions.end();
}

void AnalyzerChannelData::TrackMinimumPulseWidth()
{
}

U64 AnalyzerChannelData::GetMinimumPulseWidthSoFar()
{
    return std::numeric_limits<U64>::max();
}
