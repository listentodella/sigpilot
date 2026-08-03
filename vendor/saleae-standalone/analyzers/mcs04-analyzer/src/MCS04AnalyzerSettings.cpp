#include "MCS04AnalyzerSettings.h"
#include <AnalyzerHelpers.h>


MCS04AnalyzerSettings::MCS04AnalyzerSettings()
    : mBusBit0( UNDEFINED_CHANNEL ),
      mBusBit1( UNDEFINED_CHANNEL ),
      mBusBit2( UNDEFINED_CHANNEL ),
      mBusBit3( UNDEFINED_CHANNEL ),
      mBusClk1( UNDEFINED_CHANNEL ),
      mBusClk2( UNDEFINED_CHANNEL ),
      mBusSync( UNDEFINED_CHANNEL ),
      m4040( false ),
      mBusBit0Interface(),
      mBusBit1Interface(),
      mBusBit2Interface(),
      mBusBit3Interface(),
      mBusClk1Interface(),
      mBusClk2Interface(),
      mBusSyncInterface(),
      m4040Interface()
{
    mBusBit0Interface.SetTitleAndTooltip( "Data 0", "Data 0 line of the bus" );
    mBusBit1Interface.SetTitleAndTooltip( "Data 1", "Data 1 line of the bus" );
    mBusBit2Interface.SetTitleAndTooltip( "Data 2", "Data 2 line of the bus" );
    mBusBit3Interface.SetTitleAndTooltip( "Data 3", "Data 3 line of the bus" );
    mBusClk1Interface.SetTitleAndTooltip( "Clock 1", "Clock phase 1 line of the bus" );
    mBusClk2Interface.SetTitleAndTooltip( "Clock 2", "Clock phase 2 line of the bus" );
    mBusSyncInterface.SetTitleAndTooltip( "Sync", "SYNC line of the bus" );
    m4040Interface.SetTitleAndTooltip( "4040", "Support 4040 CPU (more experimental)" );

    mBusBit0Interface.SetChannel( mBusBit0 );
    mBusBit1Interface.SetChannel( mBusBit1 );
    mBusBit2Interface.SetChannel( mBusBit2 );
    mBusBit3Interface.SetChannel( mBusBit3 );
    mBusClk1Interface.SetChannel( mBusClk1 );
    mBusClk2Interface.SetChannel( mBusClk2 );
    mBusSyncInterface.SetChannel( mBusSync );
    m4040Interface.SetValue( m4040 );

    AddInterface( &mBusBit0Interface );
    AddInterface( &mBusBit1Interface );
    AddInterface( &mBusBit2Interface );
    AddInterface( &mBusBit3Interface );
    AddInterface( &mBusClk1Interface );
    AddInterface( &mBusClk2Interface );
    AddInterface( &mBusSyncInterface );
    AddInterface( &m4040Interface );

    ClearChannels();
    AddChannel( mBusBit0, "D0", false );
    AddChannel( mBusBit1, "D1", false );
    AddChannel( mBusBit2, "D2", false );
    AddChannel( mBusBit3, "D3", false );
    AddChannel( mBusClk1, "CLK1", false );
    AddChannel( mBusClk2, "CLK2", false );
    AddChannel( mBusSync, "SYNC", false );
}

MCS04AnalyzerSettings::~MCS04AnalyzerSettings()
{
}

bool MCS04AnalyzerSettings::SetSettingsFromInterfaces()
{
    ClearChannels();
    AddChannel( mBusBit0 = mBusBit0Interface.GetChannel(), "D0", true );
    AddChannel( mBusBit1 = mBusBit1Interface.GetChannel(), "D1", true );
    AddChannel( mBusBit2 = mBusBit2Interface.GetChannel(), "D2", true );
    AddChannel( mBusBit3 = mBusBit3Interface.GetChannel(), "D3", true );
    AddChannel( mBusClk1 = mBusClk1Interface.GetChannel(), "CLK1", true );
    AddChannel( mBusClk2 = mBusClk2Interface.GetChannel(), "CLK2", true );
    AddChannel( mBusSync = mBusSyncInterface.GetChannel(), "SYNC", true );
    m4040 = m4040Interface.GetValue();

    return true;
}

void MCS04AnalyzerSettings::UpdateInterfacesFromSettings()
{
    mBusBit0Interface.SetChannel( mBusBit0 );
    mBusBit1Interface.SetChannel( mBusBit1 );
    mBusBit2Interface.SetChannel( mBusBit2 );
    mBusBit3Interface.SetChannel( mBusBit3 );
    mBusClk1Interface.SetChannel( mBusClk1 );
    mBusClk2Interface.SetChannel( mBusClk2 );
    mBusSyncInterface.SetChannel( mBusSync );
    m4040Interface.SetValue( m4040 );
}

void MCS04AnalyzerSettings::LoadSettings( const char* settings )
{
    SimpleArchive text_archive;
    text_archive.SetString( settings );

    text_archive >> mBusBit0;
    text_archive >> mBusBit1;
    text_archive >> mBusBit2;
    text_archive >> mBusBit3;
    text_archive >> mBusClk1;
    text_archive >> mBusClk2;
    text_archive >> mBusSync;
    text_archive >> m4040;

    ClearChannels();
    AddChannel( mBusBit0, "D0", true );
    AddChannel( mBusBit1, "D1", true );
    AddChannel( mBusBit2, "D2", true );
    AddChannel( mBusBit3, "D3", true );
    AddChannel( mBusClk1, "CLK1", true );
    AddChannel( mBusClk2, "CLK2", true );
    AddChannel( mBusSync, "SYNC", true );

    UpdateInterfacesFromSettings();
}

const char* MCS04AnalyzerSettings::SaveSettings()
{
    SimpleArchive text_archive;

    text_archive << mBusBit0;
    text_archive << mBusBit1;
    text_archive << mBusBit2;
    text_archive << mBusBit3;
    text_archive << mBusClk1;
    text_archive << mBusClk2;
    text_archive << mBusSync;
    text_archive << m4040;

    return SetReturnString( text_archive.GetString() );
}
