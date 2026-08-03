#include <AnalyzerHelpers.h>
#include "MCS04Disasm.h"


static const char* getJcnString( unsigned val )
{
    static const char* conds[] = {
        "NEVER",  "NT", "C",  "NT or C",  "Z",  "NT or Z",  "C or Z",    "NT or C or Z",
        "ALWAYS", "T",  "NC", "T and NC", "NZ", "T and NZ", "NC and NZ", "NC and NZ and T",
    };

    return conds[ val ];
}

static unsigned getShortJumpTarget( unsigned romaddr, unsigned instrVal )
{
    unsigned pc = 0xfff & ( romaddr + 1 );
    unsigned dst = ( pc & 0xf00 ) + ( 0xff & instrVal );

    return dst;
}


void mcs04disasm( char* dLong, char* dMed, char* dShort, enum MCS4prevInstrState prevState, unsigned char prevInstrOPA, unsigned romAddr,
                  unsigned char instr, bool is4040, DisplayBase display_base )
{
    char number_str[ 64 ];

    switch( prevState )
    {
    case MCS4prevInstrNormal:

        switch( instr >> 4 )
        {
        case 0x00:
            if( is4040 )
            {
                static const char mInstrs0[][ 4 ] = { "NOP", "HLT", "BBS", "LCR", "OR4", "OR5", "AN6", "AN7",
                                                      "DB0", "DB1", "SB0", "SB1", "EIN", "DIN", "RPM", "???" };

                strcpy( dLong, mInstrs0[ instr & 15 ] );
            }
            else
            {
                strcpy( dLong, "NOP" );
            }
            break;

        case 0x01:
            snprintf( dLong, 64, "JCN %s, ...", getJcnString( instr & 15 ) );
            strcpy( dMed, "JCN" ); // shorter string variant
            break;

        case 0x02:
            if( instr & 1 )
            {
                snprintf( dLong, 64, "SRC r%u", instr & 14 );
                strcpy( dMed, "SRC" ); // shorter string variant
            }
            else
            {
                snprintf( dLong, 64, "FIM r%u, ...", instr & 14 );
                strcpy( dMed, "FIM" ); // shorter string variant
            }
            break;

        case 0x03:
            snprintf( dLong, 64, "%s r%u, ...", ( instr & 1 ) ? "JIN" : "FIN", instr & 15 );
            strcpy( dMed, ( instr & 1 ) ? "JIN" : "FIN" ); // shorter string variant
            break;

        case 0x04:
            strcpy( dLong, "JUN ..." );
            strcpy( dMed, "JUN" ); // shorter string variant
            break;

        case 0x05:
            strcpy( dLong, "JMS ..." );
            strcpy( dMed, "JMS" ); // shorter string variant
            break;

        case 0x06:
            snprintf( dLong, 64, "INC r%u", instr & 15 );
            strcpy( dMed, "INC" ); // shorter string variant
            break;

        case 0x07:
            snprintf( dLong, 64, "ISZ r%u, ...", instr & 15 );
            strcpy( dMed, "ISZ" ); // shorter string variant
            break;

        case 0x08:
            snprintf( dLong, 64, "ADD r%u", instr & 15 );
            strcpy( dMed, "ADD" ); // shorter string variant
            break;

        case 0x09:
            snprintf( dLong, 64, "SUB r%u", instr & 15 );
            strcpy( dMed, "SUB" ); // shorter string variant
            break;

        case 0x0a:
            snprintf( dLong, 64, "LD r%u", instr & 15 );
            strcpy( dMed, "LD" ); // shorter string variant
            break;

        case 0x0b:
            snprintf( dLong, 64, "XCH r%u", instr & 15 );
            strcpy( dMed, "XCH" ); // shorter string variant
            break;

        case 0x0c:
            AnalyzerHelpers::GetNumberString( instr & 15, display_base, 4, number_str, sizeof( number_str ) );
            snprintf( dLong, 64, "BBL %s", number_str );
            strcpy( dMed, "BBL" ); // shorter string variant
            break;

        case 0x0d:
            AnalyzerHelpers::GetNumberString( instr & 15, display_base, 4, number_str, sizeof( number_str ) );
            snprintf( dLong, 64, "LDM %s", number_str );
            strcpy( dMed, "LDM" ); // shorter string variant
            break;

        case 0x0e:
        {
            static const char memOpsNames[][ 4 ] = { "WRM", "WMP", "WRR", "WPM", "WR0", "WR1", "WR2", "WR3",
                                                     "SBM", "RDM", "RDR", "ADM", "RD0", "RD1", "RD2", "RD3" };
            strcpy( dLong, memOpsNames[ instr & 15 ] );
        }
        break;

        case 0x0f:
            static const char fOpsNames[][ 4 ] = { "CLB", "CLC", "IAC", "CMC", "CMA", "RAL", "RAR", "TCC",
                                                   "DAC", "TCS", "STC", "DAA", "KBP", "DCL", "???", "???" };
            strcpy( dLong, fOpsNames[ instr & 15 ] );
            break;
        }
        break;

    case MCS4prevInstrJCN:
        AnalyzerHelpers::GetNumberString( getShortJumpTarget( romAddr, instr ), display_base, 12, number_str, sizeof( number_str ) );
        snprintf( dLong, 64, "JCN %s, %s", getJcnString( prevInstrOPA ), number_str );
        snprintf( dMed, 64, "JCN %s", getJcnString( prevInstrOPA ) ); // shorter string variant
        strcpy( dShort, "JCN" );                                      // shorter string variant
        break;

    case MCS4prevInstrFIM:
        AnalyzerHelpers::GetNumberString( instr, display_base, 8, number_str, sizeof( number_str ) );
        snprintf( dLong, 64, "FIM r%u, %s", prevInstrOPA & 14, number_str );
        snprintf( dMed, 64, "FIM r%u", prevInstrOPA & 14 ); // shorter string variant
        strcpy( dShort, "FIM" );                            // shorter string variant
        break;

    case MCS4prevInstrJUN:
        AnalyzerHelpers::GetNumberString( 256 * prevInstrOPA + instr, display_base, 12, number_str, sizeof( number_str ) );
        snprintf( dLong, 64, "JUN %s", number_str );
        strcpy( dMed, "JUN" ); // shorter string variant
        break;

    case MCS4prevInstrJMS:
        AnalyzerHelpers::GetNumberString( 256 * prevInstrOPA + instr, display_base, 12, number_str, sizeof( number_str ) );
        snprintf( dLong, 64, "JMS %s", number_str );
        strcpy( dMed, "JMS" ); // shorter string variant
        break;

    case MCS4prevInstrISZ:
        AnalyzerHelpers::GetNumberString( getShortJumpTarget( romAddr, instr ), display_base, 12, number_str, sizeof( number_str ) );
        snprintf( dLong, 64, "ISZ r%u, %s", prevInstrOPA & 15, number_str );
        snprintf( dMed, 64, "ISZ r%u", prevInstrOPA & 15 ); // shorter string variant
        strcpy( dShort, "ISZ" );                            // shorter string variant
        break;
    }
}
