import { parse } from "yaml";

import { type SkillFields, validateSkill } from "../limits";

const FRONTMATTER_PATTERN = /^﻿?---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/;

export type ParsedSkillMd =
  | { ok: true; skill: SkillFields }
  | { ok: false; error: string };

const asText = (value: unknown) =>
  typeof value === "string" ? value.trim() : "";

/**
 * Parses a SKILL.md (YAML frontmatter with `name` and `description`, then a
 * markdown body) and validates it against the skill limits. A missing `name`
 * falls back to the skill's folder name, as the Agent Skills spec names a
 * skill after its directory.
 */
export function parseSkillMd(markdown: string, folderName: string): ParsedSkillMd {
  const match = markdown.match(FRONTMATTER_PATTERN);
  if (!match) {
    return {
      ok: false,
      error: "SKILL.md must start with a --- frontmatter block (name, description)",
    };
  }

  let frontmatter: unknown;
  try {
    frontmatter = parse(match[1]);
  } catch {
    return { ok: false, error: "SKILL.md frontmatter is not valid YAML" };
  }
  const fields =
    frontmatter && typeof frontmatter === "object"
      ? (frontmatter as Record<string, unknown>)
      : {};

  const skill: SkillFields = {
    name: asText(fields.name) || folderName.toLowerCase(),
    description: asText(fields.description),
    body: markdown.slice(match[0].length).trim(),
  };

  const error = validateSkill(skill);
  return error ? { ok: false, error } : { ok: true, skill };
}
