#ifndef PXLOGIC_SALEAE_RESULT_CAPTURE_H
#define PXLOGIC_SALEAE_RESULT_CAPTURE_H

#include <AnalyzerResults.h>

#include <cstdint>
#include <optional>
#include <string>
#include <utility>
#include <variant>
#include <vector>

using PxlogicSaleaeFieldValue =
    std::variant<std::string, double, std::int64_t, bool, std::uint8_t, std::vector<std::uint8_t>>;

class FrameV2Data
{
  public:
    std::vector<std::pair<std::string, PxlogicSaleaeFieldValue>> fields;
};

namespace PxlogicSaleae
{

struct CapturedFrame
{
    S64 start_sample = 0;
    S64 end_sample = 0;
    U64 data1 = 0;
    U64 data2 = 0;
    U8 type = 0;
    U8 flags = 0;
    std::string row;
    std::vector<std::pair<std::string, PxlogicSaleaeFieldValue>> fields;
    std::optional<U64> legacy_frame_id;
};

struct CapturedMarker
{
    U64 sample = 0;
    AnalyzerResults::MarkerType type = AnalyzerResults::Dot;
    Channel channel;
};

struct ResultStore
{
    std::vector<CapturedFrame> frames;
    std::vector<std::size_t> legacy_frame_indices;
    std::vector<U64> packet_starts;
    std::vector<U64> commit_frames;
    std::vector<CapturedMarker> markers;
    std::vector<std::string> strings;
    std::vector<std::string> tabular_text;
    bool cancelled = false;
};

ResultStore* GetResultStore(AnalyzerResults* results);

} // namespace PxlogicSaleae

#endif
