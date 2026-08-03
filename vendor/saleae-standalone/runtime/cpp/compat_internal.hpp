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
void ClearFramesFor(const AnalyzerResults* results);

} // namespace SaleaeCompat

#endif
