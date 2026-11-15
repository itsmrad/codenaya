import type { Doc } from "../../convex/_generated/dataModel";

export type Message = Pick<Doc<"messages">, "_id" | "role" | "content" | "status" | "steps" | "runModel" | "stuck" | "completedAt">;
export type Usage = { messageId: string; model: string; inputTokens: number; outputTokens: number; costUsd: number; source: string };
export type SandboxEvent = { at: number; type: string; code?: string; message?: string; phase?: string; data?: string; sandboxId?: string };
export type Trail = {
  id: string; model: string; prompt: string; projectId?: string;
  startedAt: number; endedAt: number; firstPreviewAt?: number; firstAppPaintAt?: number;
  messages: Message[]; usage: Usage[]; sandboxEvents: SandboxEvent[];
  consoleErrors: { text: string; url: string }[];
  capped: boolean; error?: string;
  preview: { loaded: boolean; overlay: boolean; screenshot?: string; errors?: string[] };
};
