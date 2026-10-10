//! Session view state.
//!
//! Saleae keeps the viewport on the graph backend: the frontend sends gesture
//! intents and the backend owns the authoritative view. SigPilot used to do the
//! opposite, which forced the frontend to *also* own level-of-detail selection,
//! request rate limiting, raster caching and staleness guards — every one of
//! which is a place where the graph can end up in a state the user has to nudge
//! back into shape.
//!
//! This module moves the authoritative value and its clamping rules down to the
//! backend. The rules themselves are a faithful port of
//! `src/lib/captureViewport.ts`, so behaviour does not change when the frontend
//! stops doing the arithmetic.

use serde::{Deserialize, Serialize};
use std::time::{Duration, Instant};

/// Logic 2's DataLimited mode permits zooming and panning while at least 40% of
/// the viewport still intersects captured data.
pub const MIN_CAPTURE_DATA_VISIBLE_RATIO: f64 = 0.4;
/// A live capture keeps this much time zoomable even before the data exists.
pub const LIVE_CAPTURE_RESERVED_VIEW_SECONDS: f64 = 500.0;
/// How much of a live capture is shown by default, and the floor under it. These
/// mirror `src/lib/liveViewport.ts`: a live session follows a fixed-width window
/// at the tail rather than fitting whatever has arrived so far, because fitting
/// the whole capture would zoom out continuously as data streams in.
pub const DEFAULT_CAPTURE_VIEW_SECONDS: f64 = 1.0;
pub const MINIMUM_DEFAULT_CAPTURE_VIEW_SAMPLES: u64 = 100_000;

/// A single gesture may not scale the view by more than this. It exists purely
/// so a bogus factor cannot fling the viewport to a state nothing can recover
/// from; the frontend already clamps its own wheel factor far below it.
const MAX_ZOOM_FACTOR_PER_INTENT: f64 = 1_000.0;
const MIN_ZOOM_FACTOR_PER_INTENT: f64 = 0.001;

/// The finest horizontal span worth showing, in seconds.
///
/// Below this the viewport stops resolving signal edges and starts resolving
/// individual samples: the renderer has more per-sample work to do every frame
/// while showing the user nothing they can act on, and the zoom controls stop
/// meaning anything. Logic 2 stops at a comparable span. Change this one number
/// to move the limit.
pub const MINIMUM_VIEW_SECONDS: f64 = 5e-6;

/// `MINIMUM_VIEW_SECONDS` expressed in samples for a given sample rate.
pub fn minimum_view_samples(sample_rate_hz: f64) -> f64 {
    (finite_or(sample_rate_hz, 1.0).max(1.0) * MINIMUM_VIEW_SECONDS).max(1.0)
}

fn finite_or(value: f64, fallback: f64) -> f64 {
    if value.is_finite() {
        value
    } else {
        fallback
    }
}

/// The authoritative viewport: a fractional start sample and a fractional span.
/// Fractions matter because a zoom anchor must be able to hold a marker exactly
/// under the cursor across a gesture.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct SessionView {
    pub start_sample: f64,
    pub samples: f64,
}

impl SessionView {
    pub fn new(start_sample: f64, samples: f64) -> Self {
        Self {
            start_sample: finite_or(start_sample, 0.0),
            samples: finite_or(samples, 1.0).max(1.0),
        }
    }

    /// The integer window the waveform renderer can use. A viewport that is
    /// partly outside the capture still renders the part that exists, which is
    /// what lets DataLimited zoom-out show empty space next to real data.
    pub fn sample_window(&self, total_samples: u64) -> (u64, u64) {
        let total = total_samples as f64;
        let start = self.start_sample.clamp(0.0, total);
        let end = (self.start_sample + self.samples).clamp(start, total);
        let start_floor = start.floor();
        let count = (end.ceil() - start_floor).max(1.0);
        (start_floor as u64, count as u64)
    }
}

/// Everything the backend needs to clamp a view that the frontend does not
/// already know. `total_samples` is deliberately absent: it comes from the
/// session itself so the two can never disagree.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct ViewLimits {
    pub live: bool,
    /// Per-session ceiling on how far out the user may zoom.
    pub maximum_samples: Option<f64>,
    pub sample_rate_hz: f64,
}

impl Default for ViewLimits {
    fn default() -> Self {
        Self {
            live: false,
            maximum_samples: None,
            sample_rate_hz: 1.0,
        }
    }
}

pub fn maximum_capture_view_samples(total_samples: u64) -> f64 {
    let total = total_samples.max(1) as f64;
    (total / MIN_CAPTURE_DATA_VISIBLE_RATIO).ceil()
}

/// The span a session shows before anyone has moved it: about a second of
/// capture, never less than `MINIMUM_DEFAULT_CAPTURE_VIEW_SAMPLES`, and never
/// more than the capture itself.
pub fn default_capture_view_samples(total_samples: u64, sample_rate_hz: f64) -> f64 {
    let preferred = (MINIMUM_DEFAULT_CAPTURE_VIEW_SAMPLES as f64).max(
        (finite_or(sample_rate_hz, 1.0).max(1.0) * DEFAULT_CAPTURE_VIEW_SECONDS).round(),
    );
    preferred.min(total_samples.max(1) as f64).max(1.0)
}

pub fn maximum_live_capture_view_samples(total_samples: u64, sample_rate_hz: f64) -> f64 {
    let reserved = (finite_or(sample_rate_hz, 1.0).max(1.0) * LIVE_CAPTURE_RESERVED_VIEW_SECONDS).round();
    maximum_capture_view_samples(total_samples).max(reserved)
}

/// The widest span a session's limits allow.
///
/// One definition, used both by the normalizers below and by the zoom-out factor
/// clamp in `GraphSession::apply_view_intent`. Those two have to agree exactly:
/// if the zoom is computed against a different ceiling than the one the result is
/// normalized against, the span and the start disagree by the difference and the
/// view slides sideways whenever a gesture lands on the limit.
pub fn maximum_view_samples(total_samples: u64, limits: &ViewLimits) -> f64 {
    let requested = finite_or(limits.maximum_samples.unwrap_or(0.0), 0.0).round();
    if limits.live {
        maximum_live_capture_view_samples(total_samples, limits.sample_rate_hz).max(requested)
    } else {
        maximum_capture_view_samples(total_samples).max(requested)
    }
}

pub fn normalize_capture_view(
    start: f64,
    samples: f64,
    total_samples: u64,
    maximum_samples: Option<f64>,
) -> SessionView {
    let total = total_samples.max(1) as f64;
    let data_limited_maximum = maximum_capture_view_samples(total_samples);
    let requested_maximum = finite_or(maximum_samples.unwrap_or(0.0), 0.0).round();
    let maximum = data_limited_maximum.max(requested_maximum);
    let next_samples = finite_or(samples, 1.0).max(1.0).min(maximum);
    if next_samples > data_limited_maximum {
        // Past the data limit the capture is pinned to the left edge; there is
        // no meaningful pan range left.
        return SessionView {
            start_sample: 0.0,
            samples: next_samples,
        };
    }
    let minimum_start = -(1.0 - MIN_CAPTURE_DATA_VISIBLE_RATIO) * next_samples;
    let maximum_start = total - MIN_CAPTURE_DATA_VISIBLE_RATIO * next_samples;
    let next_start = finite_or(start, 0.0).clamp(minimum_start, maximum_start);
    SessionView {
        start_sample: next_start,
        samples: next_samples,
    }
}

pub fn normalize_live_capture_view(
    start: f64,
    samples: f64,
    total_samples: u64,
    sample_rate_hz: f64,
    maximum_samples: Option<f64>,
) -> SessionView {
    let total = total_samples.max(1) as f64;
    let ceiling = maximum_live_capture_view_samples(total_samples, sample_rate_hz)
        .max(finite_or(maximum_samples.unwrap_or(0.0), 0.0).round());
    let next_samples = finite_or(samples, 1.0).max(1.0).min(ceiling);
    if next_samples >= total {
        return SessionView {
            start_sample: 0.0,
            samples: next_samples,
        };
    }
    normalize_capture_view(start, next_samples, total_samples, maximum_samples)
}

/// A gesture, not a window. The frontend says what the user did; the backend
/// decides where that lands.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum ViewIntent {
    /// Render wherever the session already is. The per-frame loop sends this
    /// when no new gesture arrived, which keeps an in-flight glide running and
    /// leaves the viewport untouched. It exists so "no intent" can keep meaning
    /// "use the explicit range" for callers that have not migrated.
    KeepCurrent,
    /// Replace the viewport outright: opening a capture, zoom to fit, jumping to
    /// an edge, or a scrollbar drag that already knows its target.
    Set { start_sample: f64, samples: f64 },
    /// Shift the viewport by a sample delta. The caller owns the gesture sign
    /// convention — dragging and wheel scrolling are opposite — and the backend
    /// only applies and clamps it.
    ///
    /// A delta rather than a destination is what makes this safe to send while a
    /// glide is running: it is applied to whatever the view is at that moment, so
    /// the caller never has to guess a position it may be behind on. `duration_ms`
    /// behaves as it does on `Zoom`.
    PanSamples {
        delta_samples: f64,
        #[serde(default)]
        duration_ms: f64,
    },
    /// Multiply the visible span around an anchor expressed as a ratio of the
    /// canvas width (0 = left edge, 1 = right edge). Anchoring is the part that
    /// is easy to get subtly wrong, so it lives here where it can be tested.
    ///
    /// `duration_ms` above zero glides to the result instead of jumping to it.
    /// A discrete input — one wheel notch, one keypress — is a single hard step,
    /// and showing it instantly reads as a jump; the glide is what makes it
    /// legible. Continuous input (a touchpad stream) leaves this at zero, because
    /// it already updates every frame and interpolating each event would fight
    /// itself. This mirrors how Logic 2 splits the two.
    Zoom {
        factor: f64,
        anchor_ratio: f64,
        #[serde(default)]
        duration_ms: f64,
    },
    /// Glide to a viewport over `duration_ms`. The backend owns the animation
    /// and interpolates it per requested frame, so the frontend never runs a
    /// second clock that can drift from the one the data was rendered against.
    AnimateTo {
        start_sample: f64,
        samples: f64,
        duration_ms: f64,
    },
}

impl ViewIntent {
    /// Animating intents are the only ones that leave an animation running.
    pub fn is_animated(&self) -> bool {
        matches!(self, ViewIntent::AnimateTo { .. })
    }

    /// Whether this intent leaves the session's own view alone. Such intents
    /// must not cancel an animation.
    pub fn is_passive(&self) -> bool {
        matches!(self, ViewIntent::KeepCurrent)
    }

    /// Applies an instantaneous intent. `AnimateTo` has no single answer, so it
    /// returns the start of its glide and the caller is expected to have started
    /// an animation instead. `KeepCurrent` has no answer at all.
    pub fn apply(&self, current: SessionView) -> SessionView {
        match *self {
            ViewIntent::KeepCurrent => current,
            ViewIntent::Set {
                start_sample,
                samples,
            } => SessionView::new(start_sample, samples),
            ViewIntent::PanSamples { delta_samples, .. } => SessionView::new(
                current.start_sample + finite_or(delta_samples, 0.0),
                current.samples,
            ),
            ViewIntent::Zoom {
                factor,
                anchor_ratio,
                ..
            } => {
                let factor = finite_or(factor, 1.0)
                    .clamp(MIN_ZOOM_FACTOR_PER_INTENT, MAX_ZOOM_FACTOR_PER_INTENT);
                let anchor = finite_or(anchor_ratio, 0.5).clamp(0.0, 1.0);
                let anchor_sample = current.start_sample + current.samples * anchor;
                let next_samples = (current.samples * factor).max(1.0);
                SessionView::new(anchor_sample - next_samples * anchor, next_samples)
            }
            ViewIntent::AnimateTo {
                start_sample,
                samples,
                ..
            } => SessionView::new(start_sample, samples),
        }
    }
}

/// Saleae runs view animations on the graph backend so the animated view and the
/// view the data was rendered for are produced by the same clock. Same reasoning
/// here: the frontend only says "glide there over N ms".
#[derive(Debug, Clone, Copy)]
pub struct ViewAnimation {
    pub from: SessionView,
    pub started_at: Instant,
    pub duration: Duration,
    pub to: SessionView,
}

impl ViewAnimation {
    pub fn new(from: SessionView, to: SessionView, duration: Duration) -> Self {
        Self {
            from,
            started_at: Instant::now(),
            duration,
            to,
        }
    }

    /// `None` once the glide has finished, at which point the caller should
    /// settle on `to` and drop the animation.
    pub fn sample(&self) -> Option<SessionView> {
        let progress = if self.duration.is_zero() {
            1.0
        } else {
            (self.started_at.elapsed().as_secs_f64() / self.duration.as_secs_f64()).clamp(0.0, 1.0)
        };
        if progress >= 1.0 {
            return None;
        }
        let eased = ease_out_cubic(progress);
        Some(SessionView::new(
            self.from.start_sample + (self.to.start_sample - self.from.start_sample) * eased,
            self.from.samples + (self.to.samples - self.from.samples) * eased,
        ))
    }
}

/// Matches the frontend's `easeOutCubic`, so a ported animation curve does not
/// change shape when it moves to the backend.
pub fn ease_out_cubic(progress: f64) -> f64 {
    let inverted = 1.0 - progress.clamp(0.0, 1.0);
    1.0 - inverted * inverted * inverted
}

#[cfg(test)]
mod tests {
    use super::*;

    fn assert_close(actual: f64, expected: f64) {
        assert!(
            (actual - expected).abs() < 1e-6,
            "expected {expected}, got {actual}"
        );
    }

    #[test]
    fn zoom_out_stops_when_forty_percent_of_the_viewport_is_data() {
        // 1_000 samples of data: the widest useful view keeps 400 of them visible.
        let maximum = maximum_capture_view_samples(1_000);
        assert_close(maximum, 2_500.0);

        let view = normalize_capture_view(0.0, 10_000.0, 1_000, None);
        assert_close(view.samples, 2_500.0);
        // Past the data limit the capture pins to the left edge.
        assert_close(view.start_sample, 0.0);
    }

    #[test]
    fn panning_stops_before_the_viewport_leaves_the_capture() {
        let total = 1_000;
        let samples = 400.0;
        let minimum_start = -(1.0 - MIN_CAPTURE_DATA_VISIBLE_RATIO) * samples;
        let maximum_start = total as f64 - MIN_CAPTURE_DATA_VISIBLE_RATIO * samples;

        assert_close(
            normalize_capture_view(-10_000.0, samples, total, None).start_sample,
            minimum_start,
        );
        assert_close(
            normalize_capture_view(10_000.0, samples, total, None).start_sample,
            maximum_start,
        );
        // A legal start is preserved exactly.
        assert_close(
            normalize_capture_view(300.0, samples, total, None).start_sample,
            300.0,
        );
    }

    #[test]
    fn a_session_ceiling_can_zoom_out_further_than_the_data_limit() {
        let view = normalize_capture_view(0.0, 100_000.0, 1_000, Some(50_000.0));
        assert_close(view.samples, 50_000.0);
        assert_close(view.start_sample, 0.0);
    }

    #[test]
    fn a_live_capture_keeps_a_reserved_zoom_out_range() {
        let total = 1_000;
        let rate = 1_000_000.0;
        let ceiling = maximum_live_capture_view_samples(total, rate);
        assert_close(ceiling, 500_000_000.0);

        let view = normalize_live_capture_view(0.0, 10_000_000.0, total, rate, None);
        assert_close(view.samples, 10_000_000.0);
    }

    #[test]
    fn a_live_viewport_covering_everything_pins_to_the_left_edge() {
        let view = normalize_live_capture_view(500.0, 1_000.0, 1_000, 1_000_000.0, None);
        assert_close(view.samples, 1_000.0);
        assert_close(view.start_sample, 0.0);
    }

    #[test]
    fn non_finite_input_never_poisons_the_view() {
        let view = normalize_capture_view(f64::NAN, f64::NAN, 1_000, None);
        assert!(view.start_sample.is_finite());
        assert!(view.samples.is_finite());
        assert!(view.samples >= 1.0);
    }

    #[test]
    fn zoom_holds_the_anchor_sample_under_the_cursor() {
        let current = SessionView::new(100.0, 400.0);
        let anchor_ratio = 0.25;
        let anchor_sample = current.start_sample + current.samples * anchor_ratio;

        let zoomed_in = ViewIntent::Zoom {
            factor: 0.5,
            anchor_ratio,
            duration_ms: 0.0,
        }
        .apply(current);
        assert_close(zoomed_in.samples, 200.0);
        assert_close(
            zoomed_in.start_sample + zoomed_in.samples * anchor_ratio,
            anchor_sample,
        );

        let zoomed_out = ViewIntent::Zoom {
            factor: 2.0,
            anchor_ratio,
            duration_ms: 0.0,
        }
        .apply(current);
        assert_close(zoomed_out.samples, 800.0);
        assert_close(
            zoomed_out.start_sample + zoomed_out.samples * anchor_ratio,
            anchor_sample,
        );
    }

    #[test]
    fn pan_and_set_are_applied_without_extra_policy() {
        let current = SessionView::new(100.0, 400.0);
        let panned = ViewIntent::PanSamples {
            delta_samples: -25.0,
            duration_ms: 0.0,
        }
        .apply(current);
        assert_close(panned.start_sample, 75.0);
        assert_close(panned.samples, 400.0);

        let set = ViewIntent::Set {
            start_sample: 7.0,
            samples: 9.0,
        }
        .apply(current);
        assert_close(set.start_sample, 7.0);
        assert_close(set.samples, 9.0);
    }

    #[test]
    fn an_absurd_zoom_factor_is_bounded() {        let current = SessionView::new(0.0, 1_000.0);
        let tiny = ViewIntent::Zoom {
            factor: f64::MIN_POSITIVE,
            anchor_ratio: 0.5,
            duration_ms: 0.0,
        }
        .apply(current);
        assert!(tiny.samples >= 1.0);

        let huge = ViewIntent::Zoom {
            factor: f64::MAX,
            anchor_ratio: 0.5,
            duration_ms: 0.0,
        }
        .apply(current);
        assert_close(huge.samples, 1_000.0 * MAX_ZOOM_FACTOR_PER_INTENT);
    }

    #[test]
    fn the_sample_window_clips_to_captured_data() {
        // Viewport hangs off the left edge: only the overlapping part renders.
        let view = SessionView::new(-150.0, 400.0);
        assert_eq!(view.sample_window(1_000), (0, 250));

        // Viewport hangs off the right edge.
        let view = SessionView::new(900.0, 400.0);
        assert_eq!(view.sample_window(1_000), (900, 100));

        // Fully inside.
        let view = SessionView::new(100.5, 400.0);
        assert_eq!(view.sample_window(1_000), (100, 401));

        // Entirely past the end still yields a renderable window.
        let view = SessionView::new(5_000.0, 400.0);
        let (start, count) = view.sample_window(1_000);
        assert_eq!(start, 1_000);
        assert_eq!(count, 1);
    }

    // The cases below are copied verbatim from `tests/capture-viewport.test.ts`.
    // Until the frontend stops doing its own clamping, both implementations must
    // agree on these exact numbers or the viewport will jump during the
    // migration. If one side is ever changed deliberately, change both.
    #[test]
    fn port_parity_with_the_typescript_viewport_module() {
        // "DataLimited zoom permits a viewport 2.5 times wider than the capture"
        assert_close(maximum_capture_view_samples(1_000), 2_500.0);
        let view = normalize_capture_view(-750.0, 10_000.0, 1_000, None);
        assert_close(view.samples, 2_500.0);
        assert_close(view.start_sample, -750.0);

        // "DataLimited pan keeps at least 40 percent captured data visible"
        let view = normalize_capture_view(-10_000.0, 500.0, 1_000, None);
        assert_close(view.samples, 500.0);
        assert_close(view.start_sample, -300.0);
        let view = normalize_capture_view(10_000.0, 500.0, 1_000, None);
        assert_close(view.samples, 500.0);
        assert_close(view.start_sample, 800.0);

        // "viewport normalization preserves a fractional zoom anchor"
        let view = normalize_capture_view(125.25, 500.5, 10_000, None);
        assert_close(view.start_sample, 125.25);
        assert_close(view.samples, 500.5);

        // "a completed capture can preserve the wider viewport selected while recording"
        let view = normalize_capture_view(0.0, 500_000_000.0, 1_000_000, Some(500_000_000.0));
        assert_close(view.samples, 500_000_000.0);
        assert_close(view.start_sample, 0.0);
        let view = normalize_capture_view(0.0, 900_000_000.0, 1_000_000, Some(500_000_000.0));
        assert_close(view.samples, 500_000_000.0);
        assert_close(view.start_sample, 0.0);
        assert_close(
            normalize_capture_view(0.0, 500_000_000.0, 1_000_000, None).samples,
            2_500_000.0,
        );

        // "live capture reserves a 500 second zoom-out range"
        assert_close(
            maximum_live_capture_view_samples(1_000_000, 1_000_000.0),
            500_000_000.0,
        );
        let view =
            normalize_live_capture_view(-200_000_000.0, 900_000_000.0, 1_000_000, 1_000_000.0, None);
        assert_close(view.samples, 500_000_000.0);
        assert_close(view.start_sample, 0.0);

        // "loaded data uses the same 500 second zoom-out range as capture"
        let maximum = maximum_live_capture_view_samples(1_000_000, 1_000_000.0);
        assert_close(maximum, 500_000_000.0);
        let view = normalize_capture_view(200_000.0, 900_000_000.0, 1_000_000, Some(maximum));
        assert_close(view.samples, 500_000_000.0);
        assert_close(view.start_sample, 0.0);

        // "live wide viewports stay left anchored as capture data grows"
        let initial = normalize_live_capture_view(0.0, 500_000_000.0, 2_000_000, 1_000_000.0, None);
        let growing = normalize_live_capture_view(
            initial.start_sample,
            initial.samples,
            20_000_000,
            1_000_000.0,
            None,
        );
        assert_close(initial.samples, 500_000_000.0);
        assert_close(initial.start_sample, 0.0);
        assert_close(growing.samples, 500_000_000.0);
        assert_close(growing.start_sample, 0.0);

        // "backend data windows exclude viewport whitespace"
        assert_eq!(
            SessionView::new(-750.0, 2_500.0).sample_window(1_000),
            (0, 1_000)
        );
        assert_eq!(
            SessionView::new(-100.0, 500.0).sample_window(1_000),
            (0, 400)
        );
    }

    #[test]
    fn ease_out_cubic_matches_the_frontend_curve() {
        assert_close(ease_out_cubic(0.0), 0.0);
        assert_close(ease_out_cubic(1.0), 1.0);
        // The frontend's easeOutCubic is 1 - (1 - p)^3. If that ever changes,
        // ported animations would change shape without anyone noticing.
        for progress in [0.1_f64, 0.25, 0.5, 0.75, 0.9] {
            let expected = 1.0 - (1.0 - progress).powi(3);
            assert_close(ease_out_cubic(progress), expected);
        }
        // Out-of-range input is clamped rather than extrapolated.
        assert_close(ease_out_cubic(-1.0), 0.0);
        assert_close(ease_out_cubic(2.0), 1.0);
    }

    #[test]
    fn an_animation_reports_its_origin_while_running_and_nothing_once_done() {
        let from = SessionView::new(0.0, 1_000.0);
        let to = SessionView::new(500.0, 100.0);

        // A zero-length glide has already arrived.
        assert!(ViewAnimation::new(from, to, Duration::ZERO).sample().is_none());

        // A long glide is still essentially at its origin.
        let running = ViewAnimation::new(from, to, Duration::from_secs(30));
        let sampled = running.sample().expect("glide is still running");
        assert!((sampled.samples - from.samples).abs() < 10.0);
        assert!((sampled.start_sample - from.start_sample).abs() < 10.0);
    }
}
