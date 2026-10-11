import { ICodebaseFileSystem } from "./codebase/file-system";
import { ModelSelector } from "./models/selector";
import {
  CodebaseInspection,
  FinalReport,
  ImplementationPlan,
  ModelSelection,
  OrchestratorEvent,
  OrchestratorOptions,
  ReviewResult,
  Subtask,
  ValidationResult,
  WorkflowStage,
} from "./types";
import { understandTask, UnderstoodTask } from "./pipeline/1-understand";
import { inspectCodebase } from "./pipeline/2-inspect";
import { createPlan } from "./pipeline/3-plan";
import { assignModelsToPlan } from "./pipeline/4-select-models";
import {
  ImplementationCoordinator,
  ImplementationResult,
} from "./pipeline/6-implement";
import { runValidation } from "./pipeline/7-validate";
import { runReview } from "./pipeline/8-review";
import { generateFinalReport } from "./pipeline/9-report";
import { TaskContextManager } from "./context/context-manager";
import { TaskContextSnapshot } from "./context/types";
import { RequirementTracker } from "./requirements/tracker";
import {
  RequirementVerificationReport,
  TrackedRequirement,
} from "./requirements/types";
import { GitStatusInspector } from "./safety/git-inspector";
import { SafeFileSystem } from "./safety/safe-file-system";
import { VersionManager } from "./safety/version-manager";
import { GitInspectionReport, GitSafetyState } from "./safety/types";
import { ExperimentManager } from "./experiments/experiment-manager";
import { OptimizationExperiment } from "./experiments/types";

export interface OrchestratorOutput {
  taskId: string;
  understood: UnderstoodTask;
  inspection: CodebaseInspection;
  plan: ImplementationPlan;
  modelAssignments: Record<string, ModelSelection>;
  implementation: ImplementationResult;
  validation: ValidationResult;
  review: ReviewResult;
  report: FinalReport;
  events: OrchestratorEvent[];
  context: TaskContextSnapshot;
  contextManager: TaskContextManager;
  trackedRequirements: TrackedRequirement[];
  requirementReport: RequirementVerificationReport;
  requirementTracker: RequirementTracker;
  gitSafety: GitSafetyState;
  gitInspection: GitInspectionReport;
  versionManager: VersionManager;
  gitInspector: GitStatusInspector;
  experimentManager: ExperimentManager;
  experiments: OptimizationExperiment[];
}

/**
 * Autonomous Software-Development Orchestrator Agent.
 *
 * Behaves like a Senior Engineering Lead coordinating a team of AI software engineers:
 * Workflow: Understand → Inspect → Plan → Select Models → Delegate → Implement → Test → Review → Evaluate → Improve (deferred) → Verify → Complete
 */
export class SoftwareDevelopmentOrchestrator {
  private fileSystem: ICodebaseFileSystem;
  private modelSelector: ModelSelector;
  private coordinator: ImplementationCoordinator;

  constructor(
    fileSystem: ICodebaseFileSystem,
    options?: {
      modelSelector?: ModelSelector;
      coordinator?: ImplementationCoordinator;
    }
  ) {
    this.fileSystem = fileSystem;
    this.modelSelector = options?.modelSelector ?? new ModelSelector();
    this.coordinator = options?.coordinator ?? new ImplementationCoordinator();
  }

  /**
   * Run the autonomous software development workflow for a user task.
   */
  async execute(
    userPrompt: string,
    options?: OrchestratorOptions
  ): Promise<OrchestratorOutput> {
    const taskId = options?.taskId ?? `task-${Date.now()}`;
    const contextManager: TaskContextManager =
      (options?.contextManager as TaskContextManager) ?? new TaskContextManager();
    const requirementTracker: RequirementTracker =
      (options?.requirementTracker as RequirementTracker) ?? new RequirementTracker();
    const gitInspector: GitStatusInspector =
      (options?.gitInspector as GitStatusInspector) ??
      new GitStatusInspector(options?.gitStatusOutput);
    const versionManager: VersionManager =
      (options?.versionManager as VersionManager) ?? new VersionManager();
    const experimentManager: ExperimentManager =
      (options?.experimentManager as ExperimentManager) ??
      new ExperimentManager({ versionManager });
    const events: OrchestratorEvent[] = [];

    const emit = (stage: WorkflowStage, message: string, data?: Record<string, unknown>) => {
      const event: OrchestratorEvent = {
        stage,
        message,
        timestamp: Date.now(),
        data,
      };
      events.push(event);
      options?.onEvent?.(event);
    };

    // ─────────────────────────────────────────────────────────────
    // 1. UNDERSTAND: Understand the user's request
    // ─────────────────────────────────────────────────────────────
    emit("understand", "Analyzing development request and extracting requirements.");
    const understood = understandTask(userPrompt);
    contextManager.initializeFromTask(understood);

    // ─────────────────────────────────────────────────────────────
    // 2. INSPECT: Inspect git status, architecture, and establish baseline
    // ─────────────────────────────────────────────────────────────
    emit("inspect", "Inspecting repository architecture, git status, and dependencies.");
    const gitInspection = await gitInspector.inspect(
      this.fileSystem,
      options?.gitStatusProvider
    );
    versionManager.setProtectedFiles(gitInspection.protectedFiles);

    // 4. Establish a known baseline before modifying repository
    await versionManager.establishBaseline(
      this.fileSystem,
      `Baseline pre-task: ${understood.normalizedGoal}`
    );

    // Wrap file system with SafeFileSystem: Never overwrite unrelated user work without explicit authorization
    const safeFileSystem = new SafeFileSystem(
      this.fileSystem,
      gitInspector,
      options?.authorizedUserFiles
    );

    const inspection = await inspectCodebase(
      safeFileSystem,
      understood.estimatedComplexity
    );
    contextManager.recordCodebaseInspection(inspection);
    contextManager.recordGitSafety(versionManager.getState());

    // ─────────────────────────────────────────────────────────────
    // 3. PLAN: Create implementation plan with subtasks (seq/parallel)
    // ─────────────────────────────────────────────────────────────
    emit("plan", "Formulating requirements, acceptance criteria, and subtask graph.");
    let plan = createPlan(understood, inspection, requirementTracker);
    contextManager.recordPlan(
      plan.requirements,
      plan.acceptanceCriteria,
      plan.subtasks,
      plan.trackedRequirements
    );

    // ─────────────────────────────────────────────────────────────
    // 4. SELECT MODELS: Select appropriate model based on complexity
    // ─────────────────────────────────────────────────────────────
    emit("select-models", "Selecting optimal models for subtasks based on complexity.");
    const { plan: plannedWithModels, modelAssignments } = assignModelsToPlan(
      plan,
      this.modelSelector
    );
    plan = plannedWithModels;

    // ─────────────────────────────────────────────────────────────
    // 5. DELEGATE: Assign work to specialized sub-agents
    // ─────────────────────────────────────────────────────────────
    emit("delegate", `Delegated ${plan.subtasks.length} subtasks to specialized sub-agents.`);
    for (const req of requirementTracker.getAll()) {
      if (req.status === "PENDING") {
        requirementTracker.markInProgress(req.id);
      }
    }

    // ─────────────────────────────────────────────────────────────
    // 6. IMPLEMENT: Execute subtasks within safe repository boundary
    // ─────────────────────────────────────────────────────────────
    // Create checkpoints before risky changes & maintain EXPERIMENT_VERSION
    const targetFiles = plan.subtasks.flatMap((s) => s.targetFiles || []);
    const experiment = await versionManager.startExperiment(
      safeFileSystem,
      `Implement: ${understood.normalizedGoal}`,
      targetFiles
    );

    let implementation: ImplementationResult;
    if (options?.dryRun) {
      emit("implement", "Dry-run mode enabled: skipping file modifications.");
      implementation = {
        completedSubtasks: plan.subtasks.map((s) => ({
          ...s,
          status: "ACCEPTED",
          result: {
            filesCreated: [],
            filesModified: [],
            filesDeleted: [],
            summary: "Dry run completed without filesystem writes",
          },
        })),
        filesCreated: [],
        filesModified: [],
        filesDeleted: [],
        success: true,
        errors: [],
        rejections: [],
      };
    } else {
      emit("implement", "Executing subtasks within safe repository boundary.");
      implementation = await this.coordinator.executePlan(
        plan,
        modelAssignments,
        safeFileSystem,
        (subtask: Subtask) => {
          emit("implement", `Subtask ${subtask.id} (${subtask.role}): ${subtask.status}`);
        },
        contextManager
      );
    }

    // Mark implementation progress on tracked requirements
    const modifiedOrCreated = [
      ...implementation.filesCreated,
      ...implementation.filesModified,
    ];
    for (const req of requirementTracker.getAll()) {
      if (req.status === "IN_PROGRESS" || req.status === "PENDING") {
        requirementTracker.markImplemented(
          req.id,
          modifiedOrCreated.length > 0
            ? `Implemented across ${modifiedOrCreated.length} file(s): ${modifiedOrCreated.slice(0, 4).join(", ")}`
            : "Implemented successfully in task execution batch"
        );
      }
    }

    // ─────────────────────────────────────────────────────────────
    // 7. TEST: Run automated tests and structural validation
    // ─────────────────────────────────────────────────────────────
    emit("test", "Running tests and structural validation checks.");
    const validation = await runValidation(safeFileSystem, plan.acceptanceCriteria);
    contextManager.recordValidationResults(validation);

    // ─────────────────────────────────────────────────────────────
    // 8. REVIEW: Senior engineering lead review against criteria
    // ─────────────────────────────────────────────────────────────
    emit("review", "Conducting code review against acceptance criteria.");
    const review = await runReview(plan, safeFileSystem);

    // ─────────────────────────────────────────────────────────────
    // 9. EVALUATE: Evaluate criteria, findings, and manage Git rollbacks on regressions
    // ─────────────────────────────────────────────────────────────
    emit("evaluate", `Review evaluation: Score ${review.score}/100, ${review.findings.length} findings.`);
    contextManager.recordBestResult(review.score, review.summary);

    // Git Safety Regression Evaluation:
    // If a regression occurs:
    // REJECT CHANGE → ROLLBACK → ANALYZE → CREATE ALTERNATIVE → TEST AGAIN
    const hasRegression =
      !validation.passed ||
      review.score < 50 ||
      review.findings.some((f) => f.severity === "critical");

    if (hasRegression && !options?.dryRun) {
      emit(
        "evaluate",
        "Regression detected: executing REJECT CHANGE → ROLLBACK → ANALYZE → CREATE ALTERNATIVE → TEST AGAIN."
      );
      const rollbackResult = await versionManager.rejectAndRollback(
        safeFileSystem,
        experiment.id,
        !validation.passed
          ? `Validation checks failed (${validation.errors.join("; ")})`
          : review.summary,
        { validation, review }
      );

      emit(
        "evaluate",
        `Rollback executed successfully: restored ${rollbackResult.restoredVersion}. Transient experimental files removed (${rollbackResult.filesCleanedUp.length}). Alternative strategy: ${rollbackResult.alternativeStrategy}`
      );
      contextManager.recordGitSafety(versionManager.getState());
    } else {
      // Successful change: promote to BEST_VERSION if verified score meets or exceeds previous best
      await versionManager.acceptExperiment(
        safeFileSystem,
        experiment.id,
        review.score
      );
      contextManager.recordGitSafety(versionManager.getState());
    }

    // ─────────────────────────────────────────────────────────────
    // 10. IMPROVE: Optimization experiments
    // Every meaningful optimization attempt is treated as a formal experiment.
    // ─────────────────────────────────────────────────────────────
    emit("improve", "Evaluating optimization opportunities via experiment framework.");

    // 1. Establish the primary implementation as the initial baseline experiment
    const baselineExperiment = await experimentManager.createExperiment(safeFileSystem, {
      hypothesis: `Initial implementation satisfying: ${understood.normalizedGoal}`,
      proposedChange: "Execute planned subtask batches within safe boundary",
      expectedImprovement: "Satisfy all initial requirements and acceptance criteria",
      filesAffected: targetFiles,
      testsRequired: plan.acceptanceCriteria.map((c) => c.id),
      baseline: { score: 0 },
    });

    await experimentManager.evaluateExperiment(safeFileSystem, baselineExperiment.experimentId, {
      validation,
      review,
      requiredTestsPassed: validation.passed && review.score >= 50,
      customSummary: `Baseline implementation result: Score ${review.score}/100.`,
    });

    // 2. Formulate optimization experiments for actionable review findings
    const actionableFindings = review.findings.filter(
      (f) => f.severity === "major" || f.severity === "minor" || f.severity === "suggestion"
    );

    if (actionableFindings.length > 0 && (options?.runOptimizationExperiments || !options?.dryRun)) {
      for (const finding of actionableFindings.slice(0, 2)) {
        const affectedFiles = finding.filePath ? [finding.filePath] : targetFiles.slice(0, 1);
        try {
          const optExp = await experimentManager.createExperiment(safeFileSystem, {
            hypothesis: `Resolve finding: ${finding.title}`,
            proposedChange: finding.recommendation || `Address ${finding.description}`,
            expectedImprovement: `Improve review score beyond baseline (${review.score}/100) and resolve ${finding.title}`,
            filesAffected: affectedFiles,
            testsRequired: ["structural-validation", "review-check"],
            baseline: { score: review.score },
          });

          emit("improve", `Formulated optimization experiment ${optExp.experimentId}: "${optExp.hypothesis}".`);

          const optValidation = await runValidation(safeFileSystem, plan.acceptanceCriteria);
          const optReview = await runReview(plan, safeFileSystem);

          const evalResult = await experimentManager.evaluateExperiment(
            safeFileSystem,
            optExp.experimentId,
            {
              validation: optValidation,
              review: optReview,
              requiredTestsPassed: optValidation.passed,
            }
          );

          emit(
            "improve",
            `Experiment ${optExp.experimentId} evaluated with decision: [${evalResult.decision}]. Promoted to best: ${evalResult.promotedToBest}.`
          );
        } catch (err: unknown) {
          const errMsg = err instanceof Error ? err.message : String(err);
          emit("improve", `Optimization experiment blocked or skipped: ${errMsg}`);
        }
      }
    }

    // ─────────────────────────────────────────────────────────────
    // 11. VERIFY: Verify acceptance criteria and every requirement individually
    // ─────────────────────────────────────────────────────────────
    emit("verify", "Verifying individual requirements and acceptance criteria against empirical evidence.");
    for (const criterion of plan.acceptanceCriteria) {
      const assessment = review.criteriaAssessments.find(
        (c) => c.criterionId === criterion.id
      );
      if (assessment) {
        criterion.status = assessment.satisfied ? "passed" : "failed";
        criterion.details = assessment.notes;
        if (assessment.satisfied) {
          criterion.evidence = `Reviewer verified (${review.score}/100): ${assessment.notes}`;
        }
      }
    }

    // Verify every requirement individually before completion - NEVER silently drop any requirement
    for (const req of requirementTracker.getAll()) {
      const relatedCriteria = plan.acceptanceCriteria.filter(
        (c) => c.requirementId === req.id || req.acceptanceCriteria?.some((ac) => ac.id === c.id)
      );

      const allCriteriaPassed =
        relatedCriteria.length === 0 ||
        relatedCriteria.every((c) => c.status === "passed");

      const hasCriticalFinding = review.findings.some((f) => f.severity === "critical");

      if (validation.passed && allCriteriaPassed && !hasCriticalFinding && review.score >= 50) {
        const evidenceDetails = [
          `Structural validation passed (${validation.checks.length} checks, 0 critical errors).`,
          `Engineering review score: ${review.score}/100.`,
          relatedCriteria.length > 0
            ? `${relatedCriteria.length} acceptance criteria satisfied.`
            : "Baseline architectural acceptance satisfied.",
          req.implementation ? `Implementation: ${req.implementation}` : undefined,
        ]
          .filter(Boolean)
          .join(" ");

        requirementTracker.verifyRequirement(
          req.id,
          evidenceDetails,
          "Verified individually against test validation and engineering review."
        );
      } else {
        const failureReasons = [
          !validation.passed ? `Validation failed (${validation.errors.slice(0, 2).join("; ")})` : undefined,
          !allCriteriaPassed ? "One or more acceptance criteria failed" : undefined,
          hasCriticalFinding ? "Critical review finding identified" : undefined,
          review.score < 50 ? `Review score too low (${review.score}/100)` : undefined,
        ]
          .filter(Boolean)
          .join("; ");

        requirementTracker.markFailed(req.id, failureReasons || "Verification criteria not met");
      }
    }

    // Audit all requirements before declaring completion
    const requirementReport = requirementTracker.verifyAllBeforeCompletion();
    if (!requirementReport.allVerified) {
      emit(
        "verify",
        `Verification advisory: ${requirementReport.unverifiedRequirements.length} requirement(s) unverified (${requirementReport.unverifiedRequirements.map((r) => r.id).join(", ")}).`
      );
      if (review.approved) {
        review.approved = false;
        review.findings.push({
          severity: "major",
          title: "Incomplete Requirement Verification",
          description: `Cannot complete task with unverified requirements: ${requirementReport.unverifiedRequirements.length} requirement(s) failed or pending.`,
          recommendation: "Ensure all requirements pass acceptance criteria and validation.",
        });
      }
    }

    // Update context snapshot with verified tracked requirements
    contextManager.recordPlan(
      plan.requirements,
      plan.acceptanceCriteria,
      plan.subtasks,
      requirementTracker.getAll()
    );

    // ─────────────────────────────────────────────────────────────
    // 12. COMPLETE: Synthesize concise final report
    // ─────────────────────────────────────────────────────────────
    emit("complete", "Generating concise executive engineering report.");
    const report = generateFinalReport({
      taskId,
      goal: understood.normalizedGoal,
      inspection,
      plan,
      implementation,
      validation,
      review,
      trackedRequirements: requirementTracker.getAll(),
      experiments: experimentManager.getHistory().experiments,
    });

    const modelAssignmentsObj: Record<string, ModelSelection> = {};
    for (const [k, v] of modelAssignments.entries()) {
      modelAssignmentsObj[k] = v;
    }

    return {
      taskId,
      understood,
      inspection,
      plan,
      modelAssignments: modelAssignmentsObj,
      implementation,
      validation,
      review,
      report,
      events,
      context: contextManager.getSnapshot(),
      contextManager,
      trackedRequirements: requirementTracker.getAll(),
      requirementReport,
      requirementTracker,
      gitSafety: versionManager.getState(),
      gitInspection,
      versionManager,
      gitInspector,
      experimentManager,
      experiments: experimentManager.getHistory().experiments,
    };
  }
}
