"use client";

import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";

import type { PlatformProviderId } from "../platform-models";

/** A platform provider whose key is set: the only ones a model can be routed to. */
export interface ProviderOption {
  id: PlatformProviderId;
  label: string;
}

export const ProviderPicker = ({
  providers,
  value,
  onChange,
}: {
  providers: ProviderOption[];
  value: PlatformProviderId;
  onChange: (provider: PlatformProviderId) => void;
}) => (
  <ToggleGroup
    type="single"
    variant="outline"
    value={value}
    // Radix clears the value when the pressed item is clicked again; keep it.
    onValueChange={(next) => next && onChange(next as PlatformProviderId)}
    aria-label="Provider"
    className="flex-wrap"
  >
    {providers.map((p) => (
      <ToggleGroupItem key={p.id} value={p.id} className="px-3">
        {p.label}
      </ToggleGroupItem>
    ))}
  </ToggleGroup>
);
