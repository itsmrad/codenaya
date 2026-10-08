import { AcceptanceCriterion } from "../types";

/**
 * Lifecycle status of an individual requirement:
 * PENDING → IN_PROGRESS → IMPLEMENTED → VERIFIED (or FAILED / BLOCKED)
 */
export type RequirementStatus =
  | "PENDING"
  | "IN_PROGRESS"
  | "IMPLEMENTED"
  | "VERIFIED"
  | "FAILED"
  | "BLOCKED";

/**
 * Fully tracked engineering requirement.
 *
 * Enforces the required contract:
 * REQUIREMENT_ID
 * DESCRIPTION
 * STATUS
 * IMPLEMENTATION
 * VERIFICATION
 * EVIDENCE
 */
export interface TrackedRequirement {
  /** REQUIREMENT_ID: Unique identifier (e.g., 'req-1', 'req-onboarding') */
  id: string;

  /** DESCRIPTION: Clear functional statement of what must be achieved */
  description: string;

  /** STATUS: Current lifecycle state */
  status: RequirementStatus;

  /** IMPLEMENTATION: Files, components, or routines where the requirement is realized */
  implementation: string;

  /** VERIFICATION: Method, test, or check verifying satisfaction */
  verification: string;

  /** EVIDENCE: Verifiable empirical proof, test run output, or structural assertion */
  evidence: string;

  /** Task-specific acceptance criteria derived for this requirement */
  acceptanceCriteria: AcceptanceCriterion[];

  /** Subtasks assigned to fulfill this requirement */
  subtaskIds?: string[];

  /** Source or origin of this requirement */
  source?: string;

  /** Timestamps */
  createdAt: number;
  updatedAt: number;
  verifiedAt?: number;
}

/**
 * Verification audit report before declaring a task complete.
 * The orchestrator must never silently drop a requirement!
 */
export interface RequirementVerificationReport {
  allVerified: boolean;
  totalCount: number;
  verifiedCount: number;
  pendingCount: number;
  inProgressCount: number;
  implementedCount: number;
  failedCount: number;
  blockedCount: number;
  unverifiedRequirements: TrackedRequirement[];
  summary: string;
}
