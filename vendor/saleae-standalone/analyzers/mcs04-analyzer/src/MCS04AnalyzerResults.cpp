#include "MCS04AnalyzerResults.h"
#include <AnalyzerHelpers.h>
#include "MCS04Analyzer.h"
#include "MCS04AnalyzerSettings.h"
#include "MCS04Disasm.h"
#include <iostream>
#include <fstream>

MCS04AnalyzerResults::MCS04AnalyzerResults( MCS04Analyzer* analyzer, MCS04AnalyzerSettings* settings )
    : AnalyzerResults(), mSettings( settings ), mAnalyzer( analyzer )
{
}

MCS04AnalyzerResults::~MCS04AnalyzerResults()
{
}


void MCS04AnalyzerResults::GenerateBubbleText( U64 frame_index, Channel& channel, DisplayBase display_base )
{
    ClearResultStrings();
    Frame frame = GetFrame( frame_index );
    union MCS4data data;
    data.mData1 = frame.mData1;
    char reg_str[ 4 ], number_str[ 64 ];

    ClearResultStrings();

    if( channel == mSettings->mBusClk2 )
    { // CLK2 shows bus phase, 1-based (0 means unknown/invalid)

        static const char* busPhaseNames[ 9 ] = { 0 };
        busPhaseNames[ MCS4busPhaseA1 ] = "A1";
        busPhaseNames[ MCS4busPhaseA2 ] = "A2";
        busPhaseNames[ MCS4busPhaseA3 ] = "A3";
        busPhaseNames[ MCS4busPhaseM1 ] = "M1";
        busPhaseNames[ MCS4busPhaseM2 ] = "M2";
        busPhaseNames[ MCS4busPhaseX1 ] = "X1";
        busPhaseNames[ MCS4busPhaseX2 ] = "X2";
        busPhaseNames[ MCS4busPhaseX3 ] = "X2";
        const char* nm = data.busPhase < sizeof( busPhaseNames ) / sizeof( *busPhaseNames ) ? busPhaseNames[ data.busPhase ] : NULL;

        AddResultString( nm ? nm : "<BUS PHASE INVALID>" );
    }
    else if( channel == mSettings->mBusBit0 )
    { // D0 always shows current 4-bit value

        AnalyzerHelpers::GetNumberString( data.busVal, display_base, 4, number_str, sizeof( number_str ) );
        AddResultString( number_str );
    }
    else if( channel == mSettings->mBusBit1 )
    { // D1 shows full address/value

        if( data.busPhase == MCS4busPhaseA3 )
        {
            AnalyzerHelpers::GetNumberString( data.romAddr, display_base, 12, number_str, sizeof( number_str ) );
            AddResultString( "ROM addr ", number_str );
            AddResultString( number_str ); // shorter string variant
        }
        else if( data.busPhase == MCS4busPhaseM2 )
        {
            AnalyzerHelpers::GetNumberString( data.instrVal, display_base, 8, number_str, sizeof( number_str ) );
            AddResultString( "ROM val ", number_str );
            AddResultString( number_str ); // shorter string variant
        }
    }
    else if( channel == mSettings->mBusBit2 )
    {
        if( data.busPhase == MCS4busPhaseM2 )
        { // D2 shows disassembly, if valid and data flow

            char disasmLong[ 64 ] = {}, disasmMedium[ 64 ] = {}, disasmShort[ 64 ] = {};

            mcs04disasm( disasmLong, disasmMedium, disasmShort, ( enum MCS4prevInstrState )data.prevInstrState, data.prevInstrOPA,
                         data.romAddr, data.instrVal, mSettings->m4040, display_base );
            if( *disasmLong )
                AddResultString( disasmLong );
            if( *disasmMedium )
                AddResultString( disasmMedium );
            if( *disasmShort )
                AddResultString( disasmShort );
        }
        else if( data.busPhase == MCS4busPhaseX3 && data.prevInstrState == MCS4prevInstrNormal )
        { // show effective values on he bus

            switch( data.instrVal & 0xf9 )
            {
            case 0x21:
            case 0x29: // SRC

                AnalyzerHelpers::GetNumberString( data.busValAtX2 * 16 + data.busVal, display_base, 8, number_str, sizeof( number_str ) );
                AddResultString( "(adr ", number_str, ")" );
                AddResultString( "(", number_str, ")" );
                AddResultString( number_str ); // shorter string variant
                break;

            case 0xe0:
            case 0xe1: // mem write
                AnalyzerHelpers::GetNumberString( data.busValAtX2, display_base, 4, number_str, sizeof( number_str ) );
                AddResultString( "(wr ", number_str, ")" );
                AddResultString( "(", number_str, ")" );
                AddResultString( number_str ); // shorter string variant
                break;

            case 0xe8:
            case 0xe9:
                AnalyzerHelpers::GetNumberString( data.busValAtX2, display_base, 4, number_str, sizeof( number_str ) );
                AddResultString( "(rd ", number_str, ")" );
                AddResultString( "(", number_str, ")" );
                AddResultString( number_str ); // shorter string variant
                break;
            }
        }
    }
}

void MCS04AnalyzerResults::GenerateExportFile( const char* file, DisplayBase display_base, U32 export_type_user_id )
{
    std::ofstream file_stream( file, std::ios::out );


    file_stream.close();
}

void MCS04AnalyzerResults::GenerateFrameTabularText( U64 frame_index, DisplayBase display_base )
{
#ifdef SUPPORTS_PROTOCOL_SEARCH
    Frame frame = GetFrame( frame_index );
    ClearTabularText();

    char number_str[ 128 ];
    AnalyzerHelpers::GetNumberString( frame.mData1, display_base, 8, number_str, 128 );
    AddTabularText( number_str );
#endif
}

void MCS04AnalyzerResults::GeneratePacketTabularText( U64 packet_id, DisplayBase display_base )
{
    // not supported
}

void MCS04AnalyzerResults::GenerateTransactionTabularText( U64 transaction_id, DisplayBase display_base )
{
    // not supported
}