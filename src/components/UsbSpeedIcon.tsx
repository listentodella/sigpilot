import type { SVGProps } from "react";

/**
 * USB link generation, shown in the device list so the connection speed is
 * visible before capture starts.
 *
 * `unknown` covers devices that do not report a link speed — the demo source,
 * and any driver that cannot read it.
 */
export type UsbSpeed = "usb2" | "usb3" | "unknown";

/** Map the host's reported USB link speed onto an icon variant. */
export function usbSpeedFromLinkSpeed(linkSpeed: string | null | undefined): UsbSpeed {
  switch (linkSpeed) {
    case "super":
    case "super-plus":
      return "usb3";
    case "high":
      return "usb2";
    default:
      return "unknown";
  }
}

/** Short label for the speed, for tooltips and accessible names. */
export function usbSpeedLabel(speed: UsbSpeed): string {
  switch (speed) {
    case "usb3":
      return "USB 3 (SuperSpeed)";
    case "usb2":
      return "USB 2 (High Speed)";
    default:
      return "USB";
  }
}

interface UsbSpeedIconProps extends Omit<SVGProps<SVGSVGElement>, "name"> {
  speed: UsbSpeed;
  /**
   * Tooltip text. Rendered as a nested `<title>` element rather than the `title`
   * attribute: `React.SVGProps` does not carry `title` (SVGAttributes does not
   * extend HTMLAttributes), and the nested element is the SVG-native way to get
   * a hover tooltip.
   */
  title?: string;
}

/**
 * USB trident with the link generation as a superscript.
 *
 * Drawn in-house rather than pulled from another project's icon set: the
 * obvious upstream source (DreamSourceLab DSView) is GPL-3.0, and this
 * workspace is MIT/Apache with a stated policy of not copying GPL assets into
 * it. Keeping the mark here also lets it inherit `currentColor`, which an
 * `<img src="*.svg">` asset cannot do.
 *
 * Colour is a secondary cue only — the superscript digit carries the same
 * information, so the icon still reads without colour vision. USB 2 is green,
 * USB 3 is blue; the tint lives in the stylesheet, not here.
 */
export function UsbSpeedIcon({ speed, title, className, ...props }: UsbSpeedIconProps) {
  const trident = (
    <>
      <circle cx="6.5" cy="12.3" r="1.5" fill="currentColor" stroke="none" />
      <path d="M6.5 10.8V3.0" />
      <path d="M6.5 0.9 5.3 3.1h2.4z" fill="currentColor" stroke="none" />
      <path d="M6.5 8.6 3.6 6.5V5.4" />
      <circle cx="3.6" cy="4.1" r="1.3" fill="currentColor" stroke="none" />
      <path d="M6.5 7.0l2.9-2.1V3.8" />
      <rect x="8.2" y="1.2" width="2.4" height="2.4" rx="0.4" fill="currentColor" stroke="none" />
    </>
  );

  const classes = [
    "usbSpeedIcon",
    speed === "usb2" ? "usbSpeedIconUsb2" : null,
    speed === "usb3" ? "usbSpeedIconUsb3" : null,
    className,
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <svg
      aria-hidden="true"
      className={classes}
      fill="none"
      height={14}
      role="presentation"
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth="1.2"
      viewBox="0 0 22 14"
      width={22}
      {...props}
    >
      {title ? <title>{title}</title> : null}
      {speed === "unknown" ? <g transform="translate(4 0)">{trident}</g> : trident}
      {speed !== "unknown" && (
        <text
          fill="currentColor"
          fontSize="11"
          fontWeight="700"
          stroke="none"
          x="13.4"
          y="12.4"
        >
          {speed === "usb3" ? "3" : "2"}
        </text>
      )}
    </svg>
  );
}
