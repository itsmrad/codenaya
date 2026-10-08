import { FailedStrategyRecord, StrategyFingerprint } from "./types";

export interface StrategyViabilityCheck {
  isPermitted: boolean;
  blockedReason?: string;
  matchedFailedExperimentId?: string;
  similarityScore?: number;
  newInformationAccepted?: boolean;
}

/**
 * Strategy Detector.
 *
 * Prevents the orchestrator from repeatedly attempting the same failed strategy
 * unless new information justifies it.
 */
export class StrategyDetector {
  private similarityThreshold: number;

  constructor(similarityThreshold: number = 0.65) {
    this.similarityThreshold = similarityThreshold;
  }

  /**
   * Generates a normalized fingerprint for a strategy.
   */
  public generateFingerprint(
    hypothesis: string,
    proposedChange: string,
    filesAffected: string[]
  ): StrategyFingerprint {
    const normFiles = filesAffected
      .map((f) => f.toLowerCase().replace(/\\/g, "/").replace(/^\.\//, ""))
      .sort();

    return {
      normalizedHypothesis: this.normalizeTokens(hypothesis),
      targetFiles: normFiles,
      normalizedApproach: this.normalizeTokens(proposedChange),
    };
  }

  /**
   * Evaluates if a proposed strategy is permitted or is a repeated failed attempt.
   */
  public checkStrategyViability(
    proposed: {
      hypothesis: string;
      proposedChange: string;
      filesAffected: string[];
      newInformationJustification?: string;
    },
    failedStrategies: FailedStrategyRecord[]
  ): StrategyViabilityCheck {
    if (failedStrategies.length === 0) {
      return { isPermitted: true };
    }

    const proposedFingerprint = this.generateFingerprint(
      proposed.hypothesis,
      proposed.proposedChange,
      proposed.filesAffected
    );

    let maxSimilarity = 0;
    let matchedFailure: FailedStrategyRecord | null = null;

    for (const failed of failedStrategies) {
      const similarity = this.calculateSimilarity(proposedFingerprint, failed.fingerprint);
      if (similarity > maxSimilarity) {
        maxSimilarity = similarity;
        matchedFailure = failed;
      }
    }

    if (maxSimilarity >= this.similarityThreshold && matchedFailure) {
      const hasJustification =
        proposed.newInformationJustification !== undefined &&
        proposed.newInformationJustification.trim().length >= 10;

      if (hasJustification) {
        return {
          isPermitted: true,
          matchedFailedExperimentId: matchedFailure.experimentId,
          similarityScore: maxSimilarity,
          newInformationAccepted: true,
        };
      }

      return {
        isPermitted: false,
        blockedReason: `Repeated failed strategy blocked: approach previously failed in experiment ${matchedFailure.experimentId} ("${matchedFailure.hypothesis}") with reason: ${matchedFailure.failureReason}. Repeated attempts are prohibited unless new empirical information justifies it.`,
        matchedFailedExperimentId: matchedFailure.experimentId,
        similarityScore: maxSimilarity,
        newInformationAccepted: false,
      };
    }

    return {
      isPermitted: true,
      similarityScore: maxSimilarity,
    };
  }

  /**
   * Computes composite similarity between two strategy fingerprints (0.0 to 1.0).
   */
  public calculateSimilarity(a: StrategyFingerprint, b: StrategyFingerprint): number {
    // 1. Target files overlap (Jaccard)
    const fileOverlap = this.calculateJaccardSimilarity(a.targetFiles, b.targetFiles);

    // 2. Hypothesis token overlap (Jaccard)
    const tokensA = a.normalizedHypothesis.split(" ").filter(Boolean);
    const tokensB = b.normalizedHypothesis.split(" ").filter(Boolean);
    const hypOverlap = this.calculateJaccardSimilarity(tokensA, tokensB);

    // 3. Approach token overlap (Jaccard)
    const appTokensA = a.normalizedApproach.split(" ").filter(Boolean);
    const appTokensB = b.normalizedApproach.split(" ").filter(Boolean);
    const appOverlap = this.calculateJaccardSimilarity(appTokensA, appTokensB);

    // Weighted composite: files 40%, hypothesis 35%, approach 25%
    return fileOverlap * 0.4 + hypOverlap * 0.35 + appOverlap * 0.25;
  }

  private calculateJaccardSimilarity(a: string[], b: string[]): number {
    if (a.length === 0 && b.length === 0) return 1.0;
    if (a.length === 0 || b.length === 0) return 0.0;

    const setA = new Set(a);
    const setB = new Set(b);

    let intersectionCount = 0;
    for (const item of setA) {
      if (setB.has(item)) {
        intersectionCount++;
      }
    }

    const unionCount = setA.size + setB.size - intersectionCount;
    return unionCount > 0 ? intersectionCount / unionCount : 0;
  }

  private normalizeTokens(text: string): string {
    const stopwords = new Set([
      "a", "an", "the", "in", "on", "at", "to", "for", "with", "by", "of", "and",
      "or", "is", "are", "be", "this", "that", "it", "as", "from", "will", "can",
    ]);

    return text
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, " ")
      .split(/\s+/)
      .filter((word) => word.length > 2 && !stopwords.has(word))
      .sort()
      .join(" ");
  }
}
