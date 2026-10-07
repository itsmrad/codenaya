"use client";

import { useRouter } from "next/navigation";

import { SIGN_UP_URL } from "@/features/auth/constants";
import { PromptComposer } from "@/features/projects/components/prompt-composer";
import { savePendingPrompt } from "@/features/projects/utils/pending-prompt";

/**
 * The dashboard's prompt box for signed-out visitors: the prompt is kept
 * across sign-up and the dashboard creates its project afterwards. The model
 * chip and Enhance need an account, so they are hidden here.
 */
export const LandingPromptComposer = ({
  showStarters = false,
  className,
}: {
  showStarters?: boolean;
  className?: string;
}) => {
  const router = useRouter();

  const handleSubmit = async (prompt: string) => {
    savePendingPrompt(prompt);
    router.push(SIGN_UP_URL);
    return true;
  };

  return (
    <PromptComposer
      onSubmit={handleSubmit}
      showStarters={showStarters}
      showModelSelect={false}
      showEnhance={false}
      className={className}
    />
  );
};
