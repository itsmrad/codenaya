import { ReviewResult, ValidationResult } from "../types";
import { RepositoryCheckpoint } from "../safety/types";

/**
 * Valid decisions for an experiment evaluation.
 */
export type ExperimentDecision = "ACCEPT" | "REJECT" | "RETRY" | "ABANDON";

/**
 * Baseline state against which an experiment is measured.
 */
export interface ExperimentBaseline {
  checkpointId?: string;
  checkpointName?: string;
  score: number;
  validationPassed: boolean;
  timestamp: number;
  metrics?: Record<string, number | string>;
}

/**
 * Evaluation result of an executed experiment.
 */
export interface ExperimentResult {
  passed: boolean;
  score: number;
  scoreDelta: number;
  demonstratedImprovement: boolean;
  validationResult?: ValidationResult;
  reviewResult?: ReviewResult;
  failedTests: string[];
  metrics?: Record<string, number | string>;
  summary: string;
  details?: string;
  evaluatedAt: number;
}

/**
 * Formal optimization experiment structure.
 *
 * Each experiment must contain:
 * - EXPERIMENT_ID
 * - HYPOTHESIS
 * - BASELINE
 * - PROPOSED_CHANGE
 * - EXPECTED_IMPROVEMENT
 * - FILES_AFFECTED
 * - TESTS_REQUIRED
 * - RESULT
 * - DECISION
 */
export interface OptimizationExperiment {
  experimentId: string;
  hypothesis: string;
  baseline: ExperimentBaseline;
  proposedChange: string;
  expectedImprovement: string;
  filesAffected: string[];
  testsRequired: string[];
  result?: ExperimentResult;
  decision?: ExperimentDecision;
  decisionReason?: string;
  startedAt: number;
  completedAt?: number;
  checkpointBefore?: RepositoryCheckpoint;
  checkpointAfter?: RepositoryCheckpoint;
  retryCount?: number;
  maxRetries?: number;
  justificationForRetry?: string;
}

/**
 * Normalized representation of a strategy to detect repeated attempts.
 */
export interface StrategyFingerprint {
  normalizedHypothesis: string;
  targetFiles: string[];
  normalizedApproach: string;
}

/**
 * Record of a previously failed strategy.
 */
export interface FailedStrategyRecord {
  experimentId: string;
  fingerprint: StrategyFingerprint;
  hypothesis: string;
  proposedChange: string;
  filesAffected: string[];
  failureReason: string;
  decision: "REJECT" | "ABANDON";
  failedAt: number;
}

/**
 * Full history of experiments and failed strategies.
 */
export interface ExperimentHistory {
  experiments: OptimizationExperiment[];
  failedStrategies: FailedStrategyRecord[];
  acceptedExperiments: OptimizationExperiment[];
  currentBestExperiment: OptimizationExperiment | null;
}
