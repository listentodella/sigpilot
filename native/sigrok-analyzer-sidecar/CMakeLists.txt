cmake_minimum_required(VERSION 3.20)

project(sigpilot_sigrok_analyzer_sidecar C)

set(CMAKE_C_STANDARD 11)
set(CMAKE_C_STANDARD_REQUIRED ON)
set(CMAKE_POSITION_INDEPENDENT_CODE ON)

get_filename_component(SIGPILOT_ROOT "${CMAKE_CURRENT_SOURCE_DIR}/../.." ABSOLUTE)
set(PXVIEW_VENDOR_ROOT "${SIGPILOT_ROOT}/vendor/pxview-sigrokdecode")
if(EXISTS "${PXVIEW_VENDOR_ROOT}/libsigrokdecode")
    set(PXVIEW_DEFAULT_ROOT "${PXVIEW_VENDOR_ROOT}")
else()
    set(PXVIEW_DEFAULT_ROOT "${SIGPILOT_ROOT}/pxview-fork")
endif()
set(PXVIEW_ROOT "${PXVIEW_DEFAULT_ROOT}" CACHE PATH "PXView source tree")

find_package(PkgConfig REQUIRED)
pkg_check_modules(GLIB REQUIRED IMPORTED_TARGET glib-2.0)
find_package(Python3 REQUIRED COMPONENTS Development)

set(SIGROKDECODE_SOURCES
    ${PXVIEW_ROOT}/libsigrokdecode/type_decoder.c
    ${PXVIEW_ROOT}/libsigrokdecode/srd.c
    ${PXVIEW_ROOT}/libsigrokdecode/module_sigrokdecode.c
    ${PXVIEW_ROOT}/libsigrokdecode/decoder.c
    ${PXVIEW_ROOT}/libsigrokdecode/dll_registry.c
    ${PXVIEW_ROOT}/libsigrokdecode/error.c
    ${PXVIEW_ROOT}/libsigrokdecode/exception.c
    ${PXVIEW_ROOT}/libsigrokdecode/instance.c
    ${PXVIEW_ROOT}/libsigrokdecode/log.c
    ${PXVIEW_ROOT}/libsigrokdecode/session.c
    ${PXVIEW_ROOT}/libsigrokdecode/util.c
    ${PXVIEW_ROOT}/libsigrokdecode/version.c
    ${PXVIEW_ROOT}/libsigrokdecode/c_decoder_api.c
    ${PXVIEW_ROOT}/common/log/xlog.c
)

add_library(pxview_sigrokdecode STATIC ${SIGROKDECODE_SOURCES})
target_include_directories(pxview_sigrokdecode PRIVATE
    ${PXVIEW_ROOT}/libsigrokdecode
    ${PXVIEW_ROOT}/common
)
target_link_libraries(pxview_sigrokdecode PRIVATE PkgConfig::GLIB Python3::Python)

set(DECODER_OUTPUT_DIR "${CMAKE_BINARY_DIR}/decoders/c_decoders")
set(PXVIEW_C_DECODER_TARGETS)
function(add_pxview_c_decoder protocol)
    set(target "pxview_${protocol}_c")
    add_library(${target} MODULE
        ${PXVIEW_ROOT}/libsigrokdecode/c_decoders/${protocol}_c.c
        ${PXVIEW_ROOT}/libsigrokdecode/c_decoder_api.c
    )
    target_compile_definitions(${target} PRIVATE SRD_C_DECODER_DLL)
    target_include_directories(${target} PRIVATE
        ${PXVIEW_ROOT}/libsigrokdecode
        ${PXVIEW_ROOT}/common
    )
    target_link_libraries(${target} PRIVATE PkgConfig::GLIB)
    set_target_properties(${target} PROPERTIES
        OUTPUT_NAME ${protocol}_c
        PREFIX ""
        LIBRARY_OUTPUT_DIRECTORY "${DECODER_OUTPUT_DIR}"
        BUILD_RPATH "$ORIGIN;$ORIGIN/../.."
    )
    list(APPEND PXVIEW_C_DECODER_TARGETS ${target})
    set(PXVIEW_C_DECODER_TARGETS "${PXVIEW_C_DECODER_TARGETS}" PARENT_SCOPE)
endfunction()

file(GLOB PXVIEW_C_DECODER_SOURCES CONFIGURE_DEPENDS
    "${PXVIEW_ROOT}/libsigrokdecode/c_decoders/*_c.c"
)
foreach(decoder_source IN LISTS PXVIEW_C_DECODER_SOURCES)
    get_filename_component(decoder_file "${decoder_source}" NAME_WE)
    string(REGEX REPLACE "_c$" "" decoder_protocol "${decoder_file}")
    add_pxview_c_decoder("${decoder_protocol}")
endforeach()

add_executable(sigpilot-sigrok-sidecar src/main.c)
set_target_properties(sigpilot-sigrok-sidecar PROPERTIES
    BUILD_RPATH "$ORIGIN"
)
target_compile_definitions(sigpilot-sigrok-sidecar PRIVATE CJSON_IMPLEMENTATION)
target_include_directories(sigpilot-sigrok-sidecar PRIVATE
    ${PXVIEW_ROOT}
    ${PXVIEW_ROOT}/libsigrokdecode
    ${PXVIEW_ROOT}/libsigrokdecode/tests
    ${PXVIEW_ROOT}/common
)
target_link_libraries(sigpilot-sigrok-sidecar PRIVATE
    pxview_sigrokdecode
    PkgConfig::GLIB
    Python3::Python
)
add_dependencies(sigpilot-sigrok-sidecar
    ${PXVIEW_C_DECODER_TARGETS}
)
