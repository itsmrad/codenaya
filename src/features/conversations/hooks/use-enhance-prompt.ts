import ky, { HTTPError } from "ky";
import { toast } from "sonner";
import { useState } from "react";

/**
 * Rewrites a composer's text into a clearer build request via
 * `/api/enhance-prompt`, keeping the original so the user can undo.
 *
 * Undo stays available until the user edits the enhanced text.
 */
export const useEnhancePrompt = (
  value: string,
  setValue: (value: string) => void,
) => {
  const [isEnhancing, setIsEnhancing] = useState(false);
  const [last, setLast] = useState<{ original: string; enhanced: string } | null>(
    null,
  );

  const enhance = async () => {
    if (!value.trim() || isEnhancing) return;
    setIsEnhancing(true);
    try {
      const { prompt } = await ky
        .post("/api/enhance-prompt", { json: { prompt: value }, timeout: 30_000 })
        .json<{ prompt: string }>();
      setLast({ original: value, enhanced: prompt });
      setValue(prompt);
    } catch (error) {
      const body =
        error instanceof HTTPError
          ? await error.response.json<{ error?: string }>().catch(() => null)
          : null;
      toast.error(body?.error ?? "Unable to enhance prompt");
    } finally {
      setIsEnhancing(false);
    }
  };

  const canUndo = last !== null && last.enhanced === value;

  const undo = () => {
    if (!last) return;
    setValue(last.original);
    setLast(null);
  };

  return { enhance, undo, isEnhancing, canUndo };
};

export type PromptEnhancer = ReturnType<typeof useEnhancePrompt>;
