"use client";

import { MessageResponse } from "@/components/ai-elements/message";
import { cn } from "@/lib/utils";

/**
 * Renders a skill body as markdown. Raw HTML in the body is dropped rather
 * than rendered, since skills can come from third parties.
 */
export const SkillMarkdown = ({
  children,
  className,
}: {
  children: string;
  className?: string;
}) => (
  <MessageResponse
    mode="static"
    skipHtml
    className={cn("text-sm leading-relaxed", className)}
  >
    {children}
  </MessageResponse>
);
