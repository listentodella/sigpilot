// Verifies minimum-pulse-width tracking on the compatibility runtime.
//
// The previous implementation was `return 0`, which is wrong twice over: `0` is
// the "not set" marker internally and the original reports "not set" as
// UINT64_MAX. See docs/libanalyzer-ida-analysis.md §10-11 for the decompiled
// original (DigitalChannelData vtable+56 and the update in AdvanceToNextEdge).

#include <AnalyzerChannelData.h>
#include <MockChannelData.h>
#include <TestInstance.h>

#include <cstdio>
#include <limits>

namespace
{

int failures = 0;

void check_eq(U64 got, U64 want, const char* what)
{
    const bool ok = got == want;
    std::printf("%s  %-54s got=%llu want=%llu\n", ok ? "ok  " : "FAIL", what,
                static_cast<unsigned long long>(got), static_cast<unsigned long long>(want));
    if (!ok)
        ++failures;
}

const U64 UNSET = std::numeric_limits<U64>::max();

} // namespace

int main()
{
    using namespace AnalyzerTest;

    // Absolute edges 10, 30, 100 -> gaps 20 then 70: min stays at 20.
    // (TestAppendTransitions takes deltas, so append absolute samples instead.)
    {
        Instance plugin;
        MockChannelData channel(&plugin);
        channel.TestSetInitialBitState(BIT_LOW);
        for (U64 edge : {10, 30, 100}) channel.TestAppendTransitionAtSamples(edge);
        channel.ResetCurrentSample();

        check_eq(channel.GetMinimumPulseWidthSoFar(), UNSET, "no edge seen yet -> UINT64_MAX");
        channel.AdvanceToNextEdge();
        check_eq(channel.GetMinimumPulseWidthSoFar(), UNSET, "one edge seen -> still unset");
        channel.AdvanceToNextEdge();
        check_eq(channel.GetMinimumPulseWidthSoFar(), 20, "second edge -> min 20");
        channel.AdvanceToNextEdge();
        check_eq(channel.GetMinimumPulseWidthSoFar(), 20, "wider gap 70 -> min stays 20");
    }

    // A later, shorter pulse must lower the minimum.
    {
        Instance plugin;
        MockChannelData channel(&plugin);
        channel.TestSetInitialBitState(BIT_LOW);
        for (U64 edge : {100, 300, 305}) channel.TestAppendTransitionAtSamples(edge);
        channel.ResetCurrentSample();

        channel.AdvanceToNextEdge();
        channel.AdvanceToNextEdge();
        check_eq(channel.GetMinimumPulseWidthSoFar(), 200, "gap 200 -> min 200");
        channel.AdvanceToNextEdge();
        check_eq(channel.GetMinimumPulseWidthSoFar(), 5, "shorter gap 5 -> min 5");
    }

    // Skipping ahead must still fold in every edge crossed.
    {
        Instance plugin;
        MockChannelData channel(&plugin);
        channel.TestSetInitialBitState(BIT_LOW);
        for (U64 edge : {10, 40, 45, 200}) channel.TestAppendTransitionAtSamples(edge);
        channel.ResetCurrentSample();

        channel.AdvanceToAbsPosition(100);
        check_eq(channel.GetMinimumPulseWidthSoFar(), 5, "advance past edges folds them in");
    }

    // Repeated calls must not re-scan from zero and must stay stable.
    {
        Instance plugin;
        MockChannelData channel(&plugin);
        channel.TestSetInitialBitState(BIT_LOW);
        for (U64 edge : {10, 30, 100}) channel.TestAppendTransitionAtSamples(edge);
        channel.ResetCurrentSample();
        channel.AdvanceToNextEdge();
        channel.AdvanceToNextEdge();
        channel.AdvanceToNextEdge();

        check_eq(channel.GetMinimumPulseWidthSoFar(), 20, "first call");
        check_eq(channel.GetMinimumPulseWidthSoFar(), 20, "repeat call is stable");
        check_eq(channel.GetMinimumPulseWidthSoFar(), 20, "third call is stable");
    }

    // ResetCurrentSample rewinds the cursor; the running minimum must restart
    // rather than keep reporting the previous run's value.
    {
        Instance plugin;
        MockChannelData channel(&plugin);
        channel.TestSetInitialBitState(BIT_LOW);
        for (U64 edge : {10, 30, 100}) channel.TestAppendTransitionAtSamples(edge);
        channel.ResetCurrentSample();
        channel.AdvanceToNextEdge();
        channel.AdvanceToNextEdge();
        check_eq(channel.GetMinimumPulseWidthSoFar(), 20, "before rewind -> 20");

        channel.ResetCurrentSample();
        check_eq(channel.GetMinimumPulseWidthSoFar(), UNSET, "after rewind -> unset again");
        channel.AdvanceToNextEdge();
        channel.AdvanceToNextEdge();
        check_eq(channel.GetMinimumPulseWidthSoFar(), 20, "re-tracking after rewind -> 20");
    }

    std::printf("\n%s\n", failures == 0 ? "ALL PASS" : "FAILURES");
    return failures == 0 ? 0 : 1;
}
