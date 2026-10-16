import { ICodebaseFileSystem } from "../codebase/file-system";
import { ReviewResult, ValidationResult } from "../types";
import { RegressionAnalyzer } from "./regression-analyzer";
import {
  ExperimentalChange,
  GitSafetyState,
  RegressionAnalysis,
  RepositoryCheckpoint,
  RollbackResult,
  VersionType,
} from "./types";

/**
 * Git Safety Version Manager.
 *
 * Manages repository lifecycle versions:
 * - BASELINE: Established before any changes are made.
 * - CURRENT_VERSION: Live state of the working tree.
 * - BEST_VERSION: Highest verified quality state (never destroyed).
 * - EXPERIMENT_VERSION: Transient, traceable checkpoint before risky modifications.
 *
 * Enforces the core safety loop:
 * REJECT CHANGE → ROLLBACK → ANALYZE → CREATE ALTERNATIVE → TEST AGAIN
 */
export class VersionManager {
  private baseline: RepositoryCheckpoint | null = null;
  private currentVersion: RepositoryCheckpoint | null = null;
  private bestVersion: RepositoryCheckpoint | null = null;
  private bestScore: number = -1;
  private checkpoints: RepositoryCheckpoint[] = [];
  private experiments: Map<string, ExperimentalChange> = new Map();
  private rollbacks: RollbackResult[] = [];
  private activeExperiment: ExperimentalChange | null = null;
  private analyzer: RegressionAnalyzer;
  private idCounter = 0;
  private protectedFiles: string[] = [];

  constructor(analyzer?: RegressionAnalyzer) {
    this.analyzer = analyzer ?? new RegressionAnalyzer();
  }

  /**
   * Sets the list of protected files detected from git status inspection.
   */
  public setProtectedFiles(files: string[]): void {
    this.protectedFiles = [...files];
  }

  /**
   * Gets the list of protected files.
   */
  public getProtectedFiles(): string[] {
    return [...this.protectedFiles];
  }

  /**
   * Establishes the initial repository baseline before any modifications.
   */
  public async establishBaseline(
    fileSystem: ICodebaseFileSystem,
    name: string = "Initial Working Tree Baseline"
  ): Promise<RepositoryCheckpoint> {
    const checkpoint = await this.snapshotRepository(fileSystem, "BASELINE", name);
    this.baseline = checkpoint;
    this.currentVersion = checkpoint;
    this.bestVersion = checkpoint;
    this.bestScore = 0;
    return checkpoint;
  }

  /**
   * Creates a snapshot checkpoint of the repository.
   */
  public async createCheckpoint(
    fileSystem: ICodebaseFileSystem,
    type: VersionType,
    name: string,
    metadata?: RepositoryCheckpoint["metadata"]
  ): Promise<RepositoryCheckpoint> {
    const checkpoint = await this.snapshotRepository(fileSystem, type, name, metadata);
    this.currentVersion = checkpoint;
    return checkpoint;
  }

  /**
   * Starts a traceable experimental change before risky modifications.
   */
  public async startExperiment(
    fileSystem: ICodebaseFileSystem,
    description: string,
    targetFiles: string[] = [],
    subtaskId?: string,
    customExperimentId?: string
  ): Promise<ExperimentalChange> {
    const expId = customExperimentId ?? `exp-${++this.idCounter}-${Date.now().toString(36)}`;
    const beforeCheckpoint = await this.snapshotRepository(
      fileSystem,
      "EXPERIMENT_VERSION",
      `Pre-Experiment: ${description}`,
      { experimentId: expId, subtaskId, touchedFiles: targetFiles }
    );

    const experiment: ExperimentalChange = {
      id: expId,
      description,
      subtaskId,
      status: "IN_PROGRESS",
      checkpointBeforeId: beforeCheckpoint.id,
      filesTouched: [...targetFiles],
      newFilesCreated: [],
      filesModified: [],
      filesDeleted: [],
      createdAt: Date.now(),
    };

    this.experiments.set(expId, experiment);
    this.activeExperiment = experiment;
    return experiment;
  }

  /**
   * Accepts an experiment that passed testing and review.
   * Promotes to BEST_VERSION if it achieves a higher or equal verified score.
   * NEVER destroys a previously verified best implementation.
   */
  public async acceptExperiment(
    fileSystem: ICodebaseFileSystem,
    experimentId: string,
    score: number = 100,
    metadata?: Record<string, unknown>
  ): Promise<RepositoryCheckpoint> {
    const exp = this.getExperimentOrThrow(experimentId);
    exp.status = "ACCEPTED";
    exp.completedAt = Date.now();
    exp.score = score;

    const afterCheckpoint = await this.snapshotRepository(
      fileSystem,
      "CURRENT_VERSION",
      `Accepted: ${exp.description}`,
      { experimentId, score, validationPassed: true, ...metadata }
    );
    exp.checkpointAfterId = afterCheckpoint.id;
    this.currentVersion = afterCheckpoint;

    // Only promote to BEST_VERSION if verified score is >= previous best
    if (score >= this.bestScore || !this.bestVersion) {
      this.bestVersion = {
        ...afterCheckpoint,
        type: "BEST_VERSION",
        name: `Best Verified: ${exp.description} (${score}/100)`,
      };
      this.bestScore = score;
    }

    if (this.activeExperiment?.id === experimentId) {
      this.activeExperiment = null;
    }

    return afterCheckpoint;
  }

  /**
   * Rejects an experiment and executes clean rollback.
   * Implements: REJECT CHANGE → ROLLBACK → ANALYZE → CREATE ALTERNATIVE → TEST AGAIN
   *
   * 1. Restores files from BEST_VERSION (or BASELINE).
   * 2. Cleans up all newly created failed experimental files.
   * 3. Leaves unrelated changes completely untouched.
   * 4. Never destroys previously verified best implementation.
   */
  public async rejectAndRollback(
    fileSystem: ICodebaseFileSystem,
    experimentId: string,
    reason: string,
    failureContext?: {
      validation?: ValidationResult;
      review?: ReviewResult;
      customError?: string;
    }
  ): Promise<RollbackResult> {
    const exp = this.getExperimentOrThrow(experimentId);
    exp.status = "REJECTED";
    exp.rejectionReason = reason;
    exp.completedAt = Date.now();

    // 1. Determine target checkpoint to restore (BEST_VERSION, falling back to BASELINE)
    const targetCheckpoint = this.bestVersion ?? this.baseline;
    if (!targetCheckpoint) {
      throw new Error("Cannot rollback: No baseline or best version checkpoint exists.");
    }

    // 2. Identify current files to detect what changed
    const currentFiles = await fileSystem.listFiles();
    const filesRestored: string[] = [];
    const filesCleanedUp: string[] = [];

    // Clean up files created during this experiment that didn't exist in target checkpoint
    for (const file of currentFiles) {
      const originalContent = targetCheckpoint.files.get(file.path);
      if (originalContent === undefined) {
        // File was newly created by the failed experiment - clean it up!
        await fileSystem.deleteFile(file.path);
        filesCleanedUp.push(file.path);
      } else if (originalContent !== file.content) {
        // File was modified by the failed experiment - restore to best verified version
        await fileSystem.writeFile(file.path, originalContent);
        filesRestored.push(file.path);
      }
    }

    // Restore any files that existed in target checkpoint but were deleted during experiment
    for (const [targetPath, targetContent] of targetCheckpoint.files.entries()) {
      const existsNow = await fileSystem.exists(targetPath);
      if (!existsNow) {
        await fileSystem.writeFile(targetPath, targetContent);
        filesRestored.push(targetPath);
      }
    }

    // 3. Analyze failure and formulate alternative strategy
    const analysis: RegressionAnalysis = this.analyzer.analyzeFailure({
      experimentDescription: exp.description,
      targetFiles: exp.filesTouched,
      validation: failureContext?.validation,
      review: failureContext?.review,
      previousBestScore: this.bestScore > 0 ? this.bestScore : undefined,
      customError: failureContext?.customError ?? reason,
    });

    exp.status = "ROLLED_BACK";
    exp.regressionAnalysis = analysis;

    const rollbackResult: RollbackResult = {
      success: true,
      experimentId,
      restoredVersion: targetCheckpoint.type,
      restoredCheckpointId: targetCheckpoint.id,
      filesRestored,
      filesCleanedUp,
      analysis,
      alternativeStrategy: analysis.proposedAlternative,
      timestamp: Date.now(),
    };

    this.rollbacks.push(rollbackResult);
    this.currentVersion = targetCheckpoint;

    if (this.activeExperiment?.id === experimentId) {
      this.activeExperiment = null;
    }

    return rollbackResult;
  }

  public getBaseline(): RepositoryCheckpoint | null {
    return this.baseline;
  }

  public getCurrentVersion(): RepositoryCheckpoint | null {
    return this.currentVersion;
  }

  public getBestVersion(): RepositoryCheckpoint | null {
    return this.bestVersion;
  }

  public getCheckpoints(): RepositoryCheckpoint[] {
    return [...this.checkpoints];
  }

  public getExperiments(): ExperimentalChange[] {
    return Array.from(this.experiments.values());
  }

  public getRollbacks(): RollbackResult[] {
    return [...this.rollbacks];
  }

  public getState(): GitSafetyState {
    return {
      baseline: this.baseline,
      currentVersion: this.currentVersion,
      bestVersion: this.bestVersion,
      activeExperiment: this.activeExperiment,
      checkpoints: this.getCheckpoints(),
      experiments: this.getExperiments(),
      rollbacks: this.getRollbacks(),
      protectedFiles: [...this.protectedFiles],
    };
  }

  private async snapshotRepository(
    fileSystem: ICodebaseFileSystem,
    type: VersionType,
    name: string,
    metadata?: RepositoryCheckpoint["metadata"]
  ): Promise<RepositoryCheckpoint> {
    const allFiles = await fileSystem.listFiles();
    const filesMap = new Map<string, string>();
    const fileList: string[] = [];

    for (const f of allFiles) {
      filesMap.set(f.path, f.content);
      fileList.push(f.path);
    }

    const checkpoint: RepositoryCheckpoint = {
      id: `chk-${++this.idCounter}-${Date.now().toString(36)}`,
      name,
      type,
      timestamp: Date.now(),
      files: filesMap,
      fileList,
      metadata,
    };

    this.checkpoints.push(checkpoint);
    return checkpoint;
  }

  private getExperimentOrThrow(id: string): ExperimentalChange {
    const exp = this.experiments.get(id);
    if (!exp) {
      throw new Error(`Experiment with ID '${id}' not found in VersionManager.`);
    }
    return exp;
  }
}
