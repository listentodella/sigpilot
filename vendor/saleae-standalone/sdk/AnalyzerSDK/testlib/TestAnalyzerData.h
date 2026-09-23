#ifndef ANALYZER_TEST_ANALYZER_DATA
#define ANALYZER_TEST_ANALYZER_DATA

#include <atomic>
#include <map>

#include "Analyzer.h"
#include "MockChannelData.h"

namespace AnalyzerTest
{

class AnalyzerData
{
public:
    ~AnalyzerData();

    U32 simulationRateHz = 12000000;
    U32 sampleRateHz = 12000000;
    std::atomic<U64> progressSample{0};
    std::atomic<bool> cancelled{false};
    std::map<Channel, MockChannelData*> channelData;


    AnalyzerResults* results = nullptr;
    AnalyzerSettings* settings = nullptr;
};

AnalyzerResults* GetResultsFromAnalyzer(Analyzer* instance);
AnalyzerData* GetDataFromAnalyzer(Analyzer* instance);

} // of namespace



#endif // ANALYZER_TEST_ANALYZER_DATA
