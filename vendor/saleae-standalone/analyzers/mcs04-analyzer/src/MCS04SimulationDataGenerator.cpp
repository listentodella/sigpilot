#include "MCS04SimulationDataGenerator.h"
#include "MCS04AnalyzerSettings.h"

#include <AnalyzerHelpers.h>

MCS04SimulationDataGenerator::MCS04SimulationDataGenerator()
{
}

MCS04SimulationDataGenerator::~MCS04SimulationDataGenerator()
{
}

void MCS04SimulationDataGenerator::Initialize( U32 simulation_sample_rate, MCS04AnalyzerSettings* settings )
{
    mSimulationSampleRateHz = simulation_sample_rate;
    mSettings = settings;
}

U32 MCS04SimulationDataGenerator::GenerateSimulationData( U64 largest_sample_requested, U32 sample_rate,
                                                          SimulationChannelDescriptor** simulation_channel )
{
    *simulation_channel = NULL;
    return 0;
}
