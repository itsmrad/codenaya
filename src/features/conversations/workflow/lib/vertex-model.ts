import { createVertex } from "@ai-sdk/google-vertex";

/**
 * Google Vertex AI provider configured from service-account env vars.
 *
 * Reads:
 *  - GOOGLE_VERTEX_PROJECT     project id
 *  - GOOGLE_VERTEX_LOCATION    region (e.g. "global", "us-east5")
 *  - GOOGLE_CLIENT_EMAIL       service account email
 *  - GOOGLE_PRIVATE_KEY        service account private key (with \n escapes ok)
 *
 * Auth is handled by google-auth-library under the hood. Tokens are cached
 * and refreshed automatically, so this is safe to call repeatedly inside
 * step functions.
 */
const project = process.env.GOOGLE_VERTEX_PROJECT;
const location = process.env.GOOGLE_VERTEX_LOCATION ?? "us-central1";
const clientEmail = process.env.GOOGLE_CLIENT_EMAIL;
const privateKeyRaw = process.env.GOOGLE_PRIVATE_KEY;

if (!project) {
  throw new Error("GOOGLE_VERTEX_PROJECT is not configured");
}

if (!clientEmail) {
  throw new Error("GOOGLE_CLIENT_EMAIL is not configured");
}

if (!privateKeyRaw) {
  throw new Error("GOOGLE_PRIVATE_KEY is not configured");
}

// Env-provided private keys often contain literal "\n" sequences instead of
// real newlines. The Google auth library requires real newlines.
const privateKey = privateKeyRaw.replace(/\\n/g, "\n");

const googleAuthOptions = {
  credentials: {
    client_email: clientEmail,
    private_key: privateKey,
  },
};

// Optional fetch interceptor that logs every Vertex API call to the dev
// server console. Toggle on with `MESSAGE_PROCESSOR_LOG_VERTEX=1` in
// .env.local to verify which model ID is actually being sent to Vertex.
//
// This bypasses any LLM self-reporting (which is unreliable — see the
// "(Using gemini-X)" hallucinations issue) by reading the URL the AI SDK
// constructs. Vertex puts the model ID in the URL path, so the log line
// is ground truth.
const logVertexCalls = process.env.MESSAGE_PROCESSOR_LOG_VERTEX === "1";

const loggingFetch: typeof fetch = async (input, init) => {
  const url = typeof input === "string" ? input : (input as Request).url;
  const method = init?.method ?? "GET";
  const match = url.match(/publishers\/([^/]+)\/models\/([^:?/]+)/);
  if (match) {
    console.log(
      `[vertex] ${method} publisher=${match[1]} model=${match[2]}`
    );
  } else {
    console.log(`[vertex] ${method} ${url}`);
  }
  return fetch(input as Parameters<typeof fetch>[0], init);
};

// Gemini (Google) provider on Vertex AI.
export const vertex = createVertex({
  project,
  location,
  googleAuthOptions,
  ...(logVertexCalls ? { fetch: loggingFetch } : {}),
});

export const VERTEX_MODELS = {
  // Coding agent: Gemini 3.1 Pro Preview — Google's strongest coding model
  // on Vertex AI as of writing. Competitive with Claude Opus on coding
  // benchmarks, with a generous 1M-token context window. We're on this
  // (instead of Anthropic Opus 4.6) because Anthropic models on Vertex are
  // hard-gated for free-trial billing accounts.
  coding: "gemini-3.1-pro-preview" as const,

  // Title generator: Gemini 2.5 Flash — short deterministic generation,
  // cheap and fast. No reason to use a Pro model for a 6-word title.
  title: "gemini-2.5-flash" as const,
} as const;
