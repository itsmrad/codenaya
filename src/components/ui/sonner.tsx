"use client"

import {
  CircleCheckIcon,
  InfoIcon,
  Loader2Icon,
  OctagonXIcon,
  TriangleAlertIcon,
} from "lucide-react"
import { useTheme } from "next-themes"
import { Toaster as Sonner, type ToasterProps } from "sonner"

const Toaster = ({ ...props }: ToasterProps) => {
  const { theme = "system" } = useTheme()

  return (
    <Sonner
      theme={theme as ToasterProps["theme"]}
      className="toaster group"
      icons={{
        success: <CircleCheckIcon className="size-4" />,
        info: <InfoIcon className="size-4" />,
        warning: <TriangleAlertIcon className="size-4" />,
        error: <OctagonXIcon className="size-4" />,
        loading: <Loader2Icon className="size-4 animate-spin" />,
      }}
      style={
        {
          "--normal-bg": "var(--popover)",
          "--normal-text": "var(--popover-foreground)",
          "--normal-border": "var(--border)",
          "--border-radius": "6px",
        } as React.CSSProperties
      }
      // The site's look: a brand edge on the left (red for errors), a brand
      // success icon, mono descriptions and action.
      toastOptions={{
        classNames: {
          toast:
            "gap-3! font-sans! shadow-[inset_2px_0_0_var(--brand),0_16px_48px_-20px_rgb(0_0_0/0.35)]!",
          title: "text-[13px]! font-medium!",
          description: "font-mono! text-[10px]! uppercase! tracking-[0.1em]! text-muted-foreground!",
          success: "[&_[data-icon]]:text-brand",
          error: "shadow-[inset_2px_0_0_var(--destructive),0_16px_48px_-20px_rgb(0_0_0/0.35)]! [&_[data-icon]]:text-destructive",
          actionButton:
            "rounded-sm! bg-brand! font-mono! text-[10px]! uppercase! tracking-[0.1em]! text-brand-foreground!",
        },
      }}
      {...props}
    />
  )
}

export { Toaster }
