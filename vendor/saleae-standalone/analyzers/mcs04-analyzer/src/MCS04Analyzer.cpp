#include "MCS04Analyzer.h"
#include "MCS04Disasm.h"
#include "MCS04AnalyzerSettings.h"
#include <AnalyzerChannelData.h>


MCS04Analyzer::MCS04Analyzer() : Analyzer2(), mSettings(), mSimulationInitilized( false )
{
    SetAnalyzerSettings( &mSettings );
#ifndef NO_FRAME_v2
    UseFrameV2();
#endif
}

MCS04Analyzer::~MCS04Analyzer()
{
    KillThread();
}

void MCS04Analyzer::SetupResults()
{
    // SetupResults is called each time the analyzer is run. Because the same instance can be used for multiple runs, we need to clear the
    // results each time.
    mResults.reset( new MCS04AnalyzerResults( this, &mSettings ) );
    SetAnalyzerResults( mResults.get() );
    mResults->AddChannelBubblesWillAppearOn( mSettings.mBusClk2 );
    mResults->AddChannelBubblesWillAppearOn( mSettings.mBusBit0 );
    mResults->AddChannelBubblesWillAppearOn( mSettings.mBusBit1 );
    mResults->AddChannelBubblesWillAppearOn( mSettings.mBusBit2 );
}

unsigned MCS04Analyzer::readBus( U64 at )
{
    unsigned ret = 0, i;

    for( i = 0; i < 4; i++ )
    {
        mData[ 3 - i ]->AdvanceToAbsPosition( at );
        ret = ret * 2 + ( mData[ 3 - i ]->GetBitState() != BIT_HIGH ? 1 : 0 ); // inverted logic, remember?
    }

    return ret;
}

void MCS04Analyzer::WorkerThread()
{
    enum MCS4prevInstrState prevState;
    enum MCS4busPhase prevPhase;
    union MCS4data dt = {};
    unsigned i, prevOPA;
    U64 pos, startF2;

    mData[ 0 ] = GetAnalyzerChannelData( mSettings.mBusBit0 );
    mData[ 1 ] = GetAnalyzerChannelData( mSettings.mBusBit1 );
    mData[ 2 ] = GetAnalyzerChannelData( mSettings.mBusBit2 );
    mData[ 3 ] = GetAnalyzerChannelData( mSettings.mBusBit3 );
    mClk1 = GetAnalyzerChannelData( mSettings.mBusClk1 );
    mClk2 = GetAnalyzerChannelData( mSettings.mBusClk2 );
    mSync = GetAnalyzerChannelData( mSettings.mBusSync );

    // first, find the first X3 phase. first we look for a low and a high on clk1, verify that clk2 is high when clk1 goes high

resync:
    prevPhase = MCS4busPhaseInvalid;
    prevState = MCS4prevInstrNormal;
    prevOPA = 0;

    pos = mClk1->GetSampleNumber();
    if( mClk2->GetSampleNumber() > pos )
        pos = mClk2->GetSampleNumber();
    if( mSync->GetSampleNumber() > pos )
        pos = mSync->GetSampleNumber();

    // sync up positions
    mClk1->AdvanceToAbsPosition( pos );
    mClk2->AdvanceToAbsPosition( pos );
    mSync->AdvanceToAbsPosition( pos );

    do
    {
        do
        {
            do
            {
                // first we look for a low and a high on clk1
                do
                {
                    mClk1->AdvanceToNextEdge();
                } while( mClk1->GetBitState() != BIT_LOW );
                mClk1->AdvanceToNextEdge(); // go to high

                pos = mClk1->GetSampleNumber();
                mClk2->AdvanceToAbsPosition( pos );
                mSync->AdvanceToAbsPosition( pos );
                // then we verify that SYNC is low and clk2 is high
            } while( mClk1->GetBitState() != BIT_HIGH || mSync->GetBitState() != BIT_LOW );

            mClk2->AdvanceToNextEdge(); // go to low
            pos = mClk2->GetSampleNumber();
            mClk1->AdvanceToAbsPosition( pos );
            mSync->AdvanceToAbsPosition( pos );

            // verify that SYNC is still low and clk1 is still high
        } while( mSync->GetBitState() != BIT_LOW || mClk1->GetBitState() != BIT_HIGH );

        mClk2->AdvanceToNextEdge(); // go to high
        pos = mClk2->GetSampleNumber();
        mClk1->AdvanceToAbsPosition( pos );
        mSync->AdvanceToAbsPosition( pos );

        // verify that CLK1 is still high
    } while( mClk1->GetBitState() != BIT_HIGH );


    pos = mClk2->GetSampleNumber();
    mClk1->AdvanceToAbsPosition( pos );
    mSync->AdvanceToAbsPosition( pos );
    for( i = 0; i < 4; i++ )
        mData[ 0 ]->AdvanceToAbsPosition( pos );
    prevPhase = MCS4busPhaseX3;

    // we are now at start of A1, both clocks are high
    mResults->CancelPacketAndStartNewPacket();


    while( 1 )
    {
        U64 frameEnd, nextClk1Low, nextClk2Low, nextClk1High, nextClk2High;
        BitState sync;
        unsigned bus;
        FrameV2 f2;
        Frame f;


        f.mStartingSampleInclusive = mClk1->GetSampleNumber();

        // verify that clk1 goes down first
        nextClk1Low = mClk1->GetSampleOfNextEdge();
        nextClk2Low = mClk2->GetSampleOfNextEdge();
        if( nextClk1Low >= nextClk2Low )
            goto resync;

        // verify it comes up before clk2 goes down
        mClk1->AdvanceToAbsPosition( nextClk1Low );
        nextClk1High = mClk1->GetSampleOfNextEdge();
        if( nextClk1High >= nextClk2Low )
            goto resync;

        // forward to there
        mClk1->AdvanceToAbsPosition( nextClk1High );
        mClk2->AdvanceToAbsPosition( nextClk1High );

        // verify that clk2 goes down next
        nextClk1Low = mClk1->GetSampleOfNextEdge();
        nextClk2Low = mClk2->GetSampleOfNextEdge();

        if( nextClk1Low <= nextClk2Low )
            goto resync;

        // verify it comes up before clk1 goes down
        mClk2->AdvanceToAbsPosition( nextClk2Low );
        nextClk2High = mClk2->GetSampleOfNextEdge();
        if( nextClk1Low <= nextClk2High )
            goto resync;


        // we are now at clk2 down, fast forward the bus and sample it
        mSync->AdvanceToAbsPosition( nextClk2Low );
        bus = readBus( nextClk2Low );
        sync = mSync->GetBitState();

        // now go to clk2 rising edge
        mClk1->AdvanceToAbsPosition( nextClk2High );
        mClk2->AdvanceToAbsPosition( nextClk2High );
        mSync->AdvanceToAbsPosition( nextClk2High );

        f.mEndingSampleInclusive = nextClk2High - 1;

        // process what we found
        if( ( prevPhase == MCS4busPhaseX2 && sync != BIT_LOW ) || ( prevPhase != MCS4busPhaseX2 && sync == BIT_LOW ) )
        {
            // SYNC bit not in X3, or no SYNC bit in X3
            goto resync;
        }

        switch( prevPhase )
        {
        case MCS4busPhaseX3:
            prevOPA = dt.instrVal & 0x0f;
            if( prevState != MCS4prevInstrNormal )
                prevState = MCS4prevInstrNormal;
            else
                switch( dt.instrVal >> 4 )
                {
                case 0x01:
                    prevState = MCS4prevInstrJCN;
                    break;

                case 0x02:
                    prevState = ( dt.instrVal & 1 ) ? MCS4prevInstrNormal : MCS4prevInstrFIM;
                    break;

                case 0x04:
                    prevState = MCS4prevInstrJUN;
                    break;

                case 0x05:
                    prevState = MCS4prevInstrJMS;
                    break;

                case 0x07:
                    prevState = MCS4prevInstrISZ;
                    break;

                default:
                    prevState = MCS4prevInstrNormal;
                    break;
                }
            dt.romAddr = ( dt.romAddr & 0xff0 ) + 1 * bus;
            prevPhase = MCS4busPhaseA1;
            mResults->CommitPacketAndStartNewPacket();
            startF2 = f.mStartingSampleInclusive;
            break;

        case MCS4busPhaseA1:
            dt.romAddr = ( dt.romAddr & 0xf0f ) + 16 * bus;
            prevPhase = MCS4busPhaseA2;
            break;

        case MCS4busPhaseA2:
            dt.romAddr = ( dt.romAddr & 0x0ff ) + 256 * bus;
            prevPhase = MCS4busPhaseA3;
            break;

        case MCS4busPhaseA3:
            dt.instrVal = ( dt.instrVal & 0x0f ) + 16 * bus;
            prevPhase = MCS4busPhaseM1;
            break;

        case MCS4busPhaseM1:
            dt.instrVal = ( dt.instrVal & 0xf0 ) + 1 * bus;
            prevPhase = MCS4busPhaseM2;
            break;

        case MCS4busPhaseM2:
            prevPhase = MCS4busPhaseX1;
            break;

        case MCS4busPhaseX1:
            prevPhase = MCS4busPhaseX2;
            dt.busValAtX2 = bus;
            break;

        case MCS4busPhaseX2:
            prevPhase = MCS4busPhaseX3;
            break;

        default:
            goto resync;
        }
        dt.busVal = bus;
        dt.busPhase = prevPhase;
        dt.prevInstrState = prevState;
        dt.prevInstrOPA = prevOPA;

        f.mData1 = dt.mData1;

        mResults->AddFrame( f );

#ifndef NO_FRAME_v2

        if( prevPhase == MCS4busPhaseX3 )
        {
            char romAddr[ 6 ], disasm[ 64 ] = {}, unused1[ 64 ], unused2[ 64 ];

            mcs04disasm( disasm, unused1, unused2, prevState, prevOPA, 0xfff & dt.romAddr, dt.instrVal, mSettings.m4040,
                         Hexadecimal /* executive decision */ );


            snprintf( romAddr, sizeof( romAddr ), "0x%03x", 0xfff & dt.romAddr );
            f2.AddString( "ROM adr", romAddr );

            f2.AddByte( "ROM val", dt.instrVal );
            f2.AddByte( "BUS (x2)", dt.busValAtX2 );
            f2.AddByte( "BUS (x3)", bus );
            mResults->AddFrameV2( f2, disasm, startF2, f.mEndingSampleInclusive );
        }

#endif


        mResults->CommitResults();
        ReportProgress( f.mEndingSampleInclusive );
    }
}

bool MCS04Analyzer::NeedsRerun()
{
    return false;
}

U32 MCS04Analyzer::GenerateSimulationData( U64 minimum_sample_index, U32 device_sample_rate,
                                           SimulationChannelDescriptor** simulation_channels )
{
    if( mSimulationInitilized == false )
    {
        mSimulationDataGenerator.Initialize( GetSimulationSampleRate(), &mSettings );
        mSimulationInitilized = true;
    }

    return mSimulationDataGenerator.GenerateSimulationData( minimum_sample_index, device_sample_rate, simulation_channels );
}

U32 MCS04Analyzer::GetMinimumSampleRateHz()
{
    return 500000; // 500khz needed to capture even the slowest valid MSC-04 bus
}

const char* MCS04Analyzer::GetAnalyzerName() const
{
    return "Intel MCS-04 bus";
}

const char* GetAnalyzerName()
{
    return "Intel MCS-04 bus";
}

Analyzer* CreateAnalyzer()
{
    return new MCS04Analyzer();
}

void DestroyAnalyzer( Analyzer* analyzer )
{
    delete analyzer;
}