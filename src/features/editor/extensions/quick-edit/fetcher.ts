import ky, { HTTPError } from "ky";
import { z } from "zod";
import { toast } from "sonner";

const editRequestSchema = z.object({
  selectedCode: z.string(),
  fullCode: z.string(),
  instruction: z.string(),
});

const editResponseSchema = z.object({
  editedCode: z.string(),
});

type EditRequest = z.infer<typeof editRequestSchema>;
type EditResponse = z.infer<typeof editResponseSchema>;

export const fetcher = async (
  payload: EditRequest,
  signal: AbortSignal,
): Promise<string | null> => {
  try {
    const validatedPayload = editRequestSchema.parse(payload);

    const response = await ky
      .post("/api/quick-edit", {
        json: validatedPayload,
        signal,
        timeout: 30_000,
        retry: 0,
      })
      .json<EditResponse>();

    const validatedResponse = editResponseSchema.parse(response);

    return validatedResponse.editedCode || null;
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      return null;
    }
    // Surface the route's JSON error (e.g. "AI is not configured") when present.
    const reason =
      error instanceof HTTPError
        ? await error.response
            .json<{ error?: string }>()
            .then((body) => body.error)
            .catch(() => undefined)
        : undefined;
    toast.error(
      reason ? `AI quick edit failed: ${reason}` : "AI quick edit failed. Please try again.",
    );
    return null;
  }
};
