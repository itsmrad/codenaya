import { cn } from "@/lib/utils";

export interface CodenayaLogoProps extends React.SVGProps<SVGSVGElement> {
  size?: number | string;
  blinking?: boolean;
  /** Hide from assistive tech when nearby text already says what it means. */
  decorative?: boolean;
}

/**
 * Official Codenaya Brand Mark:
 * - Canvas: 120 x 120 units
 * - Ring: Outer radius 50, inner radius 28, stroke 22
 * - Opening: 76°, cut square along the radius
 * - Cursor: 14 x 28 with a 2 unit corner radius
 * - Gap: 3 units between the cursor and each end of the ring
 * - Optical centre: x = 59
 *
 * The ring inherits the text colour (currentColor); the cursor is --brand.
 */
export function CodenayaLogo({
  size = 24,
  className,
  blinking = false,
  decorative = false,
  ...props
}: CodenayaLogoProps) {
  const a11y = decorative
    ? { "aria-hidden": true }
    : { role: "img", "aria-label": "Codenaya" };

  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 120 120"
      width={size}
      height={size}
      fill="none"
      className={cn("shrink-0 select-none", className)}
      {...a11y}
      {...props}
    >
      <path
        fill="currentColor"
        d="M99.4 29.2A50 50 0 1 0 99.4 90.8L82.1 77.2A28 28 0 1 1 82.1 42.8Z"
      />
      <rect
        x="94"
        y="46"
        width="14"
        height="28"
        rx="2"
        fill="var(--brand)"
        className={cn(blinking && "animate-logo-cursor-blink motion-reduce:animate-none")}
      />
    </svg>
  );
}
