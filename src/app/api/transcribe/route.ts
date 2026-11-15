import { NextResponse } from "next/server";

import { requireUserId } from "@/features/auth/server/require-user-id";
import { PROVIDER_KEY_ERROR_CODE } from "@/features/ai-providers/registry";
import { platformKeyOrNull } from "@/features/ai-providers/server/platform-model";
import { openProviderKey } from "@/features/ai-providers/server/sealed-key";
import {
  CREDIT_REFUSAL_MESSAGES,
  INSUFFICIENT_CREDITS_CODE,
  creditRefusal,
} from "@/features/billing/credits";
import { PLANS } from "@/features/billing/plans";
import { convex } from "@/lib/convex-client";
import { DICTATION_MAX_MS } from "@/lib/dictation-recorder";
import { isServerDictationLanguage } from "@/lib/dictation";
import { TRANSCRIBE_RATE_LIMIT, checkRateLimit, rateLimitedResponse } from "@/lib/rate-limit";
import { api } from "../../../../convex/_generated/api";

/**
 * POST /api/transcribe (#301): one dictation clip as multipart `audio` (plus an
 * optional `language` hint) → `{ text }`. Runs on the user's default key when
 * it is an OpenRouter key, free; otherwise on the platform key, charged in
 * credits (ADR 0011). The audio is passed through and never stored.
 */

const TRANSCRIBE_URL = "https://openrouter.ai/api/v1/audio/transcriptions";
export const TRANSCRIBE_MODEL = "nvidia/parakeet-tdt-0.6b-v3";

/** Under the hosting platform's 4.5 MB request body limit; the client caps at 3 min. */
export const TRANSCRIBE_MAX_BYTES = 4 * 1024 * 1024;

/** The dearer of the model's two providers ($0.0015/min), for a response with no cost. */
const FALLBACK_USD_PER_SECOND = 0.000025;

/** MediaRecorder's types as the provider's `format` names. */
const FORMATS: Record<string, string> = {
  "audio/webm": "webm",
  "audio/mp4": "m4a",
  "audio/ogg": "ogg",
};

const fail = (status: number, error: string, code: string) =>
  NextResponse.json({ error, code }, { status });

type DefaultKey = Awaited<ReturnType<typeof defaultOpenRouterKey>>;

/** The user's default key when it can transcribe here, else null. */
async function defaultOpenRouterKey(internalKey: string, userId: string) {
  const byok = await convex.query(api.system.getDefaultAiProviderKey, { internalKey, userId });
  const key = byok?.key;
  return key && key.provider === "openrouter" && key.status !== "invalid" ? key : null;
}

async function transcribe(apiKey: string, audio: Blob, format: string, language: string | undefined) {
  return fetch(TRANSCRIBE_URL, {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: TRANSCRIBE_MODEL,
      input_audio: { data: Buffer.from(await audio.arrayBuffer()).toString("base64"), format },
      ...(language && { language }),
    }),
  });
}

export async function POST(request: Request) {
  const { userId, unauthorized } = await requireUserId();
  if (unauthorized) return unauthorized;

  const rateLimit = checkRateLimit(userId, TRANSCRIBE_RATE_LIMIT);
  if (!rateLimit.allowed) return rateLimitedResponse(rateLimit);

  const tooLarge = () =>
    fail(413, "That recording is too long. Try a shorter one.", "audio_too_large");
  if (Number(request.headers.get("content-length") ?? 0) > TRANSCRIBE_MAX_BYTES + 64 * 1024) {
    return tooLarge();
  }
  const form = await request.formData().catch(() => null);
  const audio = form?.get("audio");
  if (!(audio instanceof Blob) || audio.size === 0) {
    return fail(400, "No audio was recorded.", "invalid_audio");
  }
  if (audio.size > TRANSCRIBE_MAX_BYTES) return tooLarge();
  const format = FORMATS[audio.type.split(";")[0] ?? ""];
  if (!format) return fail(400, "This browser records audio in a format we can't read.", "invalid_audio");
  const hint = form?.get("language");
  const language = typeof hint === "string" && isServerDictationLanguage(hint) ? hint : undefined;

  const internalKey = process.env.CODENAYA_CONVEX_INTERNAL_KEY;
  const unavailable = () =>
    fail(503, "Transcription isn't set up on this server.", "transcription_unavailable");
  if (!internalKey) return unavailable();

  const [ownKey, account] = await Promise.all([
    defaultOpenRouterKey(internalKey, userId),
    convex.query(api.credits.getForServer, { internalKey, userId }),
  ]);
  const apiKey = ownKey ? await openProviderKey(ownKey) : platformKeyOrNull("openrouter");
  if (!apiKey) return unavailable();
  if (!ownKey) {
    // As for agent runs: usage is always recorded, the cap applies once billing is live.
    const refusal =
      process.env.CREDIT_LIMITS_ENFORCED === "true" &&
      creditRefusal(PLANS[account?.plan ?? "free"], account, Date.now());
    if (refusal) return fail(402, CREDIT_REFUSAL_MESSAGES[refusal], INSUFFICIENT_CREDITS_CODE);
  }

  const response = await transcribe(apiKey, audio, format, language);
  if (!response.ok) return providerFailure(response.status, ownKey);

  const body = (await response.json().catch(() => null)) as {
    text?: unknown;
    usage?: { cost?: number; seconds?: number };
  } | null;
  const text = typeof body?.text === "string" ? body.text.trim() : "";

  if (!ownKey) {
    const seconds = body?.usage?.seconds ?? DICTATION_MAX_MS / 1000;
    const costUsd = body?.usage?.cost ?? seconds * FALLBACK_USD_PER_SECOND;
    // Like a run's usage: a failure to record is logged, never the user's problem.
    await convex
      .mutation(api.credits.recordTranscriptionUsage, { internalKey, userId, costUsd })
      .catch((error: unknown) => console.error("[transcribe] recording usage failed:", error));
  }
  return NextResponse.json({ text });
}

function providerFailure(status: number, ownKey: DefaultKey) {
  console.warn(`[transcribe] provider answered ${status}`);
  if (ownKey && (status === 401 || status === 402 || status === 403)) {
    return fail(
      422,
      `Your ${ownKey.label} key was refused for transcription. Update it in Settings → AI providers.`,
      PROVIDER_KEY_ERROR_CODE,
    );
  }
  return fail(502, "Transcription failed, try again.", "transcription_failed");
}
