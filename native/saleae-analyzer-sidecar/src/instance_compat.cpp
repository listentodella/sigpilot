#include "TestInstance.h"

namespace AnalyzerTest
{

Instance::Instance(const std::string&)
{
}

Instance::~Instance() = default;

bool Instance::CheckCancellation() const
{
    return false;
}

OutOfDataException::OutOfDataException() = default;

CancellationException::CancellationException() = default;

} // namespace AnalyzerTest
