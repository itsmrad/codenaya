import { cn } from "@/lib/utils";

interface CodenayaLogoProps extends React.SVGProps<SVGSVGElement> {
  size?: number | string;
  blinking?: boolean;
}

/** Official Codenaya Mark: letter C and Ember block cursor. */
export function CodenayaLogo({
  size = 24,
  className,
  blinking = false,
  ...props
}: CodenayaLogoProps) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 120 120"
      width={size}
      height={size}
      fill="none"
      className={cn("shrink-0 select-none", className)}
      aria-label="Codenaya"
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
        fill="var(--color-brand, #FF5F3A)"
        className={cn(blinking && "animate-[logo-cursor-blink_1s_infinite_ease-in-out]")}
      />
    </svg>
  );
}
