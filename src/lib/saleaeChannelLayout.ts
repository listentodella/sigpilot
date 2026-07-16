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

  const rowsAreaHeight = Math.max(
    0,
    availableHeight -
      SALEAE_ROW_V2_CONTAINER_PADDING_PX -
      SALEAE_TIME_RULER_HEIGHT_PX -
      SALEAE_ROW_V2_SPACING_PX * Math.max(channelIndexes.length - 1, 0),
  );
  const desiredHeight = Math.max(
    SALEAE_DIGITAL_ROW_V2_MIN_HEIGHT_PX,
    Math.floor(rowsAreaHeight / channelIndexes.length),
  );
  const maximumHeight = Math.max(
    SALEAE_DIGITAL_ROW_AUTOSIZE_MAX_PX,
    availableHeight * SALEAE_DIGITAL_ROW_AUTOSIZE_MAX_PERCENT,
  );
  const fittedHeight = Math.min(desiredHeight, maximumHeight);
  return channelIndexes.map(() => fittedHeight);
}

export function saleaeChannelContentHeight(rowHeights: number[]) {
  return (
    SALEAE_ROW_V2_CONTAINER_PADDING_PX +
    SALEAE_TIME_RULER_HEIGHT_PX +
    rowHeights.reduce((total, height) => total + height, 0) +
    SALEAE_ROW_V2_SPACING_PX * Math.max(rowHeights.length - 1, 0)
  );
}

export function saleaeChannelResizeHandleTop(rowHeights: number[], rowIndex: number) {
  return (
    SALEAE_ROW_V2_CONTAINER_PADDING_PX +
    SALEAE_TIME_RULER_HEIGHT_PX +
    rowHeights.slice(0, rowIndex + 1).reduce((total, height) => total + height, 0) +
    SALEAE_ROW_V2_SPACING_PX * rowIndex
  );
}
