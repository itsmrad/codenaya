/**
 * Task complexity tier, used to determine planning depth and model selection.
 */
export type TaskComplexity = "low" | "medium" | "high" | "critical";

/**
 * Model capability tier for dynamic model selection.
 */
export type ModelTier = "fast" | "standard" | "advanced" | "reasoning";

/**
 * Supported specialized subagent roles in the engineering lead's team.
 */
export type SubagentRole =
  | "explorer"
  | "architect"
  | "frontend-engineer"
  | "backend-engineer"
  | "database-engineer"
  | "debugger"
  | "tester"
  | "security-reviewer"
  | "performance-reviewer"
  | "ux-reviewer"
  | "code-reviewer"
  // Legacy aliases
  | "implementer"
  | "reviewer";

/**
 * Task lifecycle state machine:
 * PENDING → BLOCKED (waiting) → RUNNING → COMPLETED → ACCEPTED | REJECTED | FAILED
 */
export type SubtaskStatus =
  | "PENDING"
  | "RUNNING"
  | "COMPLETED"
  | "FAILED"
  | "BLOCKED"
  | "REJECTED"
  | "ACCEPTED";

/**
 * Scheduling mode for subtasks.
 */
export type ExecutionMode = "sequential" | "parallel";

/**
 * Stages in the autonomous orchestrator workflow:
 * Understand → Inspect → Plan → Select Models → Delegate → Implement → Test → Review → Evaluate → Improve → Verify → Complete
 */
export type WorkflowStage =
  | "understand"
  | "inspect"
  | "plan"
  | "select-models"
  | "delegate"
  | "implement"
  | "test"
  | "review"
  | "evaluate"
  | "improve"
  | "verify"
  | "complete";

/**
 * File representation within the project's virtual or Convex filesystem.
 */
export interface ProjectFile {
  id?: string;
  path: string;
  name: string;
  content: string;
  parentId?: string | null;
  type: "file" | "folder";
  updatedAt?: number;
}

/**
 * Analysis of the existing codebase.
 */
export interface CodebaseInspection {
  framework: "nextjs" | "vite" | "unknown";
  styling: "tailwind" | "css-modules" | "plain-css" | "shadcn" | "unknown";
  hasTypeScript: boolean;
  packageDependencies: Record<string, string>;
  keyDirectories: string[];
  existingFiles: string[];
  patterns: string[];
  entryPoints: string[];
  summary?: string;
}

/**
 * Individual acceptance criterion for the task.
 */
export interface AcceptanceCriterion {
  id: string;
  requirementId?: string;
  description: string;
  required: boolean;
  verificationMethod: "unit-test" | "structural-check" | "static-analysis" | "visual-inspection";
  status: "pending" | "passed" | "failed";
  evidence?: string;
  details?: string;
  targetFile?: string;
}

/**
 * Individual subtask within the implementation plan.
 */
export interface Subtask {
  id: string;
  title: string;
  description: string;
  role: SubagentRole;
  complexity?: TaskComplexity;
  recommendedModelTier?: ModelTier;
  selectedModel?: string;
  executionMode?: ExecutionMode;
  /** IDs of subtasks that must complete before this subtask can start */
  dependencies: string[];
  targetFiles: string[];
  allowedFiles?: string[];
  objective?: string;
  constraints?: string[];
  expectedOutput?: string;
  relevantContext?: string;
  acceptanceCriteria?: AcceptanceCriterion[] | string[];
  rejectionReason?: string;
  status: SubtaskStatus;
  result?: {
    filesModified: string[];
    filesCreated: string[];
    filesDeleted: string[];
    summary: string;
    error?: string;
  };
}

/**
 * Structured engineering plan.
 */
export interface ImplementationPlan {
  goal: string;
  requirements: string[];
  trackedRequirements?: import("./requirements/types").TrackedRequirement[];
  acceptanceCriteria: AcceptanceCriterion[];
  subtasks: Subtask[];
  estimatedComplexity: TaskComplexity;
  architecturalNotes: string[];
}

/**
 * Selected model configuration.
 */
export interface ModelSelection {
  task?: SubagentRole | string;
  provider: "openai" | "anthropic" | "google" | "vertex" | "mock";
  modelId: string;
  tier: ModelTier;
  reason: string;
  expectedOutput?: string;
  confidence?: number;
}

/**
 * Execution result of subtask implementation.
 */
export interface ImplementationResult {
  completedSubtasks: Subtask[];
  filesCreated: string[];
  filesModified: string[];
  filesDeleted: string[];
  success: boolean;
  errors: string[];
  rejections: string[];
}

/**
 * Test & validation check result.
 */
export interface ValidationCheck {
  name: string;
  type: "syntax" | "imports" | "exports" | "schema" | "dependencies" | "acceptance";
  status: "passed" | "failed" | "warning";
  message: string;
  filePath?: string;
}

export interface ValidationResult {
  passed: boolean;
  checks: ValidationCheck[];
  errors: string[];
  warnings: string[];
}

/**
 * Senior review finding.
 */
export interface ReviewFinding {
  severity: "critical" | "major" | "minor" | "suggestion";
  title: string;
  description: string;
  filePath?: string;
  lineRange?: string;
  recommendation?: string;
}

/**
 * Senior engineering lead review assessment.
 */
export interface ReviewResult {
  approved: boolean;
  score: number; // 0 - 100
  criteriaAssessments: {
    criterionId: string;
    satisfied: boolean;
    notes: string;
  }[];
  findings: ReviewFinding[];
  improvementOpportunities?: string[];
  summary: string;
}

/**
 * Concise final executive report returned upon task completion.
 */
export interface FinalReport {
  taskId: string;
  headline: string;
  executiveSummary: string;
  architecturalDecisions: string[];
  filesCreated: string[];
  filesModified: string[];
  filesDeleted: string[];
  acceptanceCriteriaStatus: {
    total: number;
    passed: number;
    failed: number;
  };
  validationSummary: {
    passed: boolean;
    checksCount: number;
    warningsCount: number;
  };
  reviewVerdict: {
    approved: boolean;
    score: number;
    findingsCount: number;
  };
  requirementsStatus?: {
    total: number;
    verified: number;
    pending: number;
    failed: number;
    blocked: number;
    allVerified: boolean;
  };
  experimentsStatus?: {
    total: number;
    accepted: number;
    rejected: number;
    abandoned: number;
    bestScore?: number;
  };
  improvementOpportunities: string[];
  toRun?: {
    install?: string;
    dev?: string;
    test?: string;
  };
}

/**
 * Event emitted during orchestrator execution.
 */
export interface OrchestratorEvent {
  stage: WorkflowStage;
  message: string;
  timestamp: number;
  data?: Record<string, unknown>;
}

export type OrchestratorEventListener = (event: OrchestratorEvent) => void;

/**
 * Configuration options for orchestrator execution.
 */
export interface OrchestratorOptions {
  taskId?: string;
  preferredModelTier?: ModelTier;
  dryRun?: boolean;
  maxParallelSubtasks?: number;
  onEvent?: OrchestratorEventListener;
  /** Allow custom model resolver (useful for testing or specific environment overrides) */
  customModelResolver?: (tier: ModelTier, role: SubagentRole) => ModelSelection;
  /** Optional pre-existing or custom context manager */
  contextManager?: unknown;
  /** Optional pre-existing or custom requirement tracker */
  requirementTracker?: unknown;
  /** Git status porcelain string or mock provider for inspecting pre-existing user work */
  gitStatusOutput?: string;
  gitStatusProvider?: () => Promise<string> | string;
  /** Explicit list of user files authorized for modification */
  authorizedUserFiles?: string[];
  /** Optional custom Git status inspector */
  gitInspector?: unknown;
  /** Optional custom VersionManager */
  versionManager?: unknown;
  /** Optional custom ExperimentManager */
  experimentManager?: unknown;
  /** Run optimization experiments during improve stage */
  runOptimizationExperiments?: boolean;
}
