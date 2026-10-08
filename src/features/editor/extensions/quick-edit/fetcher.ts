import ky, { HTTPError } from "ky";
import { z } from "zod";
import { toast } from "sonner";

import { PROVIDER_KEY_ERROR_CODE } from "@/features/ai-providers/registry";
import { AI_PROVIDERS_SETTINGS_URL } from "@/features/settings/nav";

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
    const body =
      error instanceof HTTPError
        ? await error.response
            .json<{ error?: string; code?: string }>()
            .catch(() => undefined)
        : undefined;
    // A problem with the user's own key links to where they can fix it.
    const settingsAction =
      body?.code === PROVIDER_KEY_ERROR_CODE
        ? {
            label: "Settings",
            onClick: () => window.location.assign(AI_PROVIDERS_SETTINGS_URL),
          }
        : undefined;
    toast.error(
      body?.error
        ? `AI quick edit failed: ${body.error}`
        : "AI quick edit failed. Please try again.",
      { action: settingsAction },
    );
    return null;
  }
};
