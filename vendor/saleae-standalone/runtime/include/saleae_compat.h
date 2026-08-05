#ifndef SALEAE_COMPAT_H
#define SALEAE_COMPAT_H

#include <stddef.h>
#include <stdint.h>

#if defined(_WIN32)
#if defined(SALEAE_COMPAT_BUILD)
#define SALEAE_COMPAT_API __declspec(dllexport)
#else
#define SALEAE_COMPAT_API __declspec(dllimport)
#endif
#else
#define SALEAE_COMPAT_API
#endif

#ifdef __cplusplus
extern "C" {
#endif

typedef struct sr_session sr_session;

typedef enum sr_setting_kind
{
    SR_SETTING_CHANNEL = 1,
    SR_SETTING_NUMBER_LIST = 2,
    SR_SETTING_INTEGER = 3,
    SR_SETTING_BOOL = 4,
    SR_SETTING_TEXT = 5
} sr_setting_kind;

typedef struct sr_setting_view
{
    const char* title;
    const char* tooltip;
    sr_setting_kind kind;
    int channel_required;
    double number_value;
    int integer_value;
    int minimum_value;
    int maximum_value;
    const char* text_value;
    size_t option_count;
} sr_setting_view;

typedef struct sr_number_option_view
{
    const char* label;
    const char* tooltip;
    double value;
} sr_number_option_view;

typedef enum sr_field_kind
{
    SR_FIELD_STRING = 1,
    SR_FIELD_DOUBLE = 2,
    SR_FIELD_INTEGER = 3,
    SR_FIELD_BOOLEAN = 4,
    SR_FIELD_BYTE = 5,
    SR_FIELD_BYTES = 6
} sr_field_kind;

typedef struct sr_frame_view
{
    const char* type;
    uint64_t start_sample;
    uint64_t end_sample;
    size_t field_count;
} sr_frame_view;

typedef struct sr_field_view
{
    const char* key;
    sr_field_kind kind;
    const char* string_value;
    const uint8_t* bytes_value;
    size_t bytes_length;
    int64_t integer_value;
    double double_value;
    int boolean_value;
} sr_field_view;

typedef struct sr_legacy_frame_view
{
    int64_t start_sample;
    int64_t end_sample;
    uint64_t data1;
    uint64_t data2;
    uint8_t type;
    uint8_t flags;
} sr_legacy_frame_view;

typedef struct sr_simulation_channel_view
{
    uint32_t channel_index;
    int initial_high;
    uint64_t sample_count;
    const uint64_t* transition_samples;
    size_t transition_count;
} sr_simulation_channel_view;

typedef struct sr_marker_view
{
    uint64_t sample;
    uint32_t channel_index;
    int kind;
} sr_marker_view;

SALEAE_COMPAT_API sr_session* sr_session_create(const char* plugin_path);
SALEAE_COMPAT_API void sr_session_destroy(sr_session* session);

SALEAE_COMPAT_API const char* sr_session_analyzer_name(const sr_session* session);
SALEAE_COMPAT_API const char* sr_session_last_error(const sr_session* session);

SALEAE_COMPAT_API int sr_session_set_sample_rate(sr_session* session, uint64_t sample_rate_hz);
SALEAE_COMPAT_API int sr_session_set_number_setting(sr_session* session, const char* setting_title, double value);
SALEAE_COMPAT_API int sr_session_set_integer_setting(sr_session* session, const char* setting_title, int value);
SALEAE_COMPAT_API int sr_session_set_bool_setting(sr_session* session, const char* setting_title, int value);
SALEAE_COMPAT_API int sr_session_set_text_setting(sr_session* session, const char* setting_title, const char* value);
SALEAE_COMPAT_API size_t sr_session_setting_count(sr_session* session);
SALEAE_COMPAT_API int sr_session_setting(sr_session* session, size_t index, sr_setting_view* output);
SALEAE_COMPAT_API int sr_session_number_option(
    sr_session* session,
    size_t setting_index,
    size_t option_index,
    sr_number_option_view* output);
SALEAE_COMPAT_API size_t sr_session_channel_setting_count(sr_session* session);
SALEAE_COMPAT_API const char* sr_session_channel_setting_title(sr_session* session, size_t index);
SALEAE_COMPAT_API int sr_session_add_channel(
    sr_session* session,
    const char* setting_title,
    uint32_t channel_index,
    int initial_high,
    const uint64_t* transition_samples,
    size_t transition_count);
SALEAE_COMPAT_API int sr_session_commit_settings(sr_session* session);
SALEAE_COMPAT_API int sr_session_run(sr_session* session);
SALEAE_COMPAT_API int sr_session_generate_simulation(sr_session* session, uint64_t sample_count, uint32_t sample_rate_hz);
SALEAE_COMPAT_API size_t sr_session_simulation_channel_count(const sr_session* session);
SALEAE_COMPAT_API int sr_session_simulation_channel(
    const sr_session* session,
    size_t index,
    sr_simulation_channel_view* output);
SALEAE_COMPAT_API int sr_session_generate_bubble_text(
    sr_session* session,
    size_t legacy_frame_index,
    uint32_t channel_index,
    int display_base);
SALEAE_COMPAT_API size_t sr_session_bubble_text_count(const sr_session* session);
SALEAE_COMPAT_API const char* sr_session_bubble_text(const sr_session* session, size_t index);
SALEAE_COMPAT_API size_t sr_session_marker_count(const sr_session* session);
SALEAE_COMPAT_API int sr_session_marker(const sr_session* session, size_t index, sr_marker_view* output);

SALEAE_COMPAT_API size_t sr_session_frame_count(const sr_session* session);
SALEAE_COMPAT_API int sr_session_frame(const sr_session* session, size_t index, sr_frame_view* output);
SALEAE_COMPAT_API int sr_session_frame_field(
    const sr_session* session,
    size_t frame_index,
    size_t field_index,
    sr_field_view* output);
SALEAE_COMPAT_API size_t sr_session_legacy_frame_count(const sr_session* session);
SALEAE_COMPAT_API int sr_session_legacy_frame(
    const sr_session* session,
    size_t index,
    sr_legacy_frame_view* output);

#ifdef __cplusplus
}
#endif

#endif
