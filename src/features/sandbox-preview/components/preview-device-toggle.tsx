"use client";

import { useCallback, useSyncExternalStore } from "react";
import { MonitorIcon, SmartphoneIcon, TabletIcon } from "lucide-react";

import { Button } from "@/components/ui/button";

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

const STORAGE_KEY = "codenaya:preview-device";
const listeners = new Set<() => void>();
let currentDevice: PreviewDevice | null = null;

const isPreviewDevice = (value: unknown): value is PreviewDevice =>
  typeof value === "string" && Object.hasOwn(PREVIEW_DEVICE_WIDTHS, value);

// localStorage can throw (private mode, blocked site data), so every access
// is guarded; the in-memory value keeps the toggle working without it.
const readDevice = (): PreviewDevice => {
  if (currentDevice) return currentDevice;
  try {
    const stored = window.localStorage.getItem(STORAGE_KEY);
    currentDevice = isPreviewDevice(stored) ? stored : "desktop";
  } catch {
    currentDevice = "desktop";
  }
  return currentDevice;
};

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};

/** The preview device choice, persisted per browser. */
export const usePreviewDevice = () => {
  const device = useSyncExternalStore(subscribe, readDevice, () => "desktop" as const);

  const setDevice = useCallback((next: PreviewDevice) => {
    currentDevice = next;
    try {
      window.localStorage.setItem(STORAGE_KEY, next);
    } catch {
      // Persistence is best-effort.
    }
    listeners.forEach((listener) => listener());
  }, []);

  return [device, setDevice] as const;
};

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
