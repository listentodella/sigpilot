#ifndef MCS04_ANALYZER_RESULTS
#define MCS04_ANALYZER_RESULTS

#include <AnalyzerResults.h>

class MCS04Analyzer;
class MCS04AnalyzerSettings;

enum MCS4busPhase
{
    MCS4busPhaseInvalid,
    MCS4busPhaseA1,
    MCS4busPhaseA2,
    MCS4busPhaseA3,
    MCS4busPhaseM1,
    MCS4busPhaseM2,
    MCS4busPhaseX1,
    MCS4busPhaseX2,
    MCS4busPhaseX3,
};


union MCS4data {
    U64 mData1;
    struct
    {
        U32 busVal : 4;         // val on the bus
        U32 busPhase : 4;       // enum MCS4busPhase
        U32 prevInstrState : 3; // enum MCS4prevInstrState
        U32 prevInstrOPA : 4;
        U32 romAddr : 12;
        U32 instrVal : 8;
        U32 busValAtX2 : 4; // only valid after x2... duh?
    };
};


class MCS04AnalyzerResults : public AnalyzerResults
{
  public:
    MCS04AnalyzerResults( MCS04Analyzer* analyzer, MCS04AnalyzerSettings* settings );
    virtual ~MCS04AnalyzerResults();

    virtual void GenerateBubbleText( U64 frame_index, Channel& channel, DisplayBase display_base );
    virtual void GenerateExportFile( const char* file, DisplayBase display_base, U32 export_type_user_id );

    virtual void GenerateFrameTabularText( U64 frame_index, DisplayBase display_base );
    virtual void GeneratePacketTabularText( U64 packet_id, DisplayBase display_base );
    virtual void GenerateTransactionTabularText( U64 transaction_id, DisplayBase display_base );

  protected: // functions
  protected: // vars
    MCS04AnalyzerSettings* mSettings;
    MCS04Analyzer* mAnalyzer;
};

#endif // MCS04_ANALYZER_RESULTS
