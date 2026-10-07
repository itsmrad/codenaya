import { z } from "zod";
import { NextResponse } from "next/server";
import { requireUserId } from "@/features/auth/server/require-user-id";

import {
  SKILL_IMPORT_RATE_LIMIT,
  checkRateLimit,
  rateLimitedResponse,
} from "@/features/integrations/server/rate-limit";
import {
  SkillImportError,
  fetchSkillMd,
  githubFolderUrl,
  parseSkillSource,
} from "@/features/skills/server/github-source";
import { parseSkillMd } from "@/features/skills/server/parse-skill-md";

/**
 * POST /api/skills/import
 *
 * Previews a skill from a GitHub folder or skills.sh page: fetches its
 * SKILL.md from raw.githubusercontent.com and returns
 * `{ skill: { name, description, body, sourceUrl } }`. Nothing is stored; the
 * client saves the skill after the user confirms the preview.
 */

const requestSchema = z.object({
  url: z.string().trim().min(1, "Paste a GitHub or skills.sh URL").max(2048),
});

export async function POST(request: Request) {
  const { userId, unauthorized } = await requireUserId();

  if (unauthorized) {
    return unauthorized;
  }

  const rateLimit = checkRateLimit(userId, SKILL_IMPORT_RATE_LIMIT);
  if (!rateLimit.allowed) {
    return rateLimitedResponse(rateLimit);
  }

  const parsed = requestSchema.safeParse(await request.json().catch(() => null));

  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? "Invalid request" },
      { status: 400 },
    );
  }

  try {
    const source = parseSkillSource(parsed.data.url);
    const { text, path } = await fetchSkillMd(source);
    const folderName = path.split("/").at(-1) || source.repo;

    const result = parseSkillMd(text, folderName);
    if (!result.ok) {
      return NextResponse.json({ error: result.error }, { status: 422 });
    }

    return NextResponse.json({
      skill: { ...result.skill, sourceUrl: githubFolderUrl(source, path) },
    });
  } catch (error) {
    if (error instanceof SkillImportError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    console.error("Skill import error:", error);
    return NextResponse.json(
      { error: "Failed to import the skill" },
      { status: 500 },
    );
  }
}
