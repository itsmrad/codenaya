export type VersionType =
  | "BASELINE"
  | "CURRENT_VERSION"
  | "BEST_VERSION"
  | "EXPERIMENT_VERSION";

export type ExperimentStatus =
  | "PENDING"
  | "IN_PROGRESS"
  | "ACCEPTED"
  | "REJECTED"
  | "ROLLED_BACK";

/**
 * Status of an individual file in git inspection.
 */
export interface GitFileStatus {
  path: string;
  status: "modified" | "untracked" | "staged" | "deleted" | "renamed" | "added" | "clean";
  isUserWork: boolean;
  diffSummary?: string;
}

/**
 * Git inspection report generated before modifying the repository.
 */
export interface GitInspectionReport {
  branch?: string;
  isClean: boolean;
  existingUserChanges: GitFileStatus[];
  protectedFiles: string[];
  untrackedUserFiles: string[];
  summary: string;
  inspectedAt: number;
}

/**
 * Repository snapshot checkpoint.
 */
export interface RepositoryCheckpoint {
  id: string;
  name: string;
  type: VersionType;
  timestamp: number;
  files: Map<string, string>; // path -> content
  fileList: string[];
  metadata?: {
    experimentId?: string;
    subtaskId?: string;
    score?: number;
    description?: string;
    validationPassed?: boolean;
    touchedFiles?: string[];
  };
}

/**
 * Detailed regression analysis generated when an experiment fails or regresses.
 */
export interface RegressionAnalysis {
  detectedAt: number;
  failureType:
    | "syntax"
    | "validation"
    | "criteria-failure"
    | "score-drop"
    | "unauthorized-file-access"
    | "boundary-violation";
  rootCause: string;
  regressedFiles: string[];
  impactScore?: number;
  proposedAlternative: string;
  nextSteps: string[];
}

/**
 * Every experimental change is tracked and traceable.
 */
export interface ExperimentalChange {
  id: string;
  description: string;
  subtaskId?: string;
  status: ExperimentStatus;
  checkpointBeforeId: string;
  checkpointAfterId?: string;
  filesTouched: string[];
  newFilesCreated: string[];
  filesModified: string[];
  filesDeleted: string[];
  createdAt: number;
  completedAt?: number;
  rejectionReason?: string;
  regressionAnalysis?: RegressionAnalysis;
  score?: number;
}

/**
 * Result of rolling back a failed or regressed change.
 */
export interface RollbackResult {
  success: boolean;
  experimentId: string;
  restoredVersion: VersionType;
  restoredCheckpointId: string;
  filesRestored: string[];
  filesCleanedUp: string[];
  analysis: RegressionAnalysis;
  alternativeStrategy: string;
  timestamp: number;
}

/**
 * Complete Git safety state maintained by the orchestrator.
 */
export interface GitSafetyState {
  baseline: RepositoryCheckpoint | null;
  currentVersion: RepositoryCheckpoint | null;
  bestVersion: RepositoryCheckpoint | null;
  activeExperiment: ExperimentalChange | null;
  checkpoints: RepositoryCheckpoint[];
  experiments: ExperimentalChange[];
  rollbacks: RollbackResult[];
  protectedFiles: string[];
}
