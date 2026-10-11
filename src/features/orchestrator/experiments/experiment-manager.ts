import { ICodebaseFileSystem } from "../codebase/file-system";
import { ReviewResult, ValidationResult } from "../types";
import { VersionManager } from "../safety/version-manager";
import { StrategyDetector } from "./strategy-detector";
import {
  ExperimentBaseline,
  ExperimentDecision,
  ExperimentHistory,
  ExperimentResult,
  FailedStrategyRecord,
  OptimizationExperiment,
} from "./types";

export interface CreateExperimentOptions {
  hypothesis: string;
  proposedChange: string;
  expectedImprovement: string;
  filesAffected: string[];
  testsRequired: string[];
  baseline?: Partial<ExperimentBaseline>;
  maxRetries?: number;
  newInformationJustification?: string;
}

export interface EvaluateExperimentOptions {
  validation?: ValidationResult;
  review?: ReviewResult;
  customScore?: number;
  customSummary?: string;
  requiredTestsPassed?: boolean;
  failedTestNames?: string[];
  metrics?: Record<string, number | string>;
  allowRetryIfMinor?: boolean;
}

/**
 * Experiment Manager.
 *
 * Implements the core orchestrator experiment protocol:
 * - Every meaningful optimization attempt is treated as a formal experiment.
 * - Each experiment contains: ID, HYPOTHESIS, BASELINE, PROPOSED_CHANGE, EXPECTED_IMPROVEMENT,
 *   FILES_AFFECTED, TESTS_REQUIRED, RESULT, DECISION.
 * - Decisions: ACCEPT, REJECT, RETRY, ABANDON.
 * - Never silently replaces the current best implementation with an unverified experiment.
 * - An experiment becomes the new best result ONLY after it passes validation and demonstrates
 *   a meaningful improvement.
 * - Maintains an experiment history to know which approaches have already failed.
 * - Prevents repeatedly attempting the same failed strategy unless new information justifies it.
 */
export class ExperimentManager {
  private experiments: Map<string, OptimizationExperiment> = new Map();
  private failedStrategies: FailedStrategyRecord[] = [];
  private acceptedExperiments: OptimizationExperiment[] = [];
  private currentBestExperiment: OptimizationExperiment | null = null;
  private strategyDetector: StrategyDetector;
  private versionManager?: VersionManager;
  private idCounter = 0;

  constructor(options?: {
    strategyDetector?: StrategyDetector;
    versionManager?: VersionManager;
  }) {
    this.strategyDetector = options?.strategyDetector ?? new StrategyDetector();
    this.versionManager = options?.versionManager;
  }

  /**
   * Proposes a new optimization experiment after verifying it is not a repeated failed strategy.
   * Throws an error if a similar failed approach is attempted without new justifying information.
   */
  public async createExperiment(
    fileSystem: ICodebaseFileSystem | null,
    options: CreateExperimentOptions
  ): Promise<OptimizationExperiment> {
    // 1. Guard against repeated failed strategies
    const viability = this.strategyDetector.checkStrategyViability(
      {
        hypothesis: options.hypothesis,
        proposedChange: options.proposedChange,
        filesAffected: options.filesAffected,
        newInformationJustification: options.newInformationJustification,
      },
      this.failedStrategies
    );

    if (!viability.isPermitted) {
      throw new Error(viability.blockedReason || "Repeated failed strategy blocked.");
    }

    const expId = `exp-opt-${++this.idCounter}-${Date.now().toString(36)}`;

    // 2. Establish baseline from current best or default
    let baselineScore = 0;
    let baselineCheckpointId: string | undefined;
    let baselineCheckpointName: string | undefined;

    if (this.versionManager) {
      const bestVer = this.versionManager.getBestVersion();
      if (bestVer) {
        baselineCheckpointId = bestVer.id;
        baselineCheckpointName = bestVer.name;
        baselineScore = bestVer.metadata?.score ?? 0;
      }
    } else if (this.currentBestExperiment?.result) {
      baselineScore = this.currentBestExperiment.result.score;
    }

    const baseline: ExperimentBaseline = {
      score: options.baseline?.score ?? baselineScore,
      validationPassed: options.baseline?.validationPassed ?? true,
      checkpointId: options.baseline?.checkpointId ?? baselineCheckpointId,
      checkpointName: options.baseline?.checkpointName ?? baselineCheckpointName,
      timestamp: options.baseline?.timestamp ?? Date.now(),
      metrics: options.baseline?.metrics,
    };

    // 3. Start experiment in VersionManager if provided
    let checkpointBefore;
    if (this.versionManager && fileSystem) {
      await this.versionManager.startExperiment(
        fileSystem,
        options.hypothesis,
        options.filesAffected,
        undefined,
        expId
      );
      checkpointBefore = this.versionManager.getCurrentVersion() ?? undefined;
    }

    const experiment: OptimizationExperiment = {
      experimentId: expId,
      hypothesis: options.hypothesis,
      baseline,
      proposedChange: options.proposedChange,
      expectedImprovement: options.expectedImprovement,
      filesAffected: [...options.filesAffected],
      testsRequired: [...options.testsRequired],
      startedAt: Date.now(),
      checkpointBefore,
      retryCount: 0,
      maxRetries: options.maxRetries ?? 2,
      justificationForRetry: options.newInformationJustification,
    };

    this.experiments.set(expId, experiment);
    return experiment;
  }

  /**
   * Evaluates an experiment against its tests, validation, review, and baseline.
   * Enforces that an experiment only becomes the new best result if it passes validation
   * and demonstrates a meaningful improvement.
   */
  public async evaluateExperiment(
    fileSystem: ICodebaseFileSystem | null,
    experimentId: string,
    evalOptions: EvaluateExperimentOptions
  ): Promise<{
    experiment: OptimizationExperiment;
    decision: ExperimentDecision;
    promotedToBest: boolean;
  }> {
    const experiment = this.experiments.get(experimentId);
    if (!experiment) {
      throw new Error(`Experiment '${experimentId}' not found.`);
    }

    const { validation, review, customScore, requiredTestsPassed, failedTestNames } = evalOptions;

    // 1. Calculate outcome score (0-100)
    let score = customScore ?? 0;
    if (customScore === undefined) {
      if (review) {
        score = review.score;
      } else if (validation) {
        score = validation.passed ? 85 : 30;
      }
    }

    const scoreDelta = score - experiment.baseline.score;
    const testsPassed = requiredTestsPassed !== false && (failedTestNames ?? []).length === 0;
    const validationPassed = validation ? validation.passed : true;
    const hasCriticalFindings = review?.findings.some((f) => f.severity === "critical") ?? false;

    // Meaningful improvement requirement:
    // 1. Must pass all validation checks (no syntax/runtime errors)
    // 2. Must pass all required tests
    // 3. Must not have critical review findings
    // 4. Must show measurable gain (scoreDelta > 0 OR score delta >= 0 with resolved defects)
    const isImprovement =
      validationPassed &&
      testsPassed &&
      !hasCriticalFindings &&
      (scoreDelta > 0 || (scoreDelta === 0 && score >= 80 && (experiment.baseline.score === 0 || !experiment.baseline.validationPassed)));

    const failedTests = [
      ...(failedTestNames ?? []),
      ...(validation?.errors ?? []),
      ...(hasCriticalFindings ? ["Critical code review findings detected"] : []),
    ];

    const result: ExperimentResult = {
      passed: validationPassed && testsPassed && !hasCriticalFindings,
      score,
      scoreDelta,
      demonstratedImprovement: isImprovement,
      validationResult: validation,
      reviewResult: review,
      failedTests,
      metrics: evalOptions.metrics,
      summary:
        evalOptions.customSummary ??
        (isImprovement
          ? `Experiment demonstrated verified improvement: Score ${score}/100 (+${scoreDelta} vs baseline).`
          : `Experiment failed to demonstrate meaningful improvement: Score ${score}/100 (${scoreDelta >= 0 ? "+" : ""}${scoreDelta}).`),
      evaluatedAt: Date.now(),
    };

    experiment.result = result;
    experiment.completedAt = Date.now();

    // 2. Make formal decision: ACCEPT | REJECT | RETRY | ABANDON
    let decision: ExperimentDecision;
    let decisionReason: string;
    let promotedToBest = false;

    if (isImprovement) {
      decision = "ACCEPT";
      decisionReason = `Experiment verified: score improved by +${scoreDelta} points (${score}/100) and all ${experiment.testsRequired.length} required tests passed.`;
      promotedToBest = true;

      this.acceptedExperiments.push(experiment);
      this.currentBestExperiment = experiment;

      // Update version manager if linked
      if (this.versionManager && fileSystem) {
        await this.versionManager.acceptExperiment(fileSystem, experimentId, score);
      }
    } else {
      const isSyntaxOrImportMinor =
        validation &&
        !validation.passed &&
        validation.errors.some(
          (e) => e.toLowerCase().includes("import") || e.toLowerCase().includes("export") || e.toLowerCase().includes("typo")
        );

      const canRetry =
        evalOptions.allowRetryIfMinor &&
        isSyntaxOrImportMinor &&
        (experiment.retryCount ?? 0) < (experiment.maxRetries ?? 2);

      if (canRetry) {
        decision = "RETRY";
        experiment.retryCount = (experiment.retryCount ?? 0) + 1;
        decisionReason = `Minor addressable defect encountered (${validation?.errors[0]}). Retry #${experiment.retryCount} permitted.`;
      } else if (score < 40 || hasCriticalFindings || (experiment.retryCount ?? 0) >= (experiment.maxRetries ?? 2)) {
        decision = "ABANDON";
        decisionReason = `Approach abandoned: severe regression or exhausted retry limit. Score: ${score}/100. Failures: ${failedTests.slice(0, 3).join("; ")}`;
      } else {
        decision = "REJECT";
        decisionReason = `Experiment rejected: did not demonstrate meaningful quality improvement over baseline (${score} vs ${experiment.baseline.score}).`;
      }

      // If rejected or abandoned, record in failed strategies and rollback
      if (decision === "REJECT" || decision === "ABANDON") {
        this.recordFailedStrategy(experiment, decision, decisionReason);

        if (this.versionManager && fileSystem) {
          await this.versionManager.rejectAndRollback(
            fileSystem,
            experimentId,
            decisionReason,
            { validation, review }
          );
        }
      }
    }

    experiment.decision = decision;
    experiment.decisionReason = decisionReason;

    return {
      experiment,
      decision,
      promotedToBest,
    };
  }

  /**
   * Records a failed or abandoned approach into the experiment history.
   */
  private recordFailedStrategy(
    experiment: OptimizationExperiment,
    decision: "REJECT" | "ABANDON",
    failureReason: string
  ): void {
    const fingerprint = this.strategyDetector.generateFingerprint(
      experiment.hypothesis,
      experiment.proposedChange,
      experiment.filesAffected
    );

    this.failedStrategies.push({
      experimentId: experiment.experimentId,
      fingerprint,
      hypothesis: experiment.hypothesis,
      proposedChange: experiment.proposedChange,
      filesAffected: [...experiment.filesAffected],
      failureReason,
      decision,
      failedAt: Date.now(),
    });
  }

  public getHistory(): ExperimentHistory {
    return {
      experiments: Array.from(this.experiments.values()),
      failedStrategies: [...this.failedStrategies],
      acceptedExperiments: [...this.acceptedExperiments],
      currentBestExperiment: this.currentBestExperiment,
    };
  }

  public getExperiment(id: string): OptimizationExperiment | undefined {
    return this.experiments.get(id);
  }

  public getFailedStrategies(): FailedStrategyRecord[] {
    return [...this.failedStrategies];
  }

  public getAcceptedExperiments(): OptimizationExperiment[] {
    return [...this.acceptedExperiments];
  }

  public getCurrentBest(): OptimizationExperiment | null {
    return this.currentBestExperiment;
  }

  /**
   * Formats the experiment log into a structured report table.
   */
  public toMarkdownSummary(): string {
    const all = Array.from(this.experiments.values());
    if (all.length === 0) {
      return "No optimization experiments recorded.";
    }

    const lines: string[] = [
      "| EXPERIMENT_ID | HYPOTHESIS | BASELINE | RESULT | DECISION | REASON |",
      "| --- | --- | --- | --- | --- | --- |",
    ];

    for (const exp of all) {
      const scoreStr = exp.result ? `${exp.result.score}/100` : "Pending";
      const deltaStr = exp.result ? `(${exp.result.scoreDelta >= 0 ? "+" : ""}${exp.result.scoreDelta})` : "";
      const decisionStr = exp.decision ?? "PENDING";
      const reasonStr = (exp.decisionReason ?? "In progress").replace(/\|/g, "\\|").slice(0, 45);

      lines.push(
        `| ${exp.experimentId} | ${exp.hypothesis.slice(0, 35)} | ${exp.baseline.score}/100 | ${scoreStr} ${deltaStr} | **${decisionStr}** | ${reasonStr} |`
      );
    }

    return lines.join("\n");
  }
}
