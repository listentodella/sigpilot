#include "MockChannelData.h"
#include "TestAnalyzerData.h"

#include <limits>

void Analyzer::UseFrameV2()
{
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
