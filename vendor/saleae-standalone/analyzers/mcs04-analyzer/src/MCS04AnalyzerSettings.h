#ifndef MCS04_ANALYZER_SETTINGS
#define MCS04_ANALYZER_SETTINGS

#include <AnalyzerSettings.h>
#include <AnalyzerTypes.h>

class MCS04AnalyzerSettings : public AnalyzerSettings
{
  public:
    MCS04AnalyzerSettings();
    virtual ~MCS04AnalyzerSettings();

    virtual bool SetSettingsFromInterfaces();
    void UpdateInterfacesFromSettings();
    virtual void LoadSettings( const char* settings );
    virtual const char* SaveSettings();


    Channel mBusBit0, mBusBit1, mBusBit2, mBusBit3, mBusClk1, mBusClk2, mBusSync;
    bool m4040;

  protected:
    AnalyzerSettingInterfaceChannel mBusBit0Interface, mBusBit1Interface, mBusBit2Interface, mBusBit3Interface, mBusClk1Interface,
        mBusClk2Interface, mBusSyncInterface;
    AnalyzerSettingInterfaceBool m4040Interface;
};

#endif // MCS04_ANALYZER_SETTINGS
