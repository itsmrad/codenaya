import { AcceptanceCriterion, CodebaseInspection } from "../types";
import {
  RequirementStatus,
  RequirementVerificationReport,
  TrackedRequirement,
} from "./types";
import {
  createTrackedRequirementsFromPrompt,
  generateTaskAcceptanceCriteria,
} from "./generator";

/**
 * Requirement-Tracking System.
 *
 * Every user requirement is converted into a tracked requirement maintaining:
 * - REQUIREMENT_ID
 * - DESCRIPTION
 * - STATUS (PENDING, IN_PROGRESS, IMPLEMENTED, VERIFIED, FAILED, BLOCKED)
 * - IMPLEMENTATION
 * - VERIFICATION
 * - EVIDENCE
 *
 * Before declaring a task complete, verifies every requirement individually.
 * Guarantees that the orchestrator NEVER silently drops a requirement.
 */
export class RequirementTracker {
  private requirements: Map<string, TrackedRequirement> = new Map();
  private idCounter = 0;

  constructor(initialRequirements?: TrackedRequirement[]) {
    if (initialRequirements) {
      initialRequirements.forEach((req) => {
        this.requirements.set(req.id, { ...req });
        const num = parseInt(req.id.replace(/\D/g, ""), 10);
        if (!isNaN(num) && num > this.idCounter) {
          this.idCounter = num;
        }
      });
    }
  }

  /**
   * Initializes the tracker from a raw user prompt.
   * Converts EVERY extracted user requirement into a TrackedRequirement.
   */
  public initializeFromPrompt(
    prompt: string,
    inspection?: CodebaseInspection
  ): TrackedRequirement[] {
    const list = createTrackedRequirementsFromPrompt(prompt, inspection);
    this.requirements.clear();
    this.idCounter = 0;

    for (const req of list) {
      this.requirements.set(req.id, req);
      const num = parseInt(req.id.replace(/\D/g, ""), 10);
      if (!isNaN(num) && num > this.idCounter) {
        this.idCounter = num;
      }
    }

    return this.getAll();
  }

  /**
   * Adds an explicit requirement.
   */
  public addRequirement(
    description: string,
    options?: {
      id?: string;
      acceptanceCriteria?: AcceptanceCriterion[];
      inspection?: CodebaseInspection;
      source?: string;
    }
  ): TrackedRequirement {
    const id = options?.id ?? `req-${++this.idCounter}`;
    const acceptanceCriteria =
      options?.acceptanceCriteria ??
      generateTaskAcceptanceCriteria(id, description, options?.inspection);

    const now = Date.now();
    const req: TrackedRequirement = {
      id,
      description,
      status: "PENDING",
      implementation: "Pending implementation",
      verification: "Pending verification",
      evidence: "",
      acceptanceCriteria,
      source: options?.source ?? "explicit",
      createdAt: now,
      updatedAt: now,
    };

    this.requirements.set(id, req);
    return req;
  }

  /**
   * Updates requirement lifecycle status.
   */
  public updateStatus(
    id: string,
    status: RequirementStatus,
    notes?: string
  ): TrackedRequirement {
    const req = this.getRequirementOrThrow(id);
    req.status = status;
    req.updatedAt = Date.now();

    if (notes) {
      req.implementation = req.implementation === "Pending implementation" ? notes : `${req.implementation}. ${notes}`;
    }

    return req;
  }

  /**
   * Marks a requirement as IN_PROGRESS.
   */
  public markInProgress(id: string, notes?: string): TrackedRequirement {
    return this.updateStatus(id, "IN_PROGRESS", notes);
  }

  /**
   * Marks a requirement as IMPLEMENTED with implementation details.
   */
  public markImplemented(
    id: string,
    implementationDetails?: string,
    filesTouched?: string[]
  ): TrackedRequirement {
    const req = this.getRequirementOrThrow(id);
    req.status = "IMPLEMENTED";
    if (implementationDetails) {
      let text = implementationDetails;
      if (filesTouched && filesTouched.length > 0) {
        text += ` (Files: ${filesTouched.join(", ")})`;
      }
      req.implementation = text;
    }
    req.updatedAt = Date.now();
    return req;
  }

  /**
   * Records implementation progress and touched files for a requirement.
   */
  public recordImplementation(
    id: string,
    implementationDetails: string,
    filesTouched?: string[]
  ): TrackedRequirement {
    const req = this.getRequirementOrThrow(id);
    req.status = req.status === "PENDING" ? "IN_PROGRESS" : req.status;

    let text = implementationDetails;
    if (filesTouched && filesTouched.length > 0) {
      text += ` (Files: ${filesTouched.join(", ")})`;
    }

    req.implementation = text;
    req.updatedAt = Date.now();
    return req;
  }

  /**
   * Records verification strategy and concrete empirical evidence.
   */
  public recordVerification(
    id: string,
    verificationMethod: string,
    evidence: string
  ): TrackedRequirement {
    const req = this.getRequirementOrThrow(id);

    if (!evidence || evidence.trim().length === 0) {
      throw new Error(`Cannot record VERIFICATION on requirement '${id}' without verifiable empirical evidence.`);
    }

    req.verification = verificationMethod;
    req.evidence = evidence;
    req.updatedAt = Date.now();

    return req;
  }

  /**
   * Individually marks a requirement as VERIFIED with empirical evidence.
   * Throws if evidence is missing to prevent silent promotion.
   */
  public verifyRequirement(
    id: string,
    evidence: string,
    notes?: string
  ): TrackedRequirement {
    const req = this.getRequirementOrThrow(id);

    if (!evidence || evidence.trim().length === 0) {
      throw new Error(
        `Cannot mark requirement '${id}' as VERIFIED without verifiable evidence: "${req.description}"`
      );
    }

    req.status = "VERIFIED";
    req.evidence = evidence;
    req.verifiedAt = Date.now();
    req.updatedAt = Date.now();

    if (notes) {
      req.verification = notes;
    } else if (req.verification === "Pending verification") {
      req.verification = "Validated against acceptance criteria suite and test executions.";
    }

    // Mark all child acceptance criteria as passed
    req.acceptanceCriteria.forEach((crit) => {
      crit.status = "passed";
      if (!crit.details) {
        crit.details = `Satisfied with verified evidence: ${evidence.slice(0, 100)}`;
      }
    });

    return req;
  }

  /**
   * Marks a requirement as BLOCKED with a blocker reason.
   */
  public markBlocked(id: string, reason: string): TrackedRequirement {
    const req = this.getRequirementOrThrow(id);
    req.status = "BLOCKED";
    req.verification = `Blocked: ${reason}`;
    req.updatedAt = Date.now();
    return req;
  }

  /**
   * Marks a requirement as FAILED with failure details.
   */
  public markFailed(id: string, reason: string, evidence?: string): TrackedRequirement {
    const req = this.getRequirementOrThrow(id);
    req.status = "FAILED";
    req.verification = `Failed: ${reason}`;
    if (evidence) {
      req.evidence = evidence;
    }
    req.updatedAt = Date.now();
    return req;
  }

  /**
   * Before declaring a task complete, verify every requirement individually.
   * The orchestrator must never silently drop a requirement!
   */
  public verifyAllBeforeCompletion(): RequirementVerificationReport {
    const all = this.getAll();
    const totalCount = all.length;

    let verifiedCount = 0;
    let pendingCount = 0;
    let inProgressCount = 0;
    let implementedCount = 0;
    let failedCount = 0;
    let blockedCount = 0;

    const unverified: TrackedRequirement[] = [];

    for (const req of all) {
      switch (req.status) {
        case "VERIFIED":
          // Must have evidence to be considered legitimately verified
          if (req.evidence && req.evidence.trim().length > 0) {
            verifiedCount++;
          } else {
            // Unproven status promotion caught
            req.status = "IMPLEMENTED";
            unverified.push(req);
            implementedCount++;
          }
          break;
        case "PENDING":
          pendingCount++;
          unverified.push(req);
          break;
        case "IN_PROGRESS":
          inProgressCount++;
          unverified.push(req);
          break;
        case "IMPLEMENTED":
          implementedCount++;
          unverified.push(req);
          break;
        case "FAILED":
          failedCount++;
          unverified.push(req);
          break;
        case "BLOCKED":
          blockedCount++;
          unverified.push(req);
          break;
      }
    }

    const allVerified = verifiedCount === totalCount && totalCount > 0;

    let summary = `Requirement Verification Audit: ${verifiedCount}/${totalCount} verified.`;
    if (!allVerified) {
      summary += ` Unverified requirements: ${unverified.map((u) => `[${u.id}: ${u.status}]`).join(", ")}.`;
    }

    return {
      allVerified,
      totalCount,
      verifiedCount,
      pendingCount,
      inProgressCount,
      implementedCount,
      failedCount,
      blockedCount,
      unverifiedRequirements: unverified,
      summary,
    };
  }

  /**
   * Aggregates all acceptance criteria across all tracked requirements.
   * Directly feeds into testing, validation, and review systems.
   */
  public getAllAcceptanceCriteria(): AcceptanceCriterion[] {
    const list: AcceptanceCriterion[] = [];
    for (const req of this.requirements.values()) {
      list.push(...req.acceptanceCriteria);
    }
    return list;
  }

  public getAll(): TrackedRequirement[] {
    return Array.from(this.requirements.values());
  }

  public getRequirement(id: string): TrackedRequirement | undefined {
    return this.requirements.get(id);
  }

  private getRequirementOrThrow(id: string): TrackedRequirement {
    const req = this.requirements.get(id);
    if (!req) {
      throw new Error(`Requirement with id '${id}' not found in tracker.`);
    }
    return req;
  }

  /**
   * Returns a markdown table representation of the requirements.
   */
  public toMarkdownTable(): string {
    const lines: string[] = [
      "| REQUIREMENT_ID | DESCRIPTION | STATUS | IMPLEMENTATION | VERIFICATION | EVIDENCE |",
      "| --- | --- | --- | --- | --- | --- |",
    ];

    for (const req of this.requirements.values()) {
      const impl = req.implementation.replace(/\|/g, "\\|").slice(0, 50);
      const ver = req.verification.replace(/\|/g, "\\|").slice(0, 50);
      const ev = req.evidence ? req.evidence.replace(/\|/g, "\\|").slice(0, 50) : "None";
      lines.push(
        `| ${req.id} | ${req.description.replace(/\|/g, "\\|")} | ${req.status} | ${impl} | ${ver} | ${ev} |`
      );
    }

    return lines.join("\n");
  }

  public toSummaryString(): string {
    const report = this.verifyAllBeforeCompletion();
    return `Requirements Status: ${report.summary}\n\n${this.toMarkdownTable()}`;
  }
}
