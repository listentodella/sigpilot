import { useCallback, useRef, useState } from "react";
import { createPortal } from "react-dom";

const POPOVER_WIDTH = 240;

/**
 * A "?" affordance with a hover/focus explanation.
 *
 * The popover is portalled and positioned from the icon's rect rather than being
 * a CSS ::after on the row: the advanced options live in a scrolling sidebar
 * column, and an in-flow tooltip would be clipped by it.
 */
export function HelpHint({ text }: { text: string }) {
  const anchorRef = useRef<HTMLSpanElement | null>(null);
  const [position, setPosition] = useState<{ left: number; top: number } | null>(null);

  const show = useCallback(() => {
    const rect = anchorRef.current?.getBoundingClientRect();
    if (!rect) return;
    const left = Math.min(
      Math.max(8, rect.left + rect.width / 2 - POPOVER_WIDTH / 2),
      Math.max(8, window.innerWidth - POPOVER_WIDTH - 8),
    );
    // `top` is the icon's top edge; the popover is translated up by its own
    // height so it always sits above the icon.
    setPosition({ left, top: rect.top - 6 });
  }, []);
  const hide = useCallback(() => setPosition(null), []);

  return (
    <>
      <span
        aria-label={text}
        className="helpHint"
        onBlur={hide}
        onFocus={show}
        onMouseEnter={show}
        onMouseLeave={hide}
        ref={anchorRef}
        role="img"
        tabIndex={0}
      >
        ?
      </span>
      {position
        ? createPortal(
            <div className="helpHintPopover" role="tooltip" style={{ left: position.left, top: position.top, width: POPOVER_WIDTH }}>
              {text}
            </div>,
            document.body,
          )
        : null}
    </>
  );
}
