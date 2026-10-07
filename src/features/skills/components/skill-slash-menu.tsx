"use client";

import { useMemo, useState, type KeyboardEvent } from "react";
import { BookOpenIcon } from "lucide-react";

import {
  Command,
  CommandGroup,
  CommandItem,
  CommandList,
} from "@/components/ui/command";

import type { Id } from "../../../../convex/_generated/dataModel";
import { useProjectSkills } from "../hooks/use-skills";
import { MAX_SLASH_SKILLS, parseSlashSkills } from "../parse-slash";
import type { ProjectSkillSummary } from "../types";

// The `/query` being typed after up to two finished leading `/name` tokens.
const SLASH_QUERY = new RegExp(
  `^\\s*(?:/[a-z0-9-]+\\s+){0,${MAX_SLASH_SKILLS - 1}}/([a-z0-9-]*)$`,
);

/**
 * State for the composer's `/` skills picker: the project's enabled skills
 * matching the `/query` at the end of the input's leading slash tokens, and a
 * keydown handler for the textarea (arrows move, Enter/Tab insert, Esc closes).
 */
export const useSkillSlashMenu = (
  projectId: Id<"projects">,
  input: string,
  setInput: (value: string) => void,
) => {
  const projectSkills = useProjectSkills(projectId);
  const enabledSkills = useMemo(
    () => projectSkills?.filter((skill) => skill.enabled) ?? [],
    [projectSkills],
  );
  const skillNames = useMemo(
    () => new Set(enabledSkills.map((skill) => skill.name)),
    [enabledSkills],
  );
  const [active, setActive] = useState("");
  // The input as it was when Esc closed the menu; typing reopens it.
  const [dismissedAt, setDismissedAt] = useState<string | null>(null);

  const query = input.match(SLASH_QUERY)?.[1];
  const prefix = query === undefined ? "" : input.slice(0, -query.length - 1);
  const items = useMemo(() => {
    if (query === undefined) return [];
    const used = parseSlashSkills(prefix);
    return enabledSkills
      .filter((skill) => skill.name.includes(query) && !used.includes(skill.name))
      .sort(
        (a, b) =>
          Number(b.name.startsWith(query)) - Number(a.name.startsWith(query)),
      );
  }, [enabledSkills, query, prefix]);

  const open = items.length > 0 && dismissedAt !== input;
  const activeName = items.some((skill) => skill.name === active)
    ? active
    : (items[0]?.name ?? "");

  const select = (name: string) => setInput(`${prefix}/${name} `);

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (!open || event.nativeEvent.isComposing) return;
    const index = items.findIndex((skill) => skill.name === activeName);
    switch (event.key) {
      case "ArrowDown":
        setActive(items[(index + 1) % items.length].name);
        break;
      case "ArrowUp":
        setActive(items[(index - 1 + items.length) % items.length].name);
        break;
      case "Enter":
      case "Tab":
        if (event.shiftKey) return;
        select(activeName);
        break;
      case "Escape":
        // Closing the menu must not also stop a run or close a dialog.
        event.stopPropagation();
        setDismissedAt(input);
        break;
      default:
        return;
    }
    event.preventDefault();
  };

  return { open, items, activeName, setActive, select, onKeyDown, skillNames };
};

interface SkillSlashMenuProps {
  items: ProjectSkillSummary[];
  activeName: string;
  onActiveChange: (name: string) => void;
  onSelect: (name: string) => void;
}

/**
 * The skills list shown above the composer while a `/name` is typed. Focus
 * stays in the textarea, which drives it through `useSkillSlashMenu`.
 */
export const SkillSlashMenu = ({
  items,
  activeName,
  onActiveChange,
  onSelect,
}: SkillSlashMenuProps) => (
  <Command
    value={activeName}
    onValueChange={onActiveChange}
    shouldFilter={false}
    className="absolute inset-x-3 bottom-full z-20 mb-1 h-auto w-auto rounded-lg border shadow-md"
  >
    <CommandList label="Skills">
      <CommandGroup heading="Skills">
        {items.map((skill) => (
          <CommandItem
            key={skill.key}
            value={skill.name}
            onSelect={onSelect}
            // Keep focus in the textarea.
            onMouseDown={(event) => event.preventDefault()}
          >
            <BookOpenIcon />
            <span className="shrink-0 font-medium">/{skill.name}</span>
            <span className="truncate text-xs text-muted-foreground">
              {skill.description}
            </span>
          </CommandItem>
        ))}
      </CommandGroup>
    </CommandList>
  </Command>
);
