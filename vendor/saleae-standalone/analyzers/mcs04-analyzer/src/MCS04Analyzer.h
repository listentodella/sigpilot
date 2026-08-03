#ifndef MCS04_ANALYZER_H
#define MCS04_ANALYZER_H

#include <Analyzer.h>
#include "MCS04AnalyzerSettings.h"
#include "MCS04AnalyzerResults.h"
#include "MCS04SimulationDataGenerator.h"
#include <memory>

class ANALYZER_EXPORT MCS04Analyzer : public Analyzer2
{
  public:
    MCS04Analyzer();
    virtual ~MCS04Analyzer();

    virtual void SetupResults();
    virtual void WorkerThread();

    virtual U32 GenerateSimulationData( U64 newest_sample_requested, U32 sample_rate, SimulationChannelDescriptor** simulation_channels );
    virtual U32 GetMinimumSampleRateHz();

    virtual const char* GetAnalyzerName() const;
    virtual bool NeedsRerun();

  protected: // vars
    MCS04AnalyzerSettings mSettings;
    std::unique_ptr<MCS04AnalyzerResults> mResults;
    AnalyzerChannelData *mData[ 4 ], *mClk1, *mClk2, *mSync;

    MCS04SimulationDataGenerator mSimulationDataGenerator;
    bool mSimulationInitilized;

    // Serial analysis vars:
    U32 mSampleRateHz;
    U32 mStartOfStopBitOffset;
    U32 mEndOfStopBitOffset;

  private:
    unsigned readBus( U64 at );
};

extern "C" ANALYZER_EXPORT const char* __cdecl GetAnalyzerName();
extern "C" ANALYZER_EXPORT Analyzer* __cdecl CreateAnalyzer();
extern "C" ANALYZER_EXPORT void __cdecl DestroyAnalyzer( Analyzer* analyzer );

#endif // MCS04_ANALYZER_H
