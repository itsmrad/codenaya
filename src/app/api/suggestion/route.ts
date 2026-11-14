import { generateObject } from "ai";
import { requireUserId } from "@/features/auth/server/require-user-id";
import { codeText, parseJsonBody } from "@/lib/parse-json-body";
import { NextResponse } from "next/server";
import { z } from "zod";

import { withEditorModel } from "@/features/ai-providers/server/editor-model";
import {
  SUGGESTION_RATE_LIMIT,
  checkRateLimit,
  rateLimitedResponse,
} from "@/lib/rate-limit";

const suggestionSchema = z.object({
  suggestion: z
    .string()
    .describe(
      "The code to insert at cursor, or empty string if no completion needed"
    ),
});

const suggestionRequestSchema = z.object({
  fileName: z.string(),
  code: codeText.min(1, "code is required"),
  currentLine: codeText,
  previousLines: codeText.optional(),
  textBeforeCursor: codeText,
  textAfterCursor: codeText,
  nextLines: codeText.optional(),
  lineNumber: z.coerce.number(),
});

const SUGGESTION_PROMPT = `You are a code suggestion assistant.

<context>
<file_name>{fileName}</file_name>
<previous_lines>
{previousLines}
</previous_lines>
<current_line number="{lineNumber}">{currentLine}</current_line>
<before_cursor>{textBeforeCursor}</before_cursor>
<after_cursor>{textAfterCursor}</after_cursor>
<next_lines>
{nextLines}
</next_lines>
<full_code>
{code}
</full_code>
</context>

<instructions>
Follow these steps IN ORDER:

1. First, look at next_lines. If next_lines contains ANY code, check if it continues from where the cursor is. If it does, return empty string immediately - the code is already written.

2. Check if before_cursor ends with a complete statement (;, }, )). If yes, return empty string.

3. Only if steps 1 and 2 don't apply: suggest what should be typed at the cursor position, using context from full_code.

Your suggestion is inserted immediately after the cursor, so never suggest code that's already in the file.
</instructions>`;

export async function POST(request: Request) {
  try {
    const { userId, unauthorized } = await requireUserId();

    if (unauthorized) {
      return unauthorized;
    }

    const rateLimit = checkRateLimit(userId, SUGGESTION_RATE_LIMIT);
    if (!rateLimit.allowed) {
      return rateLimitedResponse(rateLimit);
    }

    const { data, invalid } = await parseJsonBody(request, suggestionRequestSchema);

    if (invalid) {
      return invalid;
    }

    const {
      fileName,
      code,
      currentLine,
      previousLines,
      textBeforeCursor,
      textAfterCursor,
      nextLines,
      lineNumber,
    } = data;

    const prompt = SUGGESTION_PROMPT
      .replace("{fileName}", fileName)
      .replace("{code}", code)
      .replace("{currentLine}", currentLine)
      .replace("{previousLines}", previousLines ?? "")
      .replace("{textBeforeCursor}", textBeforeCursor)
      .replace("{textAfterCursor}", textAfterCursor)
      .replace("{nextLines}", nextLines ?? "")
      .replace("{lineNumber}", lineNumber.toString());

    // Ghost text is only useful if it lands in about a second (#320).
    return await withEditorModel({ userId, thinking: false }, async (model) => {
      const { object } = await generateObject({
        model,
        output: "object",
        schema: suggestionSchema,
        prompt,
      });

      return NextResponse.json({ suggestion: object.suggestion });
    });
  } catch (error) {
    console.error("Suggestion error: ", error);
    return NextResponse.json(
      { error: "Failed to generate suggestion" },
      { status: 500 },
    );
  }
}
