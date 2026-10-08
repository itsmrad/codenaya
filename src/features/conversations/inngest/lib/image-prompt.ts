import type { Message, TextContent } from "@inngest/agent-kit";

/**
 * Attaches the user's images to the agent prompt as Chat Completions
 * `image_url` content parts.
 *
 * AgentKit types message content as text only, but its OpenAI adapter (used
 * for OpenRouter, OpenAI and custom endpoints) forwards `content` unchanged,
 * so the parts reach the provider as sent. Without images the prompt is
 * returned as is.
 */

/** Sent as the request when a message has images but no text. */
export const IMAGE_ONLY_PROMPT = "See the attached image(s).";

type ContentPart =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string } };

export function withImageParts(prompt: Message[], imageUrls: string[]): Message[] {
  if (imageUrls.length === 0) return prompt;

  const parts: ContentPart[] = imageUrls.map((url) => ({
    type: "image_url",
    image_url: { url },
  }));

  return prompt.map((message) =>
    message.type === "text" && message.role === "user" && typeof message.content === "string"
      ? {
          ...message,
          content: [
            { type: "text", text: message.content },
            ...parts,
          ] as unknown as TextContent[],
        }
      : message,
  );
}
