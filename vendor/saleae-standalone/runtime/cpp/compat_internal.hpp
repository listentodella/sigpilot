#ifndef SALEAE_COMPAT_INTERNAL_HPP
#define SALEAE_COMPAT_INTERNAL_HPP

#include <AnalyzerResults.h>

#include <cstdint>
#include <string>
#include <vector>

class AnalyzerChannelData;

namespace SaleaeCompat
{

enum class FieldKind
{
    String,
    Double,
    Integer,
    Boolean,
    Byte,
    Bytes
};

struct Field
{
    std::string key;
    FieldKind kind = FieldKind::String;
    std::string string_value;
    std::vector<std::uint8_t> bytes_value;
    std::int64_t integer_value = 0;
    double double_value = 0.0;
    bool boolean_value = false;
};

struct Frame
{
    std::string type;
    std::uint64_t start_sample = 0;
    std::uint64_t end_sample = 0;
    std::vector<Field> fields;
};

void RegisterChannelData(const void* group, AnalyzerChannelData* channel);
void ClearChannelDataGroup(const void* group);
const std::vector<Frame>& FramesFor(const AnalyzerResults* results);
void AppendFramesFor(
    const AnalyzerResults* results,
    std::size_t start_index,
    std::vector<Frame>& output);
void ClearFramesFor(const AnalyzerResults* results);

/**
 * Trigger position reported to analyzers via Analyzer::GetTriggerSample().
 *
 * The vendored testlib hardcodes this to 2, which is wrong in two ways: it is
 * not a real trigger position, and analyzers use it to render timestamps
 * (`AnalyzerHelpers::GetTimeString(sample, trigger_sample, ...)` computes
 * `sample - trigger_sample`), so every exported timestamp was offset. The
 * original reads it from the DeviceCollection and reports 0 when there is no
 * trigger (docs/libanalyzer-ida-analysis.md §10). 0 here means the same thing:
 * times are relative to the start of the capture.
 */
std::uint64_t TriggerSample();
void SetTriggerSample(std::uint64_t sample);

} // namespace SaleaeCompat

#endif
