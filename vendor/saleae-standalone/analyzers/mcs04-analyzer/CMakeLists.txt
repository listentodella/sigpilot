cmake_minimum_required (VERSION 3.11)
project(mcs04_analyzer)

add_definitions( -DLOGIC2 )

set(CMAKE_OSX_DEPLOYMENT_TARGET "10.14" CACHE STRING "Minimum supported MacOS version" FORCE)

# enable generation of compile_commands.json, helpful for IDEs to locate include files.
set(CMAKE_EXPORT_COMPILE_COMMANDS ON)

# custom CMake Modules are located in the cmake directory.
set(CMAKE_MODULE_PATH ${PROJECT_SOURCE_DIR}/cmake)

include(ExternalAnalyzerSDK)

set(SOURCES 
src/MCS04Analyzer.cpp
src/MCS04Analyzer.h
src/MCS04AnalyzerResults.cpp
src/MCS04AnalyzerResults.h
src/MCS04AnalyzerSettings.cpp
src/MCS04AnalyzerSettings.h
src/MCS04Disasm.cpp
src/MCS04Disasm.h
src/MCS04SimulationDataGenerator.cpp
src/MCS04SimulationDataGenerator.h
)

add_analyzer_plugin(mcs04_analyzer SOURCES ${SOURCES})
