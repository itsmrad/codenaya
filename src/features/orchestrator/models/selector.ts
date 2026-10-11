import { ModelTier, ModelSelection, SubagentRole, TaskComplexity } from "../types";
import { MODEL_CATALOG, getAvailableProviders } from "./registry";
import {
  EvaluatedModel,
  ModelSelectionDecision,
  ModelSelectionInput,
  TaskCategory,
  WorkClassification,
} from "./types";
import { WorkClassifier } from "./classifier";
import { ModelComparator } from "./comparator";

export interface ModelSelectorOptions {
  preferredTier?: ModelTier;
  preferredProvider?: "openai" | "anthropic" | "google" | "vertex";
  availableProviders?: Set<string>;
  explicitCandidates?: EvaluatedModel[];
}

/**
 * Intelligent Model Selection Layer.
 *
 * Evaluates tasks along 8 dimensions (Complexity, Reasoning requirements, Coding difficulty,
 * Context size, Required accuracy, Speed requirements, Expected impact, Cost/resource usage),
 * compares available candidate models, and yields:
 *   - MODEL
 *   - REASON
 *   - EXPECTED OUTPUT
 *   - CONFIDENCE
 *
 * Kept strictly decoupled from task execution so selection strategies can evolve independently.
 */
export class ModelSelector {
  private availableProviders: Set<string>;
  private classifier: WorkClassifier;
  private comparator: ModelComparator;
  private catalog: EvaluatedModel[];

  constructor(availableProviders?: Set<string>, catalog?: EvaluatedModel[]) {
    this.availableProviders = availableProviders ?? getAvailableProviders();
    this.classifier = new WorkClassifier();
    this.comparator = new ModelComparator();
    this.catalog = catalog ?? MODEL_CATALOG;
  }

  /**
   * Primary entry point: Intelligent model selection for a task or subtask.
   */
  public selectModelForTask(
    input: ModelSelectionInput,
    options?: ModelSelectorOptions
  ): ModelSelectionDecision {
    // 1. Classify work along all 8 dimensions
    const classification = this.classifier.classify(input);

    // 2. Filter available models based on configured providers
    const activeProviders = options?.availableProviders ?? this.availableProviders;
    let availableModels = (options?.explicitCandidates ?? this.catalog).filter((m) =>
      activeProviders.has(m.provider)
    );

    // If preferred provider requested, prioritize it if present
    if (options?.preferredProvider && activeProviders.has(options.preferredProvider)) {
      const preferredSubset = availableModels.filter(
        (m) => m.provider === options.preferredProvider
      );
      if (preferredSubset.length > 0) {
        availableModels = preferredSubset;
      }
    }

    // Safety fallback: if no external providers are active, use local mock
    if (availableModels.length === 0) {
      const mockModel = this.catalog.find((m) => m.provider === "mock") ?? {
        id: "mock-orchestrator-model",
        provider: "mock" as const,
        tier: "fast" as const,
        capabilities: {
          reasoning: 6,
          coding: 6,
          speed: 10,
          costEfficiency: 10,
          contextWindow: 64_000,
        },
        strengths: ["offline-simulation"],
      };
      availableModels = [mockModel];
    }

    // 3. Compare capabilities of all candidate models
    const comparison = this.comparator.compareModels(availableModels, classification, {
      preferredTier: options?.preferredTier,
    });
    const winningModel = comparison.winner;

    // 4. Construct Expected Output description
    const expectedOutput = this.deriveExpectedOutput(classification.category, input.role);

    // 5. Construct Fallback Chain from ranked runners-up
    const fallbackChain = comparison.rankedCandidates
      .filter((c) => !c.isWinner)
      .map((c) => ({
        id: c.modelId,
        provider: c.provider as EvaluatedModel["provider"],
        tier: c.tier,
      }));

    // Ensure mock model is always at tail of fallback chain if not already there
    if (!fallbackChain.some((f) => f.provider === "mock") && winningModel.provider !== "mock") {
      fallbackChain.push({
        id: "mock-orchestrator-model",
        provider: "mock",
        tier: "fast",
      });
    }

    return {
      model: {
        id: winningModel.id,
        provider: winningModel.provider,
        tier: winningModel.tier,
      },
      reason: comparison.comparativeRationale,
      expectedOutput,
      confidence: comparison.confidence,
      classification,
      comparedCandidates: comparison.rankedCandidates,
      fallbackChain,
    };
  }

  /**
   * Legacy / simplified adapter returning ModelSelection interface for compatibility with existing pipeline callers.
   */
  public selectModel(
    complexity: TaskComplexity,
    role: SubagentRole,
    options?: ModelSelectorOptions
  ): ModelSelection {
    const decision = this.selectModelForTask(
      {
        taskTitle: `${role} task`,
        taskDescription: `Execution for role ${role} with complexity ${complexity}`,
        role,
        explicitClassification: {
          complexity,
        },
      },
      options
    );

    return {
      provider: decision.model.provider,
      modelId: decision.model.id,
      tier: decision.model.tier,
      reason: decision.reason,
      expectedOutput: decision.expectedOutput,
      confidence: decision.confidence,
    };
  }

  /**
   * Determine expected output contract for a task category.
   */
  private deriveExpectedOutput(category: TaskCategory, role?: SubagentRole): string {
    if (role === "reviewer" || category === "final-code-review") {
      return "Senior engineering review verdict with criteria scorecard, findings, and improvement recommendations.";
    }

    if (role === "architect" || category === "architecture") {
      return "Architectural blueprint, component boundaries, dependency tree, and interface contracts.";
    }

    if (role === "tester") {
      return "Structural validation results, import/export verification, and diagnostic warnings.";
    }

    switch (category) {
      case "security-analysis":
        return "Vulnerability assessment report with identified risk severity, CVE patterns, and hardened remediation fixes.";
      case "complex-debugging":
        return "Root-cause diagnosis, reproduction steps, and verified surgical remediation patch.";
      case "large-refactor":
        return "Non-breaking modular refactoring with type parity and preserved system semantics.";
      case "difficult-implementation":
        return "Production-ready implementation with strict TypeScript types, defensive edge case handling, and tests.";
      case "difficult-reasoning":
        return "Formal logical specification and optimized algorithmic solution.";
      case "simple-edit":
        return "Targeted surgical single-file modification with exact diff content.";
      case "repository-exploration":
        return "Structured catalog of repository files, dependencies, configurations, and architecture patterns.";
      case "file-searching":
        return "Precise list of symbol occurrences, matching paths, and line references.";
      case "repetitive-implementation":
        return "Boilerplate code cleanly adhering to established repository conventions.";
      case "formatting":
        return "Formatted source code adhering strictly to project linter and style guidelines.";
      case "straightforward-fix":
        return "Direct, concise correction resolving the identified defect without collateral changes.";
      default:
        return "Functional, well-structured code changes fulfilling requirements.";
    }
  }

  /**
   * Classify work for external inspection.
   */
  public classifyTask(input: ModelSelectionInput): WorkClassification {
    return this.classifier.classify(input);
  }
}
