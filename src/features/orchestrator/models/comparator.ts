import { ModelTier } from "../types";
import {
  EvaluatedModel,
  ModelCandidateComparison,
  WorkClassification,
} from "./types";

export interface ComparisonOptions {
  preferredTier?: ModelTier;
}

export class ModelComparator {
  /**
   * Compare all available candidate models against the work classification profile.
   * Returns ranked comparison list with suitability scores, pros/cons, and winning model.
   */
  public compareModels(
    candidates: EvaluatedModel[],
    classification: WorkClassification,
    options?: ComparisonOptions
  ): {
    rankedCandidates: ModelCandidateComparison[];
    winner: EvaluatedModel;
    confidence: number;
    comparativeRationale: string;
  } {
    if (candidates.length === 0) {
      throw new Error("No candidate models provided for comparison.");
    }

    const scored = candidates.map((candidate) => {
      const scoreData = this.calculateSuitability(candidate, classification, options);
      return {
        model: candidate,
        ...scoreData,
      };
    });

    // Sort descending by suitability score
    scored.sort((a, b) => b.suitabilityScore - a.suitabilityScore);

    const winnerData = scored[0];
    const runnerUpData = scored.length > 1 ? scored[1] : undefined;

    // Normalize confidence (between 0.70 and 0.99 for highest match)
    const baseConfidence = Math.min(0.99, Math.max(0.65, winnerData.suitabilityScore / 100));
    // Bonus confidence if winner strongly outperforms runner-up
    const margin = runnerUpData
      ? (winnerData.suitabilityScore - runnerUpData.suitabilityScore) / 100
      : 0.15;
    const confidence = parseFloat(Math.min(0.99, baseConfidence + margin * 0.1).toFixed(2));

    const rankedCandidates: ModelCandidateComparison[] = scored.map((s, idx) => ({
      modelId: s.model.id,
      provider: s.model.provider,
      tier: s.model.tier,
      suitabilityScore: Math.round(s.suitabilityScore),
      pros: s.pros,
      cons: s.cons,
      isWinner: idx === 0,
    }));

    // Formulate comparative rationale
    const comparativeRationale = this.buildRationale(
      winnerData.model,
      winnerData.pros,
      runnerUpData?.model,
      classification
    );

    return {
      rankedCandidates,
      winner: winnerData.model,
      confidence,
      comparativeRationale,
    };
  }

  private calculateSuitability(
    candidate: EvaluatedModel,
    classification: WorkClassification,
    options?: ComparisonOptions
  ): { suitabilityScore: number; pros: string[]; cons: string[] } {
    let score = 50;
    const pros: string[] = [];
    const cons: string[] = [];
    const caps = candidate.capabilities;

    // 0. Preferred Tier alignment if explicitly requested
    if (options?.preferredTier) {
      if (candidate.tier === options.preferredTier) {
        score += 25;
        pros.push(`Matches requested ${options.preferredTier} tier.`);
      }
    }

    // 1. Complexity & Tier alignment
    if (classification.complexity === "critical") {
      if (candidate.tier === "reasoning") {
        score += 30;
        pros.push("Reasoning model directly matches critical complexity requirements.");
      } else if (candidate.tier === "advanced") {
        score += 15;
      } else {
        score -= 25;
        cons.push(`Tier '${candidate.tier}' under-powered for critical complexity.`);
      }
    } else if (classification.complexity === "high") {
      if (candidate.tier === "advanced" || candidate.tier === "reasoning") {
        score += 25;
        pros.push(`High capability tier '${candidate.tier}' suited for high complexity task.`);
      } else if (candidate.tier === "fast") {
        score -= 15;
        cons.push("Fast tier may lack coding depth for high complexity work.");
      }
    } else if (classification.complexity === "medium") {
      if (candidate.tier === "standard") {
        score += 25;
        pros.push("Balanced standard tier model optimal for medium complexity work.");
      } else if (candidate.tier === "advanced") {
        score += 10;
      } else if (candidate.tier === "fast") {
        score -= 5;
        cons.push("Fast model has reduced reasoning depth for medium complexity.");
      }
    } else if (classification.complexity === "low") {
      if (candidate.tier === "fast") {
        score += 25;
        pros.push("Fast tier model ideal for low complexity task.");
      } else if (candidate.tier === "reasoning" || candidate.tier === "advanced") {
        score -= 20;
        cons.push(`Over-provisioned model tier '${candidate.tier}' for low complexity task.`);
      }
    }

    // 2. Reasoning alignment
    if (
      classification.reasoningRequirements === "intensive" ||
      classification.reasoningRequirements === "deep"
    ) {
      if (caps.reasoning >= 9.5) {
        score += 25;
        pros.push(`Exceptional reasoning score (${caps.reasoning}/10) matches intensive requirements.`);
      } else if (caps.reasoning >= 8.5) {
        score += 15;
        pros.push(`Strong reasoning capability (${caps.reasoning}/10).`);
      } else {
        score -= 25;
        cons.push(`Reasoning score (${caps.reasoning}/10) is insufficient for complex analytical work.`);
      }
    } else if (classification.reasoningRequirements === "minimal") {
      if (candidate.tier === "reasoning" || candidate.tier === "advanced") {
        score -= 15;
        cons.push(`Over-provisioned for minimal reasoning task.`);
      } else {
        score += 15;
        pros.push(`Lightweight model matches minimal reasoning needs efficiently.`);
      }
    }

    // 3. Coding difficulty alignment
    if (
      classification.codingDifficulty === "expert" ||
      classification.codingDifficulty === "challenging"
    ) {
      if (caps.coding >= 9.5) {
        score += 20;
        pros.push(`Industry-leading coding benchmark score (${caps.coding}/10).`);
      } else if (caps.coding >= 8.5) {
        score += 10;
      } else {
        score -= 20;
        cons.push(`Coding score (${caps.coding}/10) below optimal threshold for challenging implementation.`);
      }
    } else if (classification.codingDifficulty === "trivial") {
      if (caps.speed >= 8.5 && caps.costEfficiency >= 8.5) {
        score += 20;
        pros.push(`Fast and highly cost-effective for trivial code changes.`);
      }
    }

    // 4. Speed & Latency requirements
    if (
      classification.speedRequirements === "immediate" ||
      classification.speedRequirements === "high"
    ) {
      if (caps.speed >= 9.0) {
        score += 15;
        pros.push(`Ultra-fast response latency (${caps.speed}/10).`);
      } else if (caps.speed <= 6.0) {
        score -= 15;
        cons.push(`High latency model unsuitable for high-speed exploration/editing.`);
      }
    }

    // 5. Cost sensitivity
    if (classification.costSensitivity === "budget-conscious") {
      if (caps.costEfficiency >= 9.0) {
        score += 15;
        pros.push(`High cost-efficiency (${caps.costEfficiency}/10) preserves token budget.`);
      } else if (caps.costEfficiency <= 6.0) {
        score -= 20;
        cons.push(`High token cost unsuited for budget-conscious routine task.`);
      }
    } else if (classification.costSensitivity === "quality-first") {
      if (caps.reasoning >= 9.0 && caps.coding >= 9.0) {
        score += 15;
        pros.push(`Prioritizes output fidelity and accuracy over cost.`);
      }
    }

    // 6. Context size sufficiency
    if (classification.contextSize === "massive" && caps.contextWindow >= 1_000_000) {
      score += 15;
      pros.push(`Massive context window (${(caps.contextWindow / 1000).toFixed(0)}k tokens) handles whole codebase.`);
    } else if (classification.contextSize === "massive" && caps.contextWindow < 500_000) {
      score -= 15;
      cons.push(`Context window (${(caps.contextWindow / 1000).toFixed(0)}k tokens) is restricted for massive context.`);
    }

    const suitabilityScore = Math.max(10, Math.min(100, score));

    return {
      suitabilityScore,
      pros,
      cons,
    };
  }

  private buildRationale(
    winner: EvaluatedModel,
    winnerPros: string[],
    runnerUp: EvaluatedModel | undefined,
    classification: WorkClassification
  ): string {
    const parts: string[] = [
      `Selected ${winner.id} (${winner.provider}, tier: ${winner.tier}) for ${classification.category} task.`,
    ];

    if (winnerPros.length > 0) {
      parts.push(`Key advantages: ${winnerPros.slice(0, 2).join(" ")}`);
    }

    if (runnerUp) {
      parts.push(
        `Preferred over ${runnerUp.id} (${runnerUp.tier}) because it offers a superior trade-off for ${classification.reasoningRequirements} reasoning and ${classification.speedRequirements} latency.`
      );
    }

    return parts.join(" ");
  }
}
