#ifndef SALEAE_COMPAT_ANALYZER_CHANNEL_DATA
#define SALEAE_COMPAT_ANALYZER_CHANNEL_DATA

#include <LogicPublicTypes.h>

struct AnalyzerChannelDataData;
class ChannelData;

class LOGICAPI AnalyzerChannelData
{
public:
    AnalyzerChannelData(ChannelData* channel_data);
    ~AnalyzerChannelData();

    U64 GetSampleNumber();
    BitState GetBitState();
    U32 Advance(U32 num_samples);
    U32 AdvanceToAbsPosition(U64 sample_number);
    void AdvanceToNextEdge();
    U64 GetSampleOfNextEdge();
    bool WouldAdvancingCauseTransition(U32 num_samples);
    bool WouldAdvancingToAbsPositionCauseTransition(U64 sample_number);
    void TrackMinimumPulseWidth();
    U64 GetMinimumPulseWidthSoFar();
    bool DoMoreTransitionsExistInCurrentData();

    // Used by the current official UNI/O analyzer but absent from the public SDK header.
    U32 GetNumberOfTransitionsToAbsPositionMinimumWidth(U64 sample_number, U64 minimum_width);

protected:
    AnalyzerChannelDataData* mData;
};

#endif
