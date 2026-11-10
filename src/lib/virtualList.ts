export interface VirtualListWindow {
  end: number;
  endPaddingPx: number;
  start: number;
  startPaddingPx: number;
}

// A broken layout must not turn a content-sized viewport into a full-table
// render. Keep the rest of the rows reachable through the trailing spacer.
export const MAX_VIRTUAL_LIST_ROWS = 512;

export function virtualListWindow(
  itemCount: number,
  rowHeightPx: number,
  scrollTopPx: number,
  viewportHeightPx: number,
  leadingHeightPx = 0,
  overscanRows = 8,
): VirtualListWindow {
  const count = Math.max(0, Math.trunc(itemCount));
  const rowHeight = Math.max(1, rowHeightPx);
  const listScrollTop = Math.max(0, scrollTopPx - Math.max(0, leadingHeightPx));
  const viewportHeight = Number.isFinite(viewportHeightPx) ? viewportHeightPx : rowHeight;
  const visibleBottom = listScrollTop + Math.max(rowHeight, viewportHeight);
  const overscan = Math.max(0, Math.trunc(overscanRows));
  const start = Math.min(count, Math.max(0, Math.floor(listScrollTop / rowHeight) - overscan));
  const end = Math.max(start, Math.min(count, start + MAX_VIRTUAL_LIST_ROWS, Math.ceil(visibleBottom / rowHeight) + overscan));
  return {
    end,
    endPaddingPx: Math.max(0, count - end) * rowHeight,
    start,
    startPaddingPx: start * rowHeight,
  };
}
