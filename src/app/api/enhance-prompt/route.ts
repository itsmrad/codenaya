import { z } from "zod";
import { generateObject } from "ai";
import { NextResponse } from "next/server";
import { requireUserId } from "@/features/auth/server/require-user-id";

import { detectCredential } from "@/features/integrations/credential-guard";
import {
  ENHANCE_PROMPT_RATE_LIMIT,
  checkRateLimit,
  rateLimitedResponse,
} from "@/features/integrations/server/rate-limit";
import { editorModel, isOpenRouterConfigured } from "@/lib/openrouter";

/**
 * POST /api/enhance-prompt
 *
 * Rewrites a short build idea ("todo app") into a clearer, more specific spec
 * the user can edit before sending. Returns `{ prompt }` as plain text.
 */

const requestSchema = z.object({
  prompt: z.string().trim().min(1, "prompt is required").max(4_000),
});

const specSchema = z.object({
  summary: z
    .string()
    .describe("One or two sentences: what the app is and who it is for"),
  pages: z.array(z.string()).describe("Pages or screens, each with its purpose"),
  features: z.array(z.string()).describe("Concrete, buildable features"),
  style: z.string().describe("Visual style: layout, colors, tone"),
  data: z.string().describe("Data the app stores or shows, and where it comes from"),
});

const ENHANCE_PROMPT = `You turn a short web app idea into a clear, specific build request for an AI coding agent.

<idea>
{prompt}
</idea>

<instructions>
Keep the user's intent; do not change what they asked for, only make it concrete.
Fill gaps with sensible, modest defaults for a first version. Avoid scope creep.
Write pages and features as short plain-language items. No code, no markdown.
If the idea is already detailed, tighten it rather than inventing more.
</instructions>`;

const formatSpec = (spec: z.infer<typeof specSchema>) =>
  [
    spec.summary,
    `Pages:\n${spec.pages.map((page) => `- ${page}`).join("\n")}`,
    `Features:\n${spec.features.map((feature) => `- ${feature}`).join("\n")}`,
    `Style: ${spec.style}`,
    `Data: ${spec.data}`,
  ].join("\n\n");

export async function POST(request: Request) {
  const { userId, unauthorized } = await requireUserId();

  if (unauthorized) {
    return unauthorized;
  }

  const rateLimit = checkRateLimit(userId, ENHANCE_PROMPT_RATE_LIMIT);
  if (!rateLimit.allowed) {
    return rateLimitedResponse(rateLimit);
  }

  if (!isOpenRouterConfigured()) {
    return NextResponse.json({ error: "AI is not configured" }, { status: 503 });
  }

  const parsed = requestSchema.safeParse(await request.json().catch(() => null));

  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? "Invalid request" },
      { status: 400 },
    );
  }

  const { prompt } = parsed.data;

  // Never forward a pasted secret to the model.
  if (detectCredential(prompt).detected) {
    return NextResponse.json(
      {
        error: "Credentials cannot be sent in a prompt. Remove them and try again.",
        code: "credential_detected",
      },
      { status: 422 },
    );
  }

  try {
    const { object } = await generateObject({
      model: editorModel("enhancePrompt"),
      output: "object",
      schema: specSchema,
      prompt: ENHANCE_PROMPT.replace("{prompt}", prompt),
    });

    return NextResponse.json({ prompt: formatSpec(object) });
  } catch (error) {
    console.error("Enhance prompt error:", error);
    return NextResponse.json(
      { error: "Failed to enhance prompt" },
      { status: 500 },
    );
  }
}
