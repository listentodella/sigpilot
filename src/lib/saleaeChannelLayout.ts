// Ported from Logic 2.4.43 RowsManager/defaults.ts and RowsManager.fitAllChannelsToWindow().
export const SALEAE_DEFAULT_DIGITAL_ROW_HEIGHT_PX = 100;
export const SALEAE_DIGITAL_ROW_V2_MIN_HEIGHT_PX = 28;
export const SALEAE_DIGITAL_ROW_AUTOSIZE_MAX_PX = 200;
export const SALEAE_DIGITAL_ROW_AUTOSIZE_MAX_PERCENT = 0.5;
export const SALEAE_ROW_V2_SPACING_PX = 4;
export const SALEAE_ROW_V2_CONTAINER_PADDING_PX = 4;
export const SALEAE_TIME_RULER_HEIGHT_PX = 30;

export function makeSaleaeDigitalRowHeights(channelCount = 32, existing: number[] = []) {
  return Array.from(
    { length: Math.max(1, channelCount) },
    (_, index) => existing[index] ?? SALEAE_DEFAULT_DIGITAL_ROW_HEIGHT_PX,
  );
}

/** Allocate the visible height after reserving decoder strips and row gaps.
 * Minimums may require scrolling; oversized stored/manual heights do not.
 */
export function fitChannelRowsToViewport(
  availableHeight: number,
  rows: { minHeight: number; maxHeight?: number; topInset?: number }[],
) {
  if (!rows.length) return [];
  let remaining = Math.max(0, availableHeight - SALEAE_ROW_V2_CONTAINER_PADDING_PX
    - SALEAE_ROW_V2_SPACING_PX * (rows.length - 1)
    - rows.reduce((sum, row) => sum + (row.topInset ?? 0), 0));
  const heights = rows.map(() => 0);
  let pending = rows.map((_, index) => index);
  // Satisfy larger minimums first, then distribute the rest evenly. Caps may
  // leave spare room when only a few digital channels are visible.
  while (pending.length) {
    const share = remaining / pending.length;
    const belowMinimum = pending.filter((index) => rows[index].minHeight > share);
    const fixed = belowMinimum.length ? belowMinimum
      : pending.filter((index) => (rows[index].maxHeight ?? Infinity) < share);
    if (!fixed.length) {
      for (const index of pending) heights[index] = Math.floor(share);
      break;
    }
    for (const index of fixed) {
      heights[index] = belowMinimum.length ? rows[index].minHeight : rows[index].maxHeight!;
      remaining -= heights[index];
    }
    const fixedSet = new Set(fixed);
    pending = pending.filter((index) => !fixedSet.has(index));
  }
  return heights;
}

export function fitSaleaeDigitalRowsToViewport({
  availableHeight,
  channelIndexes,
  storedHeights,
  manualLayout,
}: {
  availableHeight: number;
  channelIndexes: number[];
  storedHeights: number[];
  manualLayout: boolean;
}) {
  if (channelIndexes.length === 0) return [];

  if (manualLayout) {
    return channelIndexes.map((channelIndex) =>
      Math.max(
        SALEAE_DIGITAL_ROW_V2_MIN_HEIGHT_PX,
        storedHeights[channelIndex] ?? SALEAE_DEFAULT_DIGITAL_ROW_HEIGHT_PX,
      ),
    );
  }

  const maximumHeight = Math.max(
    SALEAE_DIGITAL_ROW_AUTOSIZE_MAX_PX,
    availableHeight * SALEAE_DIGITAL_ROW_AUTOSIZE_MAX_PERCENT,
  );
  return fitChannelRowsToViewport(availableHeight, channelIndexes.map(() => ({
    minHeight: SALEAE_DIGITAL_ROW_V2_MIN_HEIGHT_PX, maxHeight: maximumHeight,
  })));
}

export function saleaeChannelContentHeight(rowHeights: number[]) {
  return (
    SALEAE_ROW_V2_CONTAINER_PADDING_PX +
    rowHeights.reduce((total, height) => total + height, 0) +
    SALEAE_ROW_V2_SPACING_PX * Math.max(rowHeights.length - 1, 0)
  );
}

export function saleaeChannelResizeHandleTop(rowHeights: number[], rowIndex: number) {
  return (
    SALEAE_ROW_V2_CONTAINER_PADDING_PX +
    rowHeights.slice(0, rowIndex + 1).reduce((total, height) => total + height, 0) +
    SALEAE_ROW_V2_SPACING_PX * rowIndex
  );
}
