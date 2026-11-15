"use client";

import { useState } from "react";
import { toast } from "sonner";
import { MonitorIcon, MoonIcon, PaintbrushIcon, SunIcon, TriangleAlertIcon } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Field, FieldDescription, FieldError, FieldLabel, FieldLegend, FieldSet } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { useQueueChatMessage } from "@/features/conversations/hooks/use-queue-chat-message";
import { convexErrorMessage } from "@/lib/convex-error";
import { cn } from "@/lib/utils";

import { useProject, useUpdateProjectTheme } from "../hooks/use-projects";
import {
  APPLY_THEME_MESSAGE,
  THEME_FONTS,
  THEME_PRESETS,
  contrastRatio,
  fontById,
  foregroundFor,
  meetsContrastAA,
  sameTheme,
  validateTheme,
  type ProjectTheme,
  type ThemeMode,
} from "../theme";
import { Id } from "../../../../convex/_generated/dataModel";

const RADII = [0, 0.25, 0.5, 0.625, 0.75, 1];

const MODES: { value: ThemeMode; label: string; icon: typeof SunIcon }[] = [
  { value: "light", label: "Light", icon: SunIcon },
  { value: "dark", label: "Dark", icon: MoonIcon },
  { value: "system", label: "System", icon: MonitorIcon },
];

/** Brand colours, font, radius and mode the agent applies on every run (#302). */
export const ProjectThemeForm = ({ projectId }: { projectId: Id<"projects"> }) => {
  const project = useProject(projectId);
  if (project === undefined) return null;
  return <ThemeEditor projectId={projectId} saved={project.theme ?? null} />;
};

const ThemeEditor = ({
  projectId,
  saved,
}: {
  projectId: Id<"projects">;
  saved: ProjectTheme | null;
}) => {
  const updateTheme = useUpdateProjectTheme();
  const queueChatMessage = useQueueChatMessage();
  const [draft, setDraft] = useState<ProjectTheme | null>(saved);
  const [saving, setSaving] = useState(false);

  const invalid = draft !== null && validateTheme(draft) !== null;
  const changed = !sameTheme(draft, saved);

  const save = async (theme: ProjectTheme | null) => {
    setSaving(true);
    try {
      await updateTheme({ id: projectId, theme: theme ?? undefined });
      toast.success(theme ? "Theme saved" : "Theme removed");
      setDraft(theme);
    } catch (error) {
      toast.error(convexErrorMessage(error, "Unable to save the theme"));
    } finally {
      setSaving(false);
    }
  };

  const apply = () => {
    queueChatMessage({ projectId, text: APPLY_THEME_MESSAGE });
    toast.success("Asked the agent to apply the theme");
  };

  const set = (change: Partial<ProjectTheme>) =>
    setDraft((current) => ({ ...(current ?? THEME_PRESETS[0].theme), ...change }));

  return (
    <FieldSet className="gap-3">
      <FieldLegend variant="label">Design</FieldLegend>
      <FieldDescription className="-mt-2">
        Brand colours, font and corners the agent applies and keeps in this project.
      </FieldDescription>

      <div role="group" aria-label="Theme presets" className="grid grid-cols-3 gap-1.5 sm:grid-cols-6">
        {THEME_PRESETS.map((preset) => {
          const selected = sameTheme(draft, preset.theme);
          return (
            <button
              key={preset.name}
              type="button"
              aria-pressed={selected}
              onClick={() => setDraft(preset.theme)}
              className={cn(
                "flex min-h-11 flex-col items-center justify-center gap-1 rounded-md border px-1 py-1.5 text-xs transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                selected ? "border-foreground" : "border-border",
              )}
            >
              <span aria-hidden="true" className="flex">
                <span className="size-3.5 rounded-full border border-border/60" style={{ background: preset.theme.primary }} />
                <span className="-ml-1 size-3.5 rounded-full border border-border/60" style={{ background: preset.theme.accent }} />
              </span>
              {preset.name}
            </button>
          );
        })}
      </div>

      {draft === null ? (
        <div className="flex items-center justify-between gap-3 rounded-md border border-dashed px-3 py-2.5">
          <p className="text-xs text-muted-foreground">No theme: the agent picks the look for each app.</p>
          <Button size="sm" variant="outline" className="h-7 shrink-0 text-xs" onClick={() => setDraft(THEME_PRESETS[0].theme)}>
            <PaintbrushIcon aria-hidden="true" />
            Customize
          </Button>
        </div>
      ) : (
        <ThemeFields theme={draft} onChange={set} />
      )}

      <div className="flex flex-wrap items-center justify-end gap-1.5">
        {saved && (
          <Button size="sm" variant="ghost" className="h-7 text-xs" disabled={saving} onClick={() => save(null)}>
            Remove theme
          </Button>
        )}
        {saved && !changed && (
          <Button size="sm" variant="outline" className="h-7 text-xs" onClick={apply}>
            Apply theme
          </Button>
        )}
        <Button size="sm" className="h-7 text-xs" disabled={!changed || invalid || saving || draft === null} onClick={() => save(draft)}>
          {saving ? "Saving..." : "Save"}
        </Button>
      </div>
    </FieldSet>
  );
};

const ColorField = ({
  id,
  label,
  value,
  onChange,
}: {
  id: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
}) => {
  const valid = /^#[0-9a-f]{6}$/i.test(value);
  return (
    <Field data-invalid={!valid} className="gap-1.5">
      <FieldLabel htmlFor={id} className="text-xs">{label}</FieldLabel>
      <div className="flex items-center gap-1.5">
        <input
          type="color"
          aria-label={`${label} picker`}
          value={valid ? value : "#000000"}
          onChange={(e) => onChange(e.target.value)}
          className="size-9 shrink-0 cursor-pointer rounded-md border border-input bg-transparent p-0.5"
        />
        <Input
          id={id}
          value={value}
          onChange={(e) => onChange(e.target.value.trim().toLowerCase())}
          aria-invalid={!valid}
          aria-describedby={valid ? undefined : `${id}-error`}
          spellCheck={false}
          maxLength={7}
          className="h-9 font-mono text-xs md:text-xs"
        />
      </div>
      {!valid && (
        <FieldError id={`${id}-error`} className="text-xs">
          Use a hex colour like #2563eb.
        </FieldError>
      )}
    </Field>
  );
};

const ThemeFields = ({
  theme,
  onChange,
}: {
  theme: ProjectTheme;
  onChange: (change: Partial<ProjectTheme>) => void;
}) => {
  const validPrimary = /^#[0-9a-f]{6}$/i.test(theme.primary);
  const validAccent = /^#[0-9a-f]{6}$/i.test(theme.accent);
  const lowContrast = validPrimary && !meetsContrastAA(theme.primary);
  const font = fontById(theme.font);

  return (
    <div className="space-y-3">
      <div className="grid gap-3 sm:grid-cols-2">
        <ColorField id="theme-primary" label="Primary" value={theme.primary} onChange={(primary) => onChange({ primary })} />
        <ColorField id="theme-accent" label="Accent" value={theme.accent} onChange={(accent) => onChange({ accent })} />
      </div>

      {lowContrast && (
        <p role="status" className="flex items-start gap-1.5 text-xs text-destructive">
          <TriangleAlertIcon aria-hidden="true" className="mt-0.5 size-3.5 shrink-0" />
          Text on this primary is hard to read ({contrastRatio(theme.primary, foregroundFor(theme.primary)).toFixed(1)}:1; WCAG AA needs 4.5:1). Pick a lighter or darker colour.
        </p>
      )}

      <div className="grid gap-3 sm:grid-cols-2">
        <Field className="gap-1.5">
          <FieldLabel htmlFor="theme-font" className="text-xs">Font</FieldLabel>
          <Select value={theme.font} onValueChange={(value) => onChange({ font: value })}>
            <SelectTrigger id="theme-font" className="h-9 w-full text-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {THEME_FONTS.map((option) => (
                <SelectItem key={option.id} value={option.id} className="text-xs">
                  {option.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>
        <Field className="gap-1.5">
          <FieldLabel htmlFor="theme-radius" className="text-xs">Corner radius</FieldLabel>
          <Select value={String(theme.radius)} onValueChange={(value) => onChange({ radius: Number(value) })}>
            <SelectTrigger id="theme-radius" className="h-9 w-full text-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {RADII.map((radius) => (
                <SelectItem key={radius} value={String(radius)} className="text-xs">
                  {radius === 0 ? "Square (0)" : `${radius}rem`}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>
      </div>

      <Field className="gap-1.5">
        <FieldLabel className="text-xs">Default mode</FieldLabel>
        <ToggleGroup
          type="single"
          variant="outline"
          aria-label="Default mode"
          value={theme.defaultMode}
          // Clicking the selected item emits "", which would clear the mode.
          onValueChange={(value) => value && onChange({ defaultMode: value as ThemeMode })}
          className="w-full"
        >
          {MODES.map(({ value, label, icon: Icon }) => (
            <ToggleGroupItem key={value} value={value} className="flex-1 gap-1.5 text-xs">
              <Icon aria-hidden="true" />
              {label}
            </ToggleGroupItem>
          ))}
        </ToggleGroup>
      </Field>

      {validPrimary && validAccent && (
        <div
          className="flex flex-wrap items-center gap-2 rounded-md border p-3"
          style={{ fontFamily: font ? `"${font.family}", ${font.fallback}` : undefined }}
        >
          <span
            className="px-3 py-1.5 text-xs font-medium"
            style={{ background: theme.primary, color: foregroundFor(theme.primary), borderRadius: `${theme.radius}rem` }}
          >
            Primary button
          </span>
          <span
            className="px-3 py-1.5 text-xs"
            style={{ background: theme.accent, color: foregroundFor(theme.accent), borderRadius: `${theme.radius}rem` }}
          >
            Accent
          </span>
          <span className="text-xs text-muted-foreground">{font?.label} · {theme.radius}rem corners</span>
        </div>
      )}
    </div>
  );
};
