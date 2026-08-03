#ifndef MCS04_ANALYZER_DISASM
#define MCS04_ANALYZER_DISASM

enum MCS4prevInstrState
{
    MCS4prevInstrNormal,
    MCS4prevInstrJCN,
    MCS4prevInstrFIM,
    MCS4prevInstrJUN,
    MCS4prevInstrJMS,
    MCS4prevInstrISZ,
};

// char arrays need to be 64 big at least
void mcs04disasm( char* dLong, char* dMed, char* dShort, enum MCS4prevInstrState prevState, unsigned char prevInstrOPA, unsigned romAddr,
                  unsigned char instr, bool is4040, DisplayBase display_base );


#endif // MCS04_ANALYZER_SETTINGS
