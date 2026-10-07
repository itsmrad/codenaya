import { z } from "zod";
import { generateObject } from "ai";
import { NextResponse } from "next/server";
import { requireUserId } from "@/features/auth/server/require-user-id";
import { openai } from "@ai-sdk/openai";

import { getFirecrawl } from "@/lib/firecrawl";

const quickEditSchema = z.object({
  editedCode: z
    .string()
    .describe(
      "The edited version of the selected code based on the instruction"
    ),
});

const quickEditRequestSchema = z.object({
  selectedCode: z.string().min(1, "selectedCode is required"),
  fullCode: z.string().optional(),
  instruction: z.string().min(1, "instruction is required"),
});

const URL_REGEX = /https?:\/\/[^\s)>\]]+/g;

const QUICK_EDIT_PROMPT = `You are a code editing assistant. Edit the selected code based on the user's instruction.

<context>
<selected_code>
{selectedCode}
</selected_code>
<full_code_context>
{fullCode}
</full_code_context>
</context>

{documentation}

<instruction>
{instruction}
</instruction>

<instructions>
Return ONLY the edited version of the selected code.
Maintain the same indentation level as the original.
Do not include any explanations or comments unless requested.
If the instruction is unclear or cannot be applied, return the original code unchanged.
</instructions>`;

export async function POST(request: Request) {
  try {
    const { unauthorized } = await requireUserId();

    if (unauthorized) {
      return unauthorized;
    }

    const body = await request.json();
    const parsed = quickEditRequestSchema.safeParse(body);

    if (!parsed.success) {
      return NextResponse.json(
        { error: "Invalid request", details: parsed.error.flatten().fieldErrors },
        { status: 400 }
      );
    }

    const { selectedCode, fullCode, instruction } = parsed.data;

    const urls: string[] = instruction.match(URL_REGEX) || [];
    let documentationContext = "";
    // Firecrawl is optional: without a key, edit without documentation context.
    const firecrawl = getFirecrawl();

    if (firecrawl && urls.length > 0) {
      const scrapedResults = await Promise.all(
        urls.map(async (url) => {
          try {
            const result = await firecrawl.scrape(url, {
              formats: ["markdown"],
            });

            if (result.markdown) {
              return `<doc url="${url}">\n${result.markdown}\n</doc>`;
            }

            return null;
          } catch {
            return null;
          }
        })
      );

      const validResults = scrapedResults.filter(Boolean);

      if (validResults.length > 0) {
        documentationContext = `<documentation>\n${validResults.join("\n\n")}\n</documentation>`;
      }
    }

    const prompt = QUICK_EDIT_PROMPT
      .replace("{selectedCode}", selectedCode)
      .replace("{fullCode}", fullCode || "")
      .replace("{instruction}", instruction)
      .replace("{documentation}", documentationContext);

    const { object } = await generateObject({
      model: openai("gpt-4o"),
      output: "object",
      schema: quickEditSchema,
      prompt,
    });

    return NextResponse.json({ editedCode: object.editedCode });
  } catch (error) {
    console.error("Edit error:", error);
    return NextResponse.json(
      { error: "Failed to generate edit" },
      { status: 500 }
    );
  }
};
