cmake_minimum_required(VERSION 3.20)

project(saleae_compat_runtime LANGUAGES CXX)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)
set(CMAKE_LIBRARY_OUTPUT_DIRECTORY "${CMAKE_BINARY_DIR}/lib")
set(CMAKE_ARCHIVE_OUTPUT_DIRECTORY "${CMAKE_BINARY_DIR}/lib")

if(APPLE AND NOT CMAKE_OSX_ARCHITECTURES)
    set(CMAKE_OSX_ARCHITECTURES "${CMAKE_SYSTEM_PROCESSOR}" CACHE STRING "Target architecture" FORCE)
endif()

set(SALEAE_ROOT "${CMAKE_CURRENT_SOURCE_DIR}/..")
set(SALEAE_SDK_ROOT "${SALEAE_ROOT}/sdk/AnalyzerSDK")
set(SALEAE_TESTLIB_ROOT "${SALEAE_SDK_ROOT}/testlib")

file(READ "${SALEAE_TESTLIB_ROOT}/MockResults.cpp" MOCK_RESULTS_SOURCE)
string(REPLACE
    "Frame::Frame()\n{\n}"
    "Frame::Frame()\n    : mStartingSampleInclusive(0), mEndingSampleInclusive(0), mData1(0), mData2(0), mType(0), mFlags(0)\n{\n}"
    MOCK_RESULTS_SOURCE
    "${MOCK_RESULTS_SOURCE}"
)
file(WRITE "${CMAKE_CURRENT_BINARY_DIR}/MockResultsCompat.cpp" "${MOCK_RESULTS_SOURCE}")

add_library(saleae_compat SHARED
    "${SALEAE_TESTLIB_ROOT}/AnalyzerStubs.cpp"
    "${SALEAE_TESTLIB_ROOT}/HelperStubs.cpp"
    "${SALEAE_TESTLIB_ROOT}/MockChannelData.cpp"
    "${CMAKE_CURRENT_BINARY_DIR}/MockResultsCompat.cpp"
    "${SALEAE_TESTLIB_ROOT}/SettingsStubs.cpp"
    "${SALEAE_TESTLIB_ROOT}/StreamHelpers.cpp"
    cpp/compat_extensions.cpp
    cpp/runtime_c_api.cpp
    cpp/simulation_compat.cpp
)
set_target_properties(saleae_compat PROPERTIES
    RUNTIME_OUTPUT_DIRECTORY "${CMAKE_BINARY_DIR}/lib"
    LIBRARY_OUTPUT_DIRECTORY "${CMAKE_BINARY_DIR}/lib"
    ARCHIVE_OUTPUT_DIRECTORY "${CMAKE_BINARY_DIR}/lib")
target_compile_definitions(saleae_compat PUBLIC LOGIC2)
target_include_directories(saleae_compat
    PUBLIC
        "${CMAKE_CURRENT_SOURCE_DIR}/include"
        "${SALEAE_SDK_ROOT}/include"
    PRIVATE
        "${SALEAE_TESTLIB_ROOT}"
        "${CMAKE_CURRENT_SOURCE_DIR}/cpp"
)
if(WIN32)
    set_target_properties(saleae_compat PROPERTIES WINDOWS_EXPORT_ALL_SYMBOLS ON)
elseif(APPLE)
    set_target_properties(saleae_compat PROPERTIES BUILD_RPATH "@loader_path")
else()
    set_target_properties(saleae_compat PROPERTIES BUILD_RPATH "$ORIGIN")
endif()
target_link_libraries(saleae_compat PRIVATE ${CMAKE_DL_LIBS})

add_library(Saleae::AnalyzerSDK ALIAS saleae_compat)

set(CMAKE_RUNTIME_OUTPUT_DIRECTORY "${CMAKE_BINARY_DIR}/lib")
set(CMAKE_LIBRARY_OUTPUT_DIRECTORY "${CMAKE_BINARY_DIR}/lib")

set(SALEAE_ANALYZER_CATALOG
    "async-rgb-led-analyzer|async_rgb_led_analyzer"
    "atmel-swi-analyzer|atmel_swi_analyzer"
    "biss-analyzer|biss_analyzer"
    "can-analyzer|can_analyzer"
    "dmx-512-analyzer|dmx_512_analyzer"
    "hd44780-analyzer|hd44780_analyzer"
    "hdlc-analyzer|hdlc_analyzer"
    "hdmi-cec-analyzer|hdmi_cec_analyzer"
    "i2c-analyzer|i2c_analyzer"
    "i2s-analyzer|i2s_analyzer"
    "jtag-analyzer|jtag_analyzer"
    "lin-analyzer|lin_analyzer"
    "manchester-analyzer|manchester_analyzer"
    "mcs04-analyzer|mcs04_analyzer"
    "mdio-analyzer|mdio_analyzer"
    "midi-analyzer|midi_analyzer"
    "modbus-analyzer|modbus_analyzer"
    "one-wire-analyzer|one_wire_analyzer"
    "ps2-keyboard-analyzer|ps2_keyboard_analyzer"
    "serial-analyzer|serial_analyzer"
    "simple-parallel-analyzer|simple_parallel_analyzer"
    "smbus-analyzer|smbus_analyzer"
    "spi-analyzer|spi_analyzer"
    "swd-analyzer|swd_analyzer"
    "unio-analyzer|unio_analyzer"
    "usb-analyzer|usb_analyzer"
)

set(SALEAE_ANALYZERS "all" CACHE STRING
    "Semicolon-separated analyzer directory names without -analyzer, or 'all'")
set_property(CACHE SALEAE_ANALYZERS PROPERTY STRINGS all i2c spi serial can lin)

if(SALEAE_ANALYZERS STREQUAL "all")
    set(SALEAE_SELECTED_ANALYZERS ${SALEAE_ANALYZER_CATALOG})
else()
    set(SALEAE_SELECTED_ANALYZERS)
    foreach(ANALYZER_NAME IN LISTS SALEAE_ANALYZERS)
        set(ANALYZER_FOUND FALSE)
        foreach(ANALYZER_ENTRY IN LISTS SALEAE_ANALYZER_CATALOG)
            string(REPLACE "|" ";" ANALYZER_PARTS "${ANALYZER_ENTRY}")
            list(GET ANALYZER_PARTS 0 ANALYZER_DIRECTORY)
            string(REGEX REPLACE "-analyzer$" "" ANALYZER_SHORT_NAME "${ANALYZER_DIRECTORY}")
            if(ANALYZER_NAME STREQUAL ANALYZER_SHORT_NAME OR
               ANALYZER_NAME STREQUAL ANALYZER_DIRECTORY)
                list(APPEND SALEAE_SELECTED_ANALYZERS "${ANALYZER_ENTRY}")
                set(ANALYZER_FOUND TRUE)
                break()
            endif()
        endforeach()
        if(NOT ANALYZER_FOUND)
            message(FATAL_ERROR "Unknown analyzer '${ANALYZER_NAME}'")
        endif()
    endforeach()
endif()

install(TARGETS saleae_compat
    LIBRARY DESTINATION Analyzers
    RUNTIME DESTINATION Analyzers
)
install(FILES include/saleae_compat.h DESTINATION include)

foreach(ANALYZER_ENTRY IN LISTS SALEAE_SELECTED_ANALYZERS)
    string(REPLACE "|" ";" ANALYZER_PARTS "${ANALYZER_ENTRY}")
    list(GET ANALYZER_PARTS 0 ANALYZER_DIRECTORY)
    list(GET ANALYZER_PARTS 1 ANALYZER_TARGET)
    add_subdirectory(
        "${SALEAE_ROOT}/analyzers/${ANALYZER_DIRECTORY}"
        "${ANALYZER_DIRECTORY}"
    )
    set_target_properties(${ANALYZER_TARGET} PROPERTIES
        RUNTIME_OUTPUT_DIRECTORY "${CMAKE_BINARY_DIR}/lib"
        LIBRARY_OUTPUT_DIRECTORY "${CMAKE_BINARY_DIR}/lib"
    )
    if(APPLE)
        set_target_properties(${ANALYZER_TARGET} PROPERTIES
            BUILD_RPATH "@loader_path"
            INSTALL_RPATH "@loader_path")
    elseif(UNIX)
        set_target_properties(${ANALYZER_TARGET} PROPERTIES
            BUILD_RPATH "$ORIGIN"
            INSTALL_RPATH "$ORIGIN")
    endif()
    install(FILES "${SALEAE_ROOT}/analyzers/${ANALYZER_DIRECTORY}/LICENSE"
        DESTINATION "licenses/${ANALYZER_DIRECTORY}"
    )
endforeach()
