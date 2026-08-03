export interface VirtualListWindow {
  end: number;
  endPaddingPx: number;
  start: number;
  startPaddingPx: number;
}

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
  const visibleBottom = listScrollTop + Math.max(rowHeight, viewportHeightPx);
  const overscan = Math.max(0, Math.trunc(overscanRows));
  const start = Math.min(count, Math.max(0, Math.floor(listScrollTop / rowHeight) - overscan));
  const end = Math.max(start, Math.min(count, Math.ceil(visibleBottom / rowHeight) + overscan));
  return {
    end,
    endPaddingPx: Math.max(0, count - end) * rowHeight,
    start,
    startPaddingPx: start * rowHeight,
  };
}
