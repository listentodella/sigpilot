import {
  SALEAE_DEFAULT_DIGITAL_ROW_HEIGHT_PX,
  SALEAE_DIGITAL_ROW_V2_MIN_HEIGHT_PX,
  SALEAE_ROW_V2_SPACING_PX,
} from "./saleaeChannelLayout";

export interface SaleaeGraphChannelLayout {
  height: number;
  outerHeight: number;
  outerTop: number;
  top: number;
}

export function getSaleaeGraphChannelLayout(
  rowHeights: number[],
  channelCount: number,
  scale = 1,
  rowTopInsets: number[] = [],
): SaleaeGraphChannelLayout[] {
  let top = 0;
  return Array.from({ length: channelCount }, (_, index) => {
    const outerHeight =
      Math.max(
        SALEAE_DIGITAL_ROW_V2_MIN_HEIGHT_PX,
        rowHeights[index] ?? SALEAE_DEFAULT_DIGITAL_ROW_HEIGHT_PX,
      ) * scale;
    const inset = Math.max(0, rowTopInsets[index] ?? 0) * scale;
    const layout = {
      height: Math.max(scale, outerHeight - inset),
      outerHeight,
      outerTop: top,
      top: top + inset,
    };
    top += outerHeight + SALEAE_ROW_V2_SPACING_PX * scale;
    return layout;
  });
}

export function findSaleaeGraphChannelIndexAtY(layout: SaleaeGraphChannelLayout[], y: number) {
  for (let index = 0; index < layout.length; index += 1) {
    const row = layout[index];
    if (y >= row.top && y <= row.top + row.height) return index;
  }
  return null;
}
