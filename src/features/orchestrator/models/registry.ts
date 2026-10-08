import { EvaluatedModel } from "./types";

export interface ModelDescriptor extends EvaluatedModel {
  costTier: "free" | "low" | "medium" | "high";
}

/**
 * Catalog of available models mapped to their respective capability profiles.
 *
 * Scoring: 1 - 10 (10 = highest proficiency or fastest/cheapest).
 */
export const MODEL_CATALOG: ModelDescriptor[] = [
  // ─── Google / Vertex Models ───
  {
    id: "gemini-2.5-flash",
    provider: "google",
    tier: "fast",
    costTier: "low",
    capabilities: {
      reasoning: 7,
      coding: 7,
      speed: 9.5,
      costEfficiency: 9.5,
      contextWindow: 1_000_000,
    },
    strengths: [
      "near-instant latency",
      "massive 1M token context",
      "repository exploration",
      "boilerplate generation",
      "formatting",
      "syntax validation",
    ],
  },
  {
    id: "gemini-2.5-pro",
    provider: "google",
    tier: "standard",
    costTier: "medium",
    capabilities: {
      reasoning: 8.5,
      coding: 8.5,
      speed: 7.5,
      costEfficiency: 7.5,
      contextWindow: 2_000_000,
    },
    strengths: [
      "huge 2M context window",
      "solid full-stack coding",
      "component implementation",
      "comprehensive documentation",
    ],
  },
  {
    id: "gemini-3.1-pro-preview",
    provider: "vertex",
    tier: "advanced",
    costTier: "high",
    capabilities: {
      reasoning: 9.2,
      coding: 9.3,
      speed: 6.5,
      costEfficiency: 6.0,
      contextWindow: 1_000_000,
    },
    strengths: [
      "deep architectural design",
      "large-scale refactors",
      "system trade-off analysis",
      "complex multi-file context",
    ],
  },

  // ─── Anthropic Models ───
  {
    id: "claude-3-5-haiku-20241022",
    provider: "anthropic",
    tier: "fast",
    costTier: "low",
    capabilities: {
      reasoning: 7.2,
      coding: 7.5,
      speed: 9.5,
      costEfficiency: 9.0,
      contextWindow: 200_000,
    },
    strengths: [
      "blazing fast code edits",
      "targeted surgical changes",
      "file searching",
      "straightforward fixes",
      "lint & formatting checks",
    ],
  },
  {
    id: "claude-3-5-sonnet-20241022",
    provider: "anthropic",
    tier: "advanced",
    costTier: "high",
    capabilities: {
      reasoning: 9.5,
      coding: 9.7,
      speed: 7.0,
      costEfficiency: 6.0,
      contextWindow: 200_000,
    },
    strengths: [
      "state-of-the-art coding fidelity",
      "nuanced refactoring",
      "senior code review",
      "complex debugging",
      "security analysis",
    ],
  },
  {
    id: "claude-3-7-sonnet-20250219",
    provider: "anthropic",
    tier: "reasoning",
    costTier: "high",
    capabilities: {
      reasoning: 9.9,
      coding: 9.8,
      speed: 5.5,
      costEfficiency: 5.0,
      contextWindow: 200_000,
    },
    strengths: [
      "deep hybrid reasoning",
      "master software architecture",
      "security vulnerabilities",
      "difficult algorithmic problems",
      "critical system overhauls",
    ],
  },

  // ─── OpenAI Models ───
  {
    id: "gpt-4o-mini",
    provider: "openai",
    tier: "fast",
    costTier: "low",
    capabilities: {
      reasoning: 7.0,
      coding: 7.2,
      speed: 9.0,
      costEfficiency: 9.5,
      contextWindow: 128_000,
    },
    strengths: [
      "inexpensive batch tasks",
      "simple function generation",
      "schema validation",
      "repetitive implementation",
    ],
  },
  {
    id: "gpt-4o",
    provider: "openai",
    tier: "standard",
    costTier: "medium",
    capabilities: {
      reasoning: 8.5,
      coding: 8.8,
      speed: 8.0,
      costEfficiency: 7.0,
      contextWindow: 128_000,
    },
    strengths: [
      "general software development",
      "API design",
      "unit testing",
      "TypeScript integration",
    ],
  },
  {
    id: "o3-mini",
    provider: "openai",
    tier: "reasoning",
    costTier: "high",
    capabilities: {
      reasoning: 9.7,
      coding: 9.4,
      speed: 5.0,
      costEfficiency: 6.5,
      contextWindow: 200_000,
    },
    strengths: [
      "stem-grade reasoning",
      "concurrency & race condition debugging",
      "formal verification",
      "complex logic verification",
    ],
  },

  // ─── Local / Fallback Mock Model ───
  {
    id: "mock-orchestrator-model",
    provider: "mock",
    tier: "fast",
    costTier: "free",
    capabilities: {
      reasoning: 6.0,
      coding: 6.0,
      speed: 10.0,
      costEfficiency: 10.0,
      contextWindow: 64_000,
    },
    strengths: ["offline testing", "zero cost", "deterministic simulations"],
  },
];

/**
 * Determine which AI providers are actually configured in the environment.
 */
export function getAvailableProviders(): Set<string> {
  const providers = new Set<string>();

  if (process.env.ANTHROPIC_API_KEY) {
    providers.add("anthropic");
  }
  if (process.env.GOOGLE_GENERATIVE_AI_API_KEY) {
    providers.add("google");
  }
  if (
    process.env.GOOGLE_VERTEX_PROJECT &&
    process.env.GOOGLE_CLIENT_EMAIL &&
    process.env.GOOGLE_PRIVATE_KEY
  ) {
    providers.add("vertex");
  }
  if (process.env.OPENAI_API_KEY) {
    providers.add("openai");
  }

  // Fallback mock provider for offline tests or when no keys are present
  if (providers.size === 0) {
    providers.add("mock");
  }

  return providers;
}
