import { ModelTier, SubagentRole, TaskComplexity } from "../types";

/**
 * Explicit task categories that guide model suitability.
 */
export type TaskCategory =
  // Strong reasoning tasks
  | "architecture"
  | "complex-debugging"
  | "difficult-implementation"
  | "security-analysis"
  | "large-refactor"
  | "final-code-review"
  | "difficult-reasoning"
  // Faster, lightweight tasks
  | "simple-edit"
  | "repository-exploration"
  | "file-searching"
  | "repetitive-implementation"
  | "formatting"
  | "straightforward-fix"
  // General / mixed
  | "general";

/**
 * 8-dimensional work classification profile.
 */
export interface WorkClassification {
  /** 1. Overall task complexity */
  complexity: TaskComplexity;
  /** 2. Depth of reasoning needed */
  reasoningRequirements: "minimal" | "moderate" | "deep" | "intensive";
  /** 3. Technical and coding difficulty */
  codingDifficulty: "trivial" | "standard" | "challenging" | "expert";
  /** 4. Context size volume expected */
  contextSize: "small" | "medium" | "large" | "massive";
  /** 5. Tolerance for error */
  requiredAccuracy: "tolerant" | "high" | "critical";
  /** 6. Response latency requirement */
  speedRequirements: "low" | "normal" | "high" | "immediate";
  /** 7. Radius of impact on the codebase */
  expectedImpact: "isolated" | "component" | "system-wide";
  /** 8. Resource and token cost sensitivity */
  costSensitivity: "budget-conscious" | "balanced" | "quality-first";
  /** Inferred task category */
  category: TaskCategory;
}

/**
 * Capability metrics for a candidate model.
 */
export interface ModelCapabilityScores {
  /** Reasoning & logic prowess (1-10) */
  reasoning: number;
  /** Code generation & refactoring quality (1-10) */
  coding: number;
  /** Inference speed / latency score (1-10, 10 being fastest) */
  speed: number;
  /** Cost efficiency (1-10, 10 being cheapest) */
  costEfficiency: number;
  /** Context window capacity in tokens */
  contextWindow: number;
}

/**
 * Extended model candidate with detailed capability profile.
 */
export interface EvaluatedModel {
  id: string;
  provider: "openai" | "anthropic" | "google" | "vertex" | "mock";
  tier: ModelTier;
  capabilities: ModelCapabilityScores;
  strengths: string[];
}

/**
 * Model candidate comparison result.
 */
export interface ModelCandidateComparison {
  modelId: string;
  provider: string;
  tier: ModelTier;
  suitabilityScore: number; // 0 - 100
  pros: string[];
  cons: string[];
  isWinner: boolean;
}

/**
 * Output of the intelligent model-selection layer.
 */
export interface ModelSelectionDecision {
  /** MODEL: chosen model details */
  model: {
    id: string;
    provider: "openai" | "anthropic" | "google" | "vertex" | "mock";
    tier: ModelTier;
  };
  /** REASON: multi-dimensional rationale for why this model was chosen */
  reason: string;
  /** EXPECTED OUTPUT: what the model is expected to produce */
  expectedOutput: string;
  /** CONFIDENCE: confidence score (0.0 to 1.0) */
  confidence: number;
  /** Work classification that drove this decision */
  classification: WorkClassification;
  /** Comparison of evaluated candidate models */
  comparedCandidates: ModelCandidateComparison[];
  /** Graceful fallback chain if the chosen model is unavailable */
  fallbackChain: Array<{
    id: string;
    provider: "openai" | "anthropic" | "google" | "vertex" | "mock";
    tier: ModelTier;
  }>;
}

/**
 * Input to the model selection layer.
 */
export interface ModelSelectionInput {
  taskTitle: string;
  taskDescription: string;
  role?: SubagentRole;
  category?: TaskCategory;
  targetFiles?: string[];
  explicitClassification?: Partial<WorkClassification>;
}
