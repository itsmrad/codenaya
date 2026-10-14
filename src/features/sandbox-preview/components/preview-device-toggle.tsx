"use client";

import { MonitorIcon, SmartphoneIcon, TabletIcon } from "lucide-react";

import { Button } from "@/components/ui/button";

import { createStoredChoice } from "../hooks/use-stored-choice";

export type PreviewDevice = "desktop" | "tablet" | "mobile";

/** Frame width per device; `null` lets the preview fill the panel. */
export const PREVIEW_DEVICE_WIDTHS: Record<PreviewDevice, number | null> = {
  desktop: null,
  tablet: 768,
  mobile: 375,
};

const DEVICES = [
  { value: "desktop", label: "Desktop", icon: MonitorIcon },
  { value: "tablet", label: "Tablet (768px)", icon: TabletIcon },
  { value: "mobile", label: "Mobile (375px)", icon: SmartphoneIcon },
] as const;

const isPreviewDevice = (value: unknown): value is PreviewDevice =>
  typeof value === "string" && Object.hasOwn(PREVIEW_DEVICE_WIDTHS, value);

/** The preview device choice, persisted per browser. */
export const usePreviewDevice = createStoredChoice<PreviewDevice>(
  "codenaya:preview-device",
  isPreviewDevice,
  "desktop",
);

export const PreviewDeviceToggle = ({
  device,
  onChange,
}: {
  device: PreviewDevice;
  onChange: (device: PreviewDevice) => void;
}) => (
  <div
    role="group"
    aria-label="Preview device size"
    className="flex items-center p-0.5 bg-muted/40 rounded-lg border border-border/50"
  >
    {DEVICES.map(({ value, label, icon: Icon }) => (
      <Button
        key={value}
        size="icon"
        variant={device === value ? "secondary" : "ghost"}
        className="size-8 rounded-md shadow-none"
        title={label}
        aria-label={label}
        aria-pressed={device === value}
        onClick={() => onChange(value)}
      >
        <Icon className="size-4" />
      </Button>
    ))}
  </div>
);
