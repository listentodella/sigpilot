#ifndef MCS04_SIMULATION_DATA_GENERATOR
#define MCS04_SIMULATION_DATA_GENERATOR

#include <SimulationChannelDescriptor.h>
#include <string>
class MCS04AnalyzerSettings;

class MCS04SimulationDataGenerator
{
  public:
    MCS04SimulationDataGenerator();
    ~MCS04SimulationDataGenerator();

    void Initialize( U32 simulation_sample_rate, MCS04AnalyzerSettings* settings );
    U32 GenerateSimulationData( U64 newest_sample_requested, U32 sample_rate, SimulationChannelDescriptor** simulation_channel );

  protected:
    MCS04AnalyzerSettings* mSettings;
    U32 mSimulationSampleRateHz;
};
#endif // MCS04_SIMULATION_DATA_GENERATOR