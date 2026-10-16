import {
  AcceptanceCriterion,
  ValidationCheck,
} from "../types";
import { TrackedRequirement } from "../requirements/types";
import { GitSafetyState } from "../safety/types";

/**
 * Epistemic truth categories.
 * Strict boundary enforced: assumptions can NEVER silently become facts.
 */
export type EpistemicType =
  | "FACT"
  | "ASSUMPTION"
  | "DECISION"
  | "OPEN_QUESTION"
  | "VERIFIED_RESULT";

export interface EpistemicEntry {
  id: string;
  type: EpistemicType;
  statement: string;
  source: string;
  createdAt: number;
  /** Present only when verified by ground truth evidence */
  evidence?: string;
  verifiedAt?: number;
}

export interface TechStackContext {
  framework: string;
  styling: string;
  language: string;
  keyDependencies: Record<string, string>;
}

export interface CurrentTaskContext {
  prompt: string;
  goal: string;
  domain: string;
  estimatedComplexity: string;
}

export interface CurrentImplementationContext {
  filesCreated: string[];
  filesModified: string[];
  filesDeleted: string[];
  lastModifiedTimestamp?: number;
}

export interface BestResultSnapshot {
  score: number;
  summary: string;
  timestamp: number;
  filesTouched: string[];
}

/**
 * Full task and project context tracking state.
 */
export interface TaskContextSnapshot {
  projectContext: string;
  techStack: TechStackContext;
  architecture: string;
  importantFiles: string[];
  existingPatterns: string[];
  conventions: string[];
  currentTask: CurrentTaskContext;
  requirements: string[];
  trackedRequirements?: TrackedRequirement[];
  acceptanceCriteria: AcceptanceCriterion[];
  decisions: string[];
  knownIssues: string[];
  activeSubtasks: string[];
  completedSubtasks: string[];
  testResults: ValidationCheck[];
  currentImplementation: CurrentImplementationContext;
  bestResult?: BestResultSnapshot;
  gitSafety?: GitSafetyState;
  epistemicLog: EpistemicEntry[];
}
