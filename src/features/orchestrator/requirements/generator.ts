import { AcceptanceCriterion, CodebaseInspection } from "../types";
import { TrackedRequirement } from "./types";

/**
 * Generates task-specific acceptance criteria tailored to a specific requirement.
 *
 * Implements the concrete requirement-to-acceptance mapping:
 * - Detects domain (auth, onboarding, data, UI, routing, logic)
 * - Derives 4-6 granular, verifiable criteria
 * - Covers state detection, flow execution, persistence, post-action redirect, refresh resilience, and non-regression.
 */
export function generateTaskAcceptanceCriteria(
  reqId: string,
  description: string,
  inspection?: CodebaseInspection
): AcceptanceCriterion[] {
  const lower = description.toLowerCase();
  const criteria: AcceptanceCriterion[] = [];
  let critCounter = 0;

  const nextId = () => `${reqId}-ac-${++critCounter}`;

  // 1. Onboarding Flow
  if (lower.includes("onboard") || (lower.includes("new user") && lower.includes("see"))) {
    criteria.push(
      {
        id: nextId(),
        requirementId: reqId,
        description: "New authenticated user is detected.",
        required: true,
        verificationMethod: "unit-test",
        status: "pending",
      },
      {
        id: nextId(),
        requirementId: reqId,
        description: "User is redirected to onboarding.",
        required: true,
        verificationMethod: "structural-check",
        status: "pending",
      },
      {
        id: nextId(),
        requirementId: reqId,
        description: "Completed onboarding is persisted.",
        required: true,
        verificationMethod: "unit-test",
        status: "pending",
      },
      {
        id: nextId(),
        requirementId: reqId,
        description: "Completed users are redirected to the dashboard.",
        required: true,
        verificationMethod: "structural-check",
        status: "pending",
      },
      {
        id: nextId(),
        requirementId: reqId,
        description: "Refresh does not lose progress.",
        required: true,
        verificationMethod: "structural-check",
        status: "pending",
      },
      {
        id: nextId(),
        requirementId: reqId,
        description: "Existing functionality remains intact.",
        required: true,
        verificationMethod: "static-analysis",
        status: "pending",
      }
    );
    return criteria;
  }

  // 2. Bug Fix / Defect Repair
  if (/\b(fix|bug|defect|error|crash|leak|issue|failing)\b/i.test(lower)) {
    criteria.push(
      {
        id: nextId(),
        requirementId: reqId,
        description: "Defect condition is isolated and verified by targeted reproduction check.",
        required: true,
        verificationMethod: "unit-test",
        status: "pending",
      },
      {
        id: nextId(),
        requirementId: reqId,
        description: "Surgical remediation patch corrects root cause without side effects.",
        required: true,
        verificationMethod: "structural-check",
        status: "pending",
      },
      {
        id: nextId(),
        requirementId: reqId,
        description: "Error boundary or fallback prevents application crashes on invalid inputs.",
        required: true,
        verificationMethod: "structural-check",
        status: "pending",
      },
      {
        id: nextId(),
        requirementId: reqId,
        description: "Existing functional workflows and surrounding code remain intact.",
        required: true,
        verificationMethod: "static-analysis",
        status: "pending",
      }
    );
    return criteria;
  }

  // 3. Authentication & Authorization
  if (/\b(auth|login|signup|clerk|session|token|permission)\b/i.test(lower)) {
    criteria.push(
      {
        id: nextId(),
        requirementId: reqId,
        description: "Authentication state and credential inputs are validated.",
        required: true,
        verificationMethod: "unit-test",
        status: "pending",
      },
      {
        id: nextId(),
        requirementId: reqId,
        description: "Session identity and tokens are securely established and persisted.",
        required: true,
        verificationMethod: "structural-check",
        status: "pending",
      },
      {
        id: nextId(),
        requirementId: reqId,
        description: "Protected route guards redirect unauthorized requests to login.",
        required: true,
        verificationMethod: "structural-check",
        status: "pending",
      },
      {
        id: nextId(),
        requirementId: reqId,
        description: "Session state persists seamlessly across browser reloads.",
        required: true,
        verificationMethod: "structural-check",
        status: "pending",
      },
      {
        id: nextId(),
        requirementId: reqId,
        description: "Existing public routes and application features remain intact without regressions.",
        required: true,
        verificationMethod: "static-analysis",
        status: "pending",
      }
    );
    return criteria;
  }

  // 4. Database & Schema
  if (/\b(database|schema|table|convex|query|mutation|migration|sql)\b/i.test(lower)) {
    criteria.push(
      {
        id: nextId(),
        requirementId: reqId,
        description: "Database schema definition declares required fields, types, and indexes.",
        required: true,
        verificationMethod: "static-analysis",
        status: "pending",
      },
      {
        id: nextId(),
        requirementId: reqId,
        description: "Mutations validate input arguments and ensure data integrity.",
        required: true,
        verificationMethod: "unit-test",
        status: "pending",
      },
      {
        id: nextId(),
        requirementId: reqId,
        description: "Queries return expected records with reactive real-time subscription support.",
        required: true,
        verificationMethod: "structural-check",
        status: "pending",
      },
      {
        id: nextId(),
        requirementId: reqId,
        description: "Schema updates preserve backward compatibility with existing stored records.",
        required: true,
        verificationMethod: "static-analysis",
        status: "pending",
      },
      {
        id: nextId(),
        requirementId: reqId,
        description: "Existing database tables, queries, and mutations remain intact.",
        required: true,
        verificationMethod: "static-analysis",
        status: "pending",
      }
    );
    return criteria;
  }

  // 5. UI Component / Frontend Feature
  if (/\b(ui|component|modal|button|page|view|card|navbar|sidebar|form)\b/i.test(lower)) {
    const stylingEngine = inspection?.styling ?? "tailwind";
    criteria.push(
      {
        id: nextId(),
        requirementId: reqId,
        description: `Component renders accurately following ${stylingEngine} design patterns.`,
        required: true,
        verificationMethod: "structural-check",
        status: "pending",
      },
      {
        id: nextId(),
        requirementId: reqId,
        description: "Interactive controls handle user events, clicks, and inputs predictably.",
        required: true,
        verificationMethod: "unit-test",
        status: "pending",
      },
      {
        id: nextId(),
        requirementId: reqId,
        description: "Component handles loading, empty, and error boundary states gracefully.",
        required: true,
        verificationMethod: "structural-check",
        status: "pending",
      },
      {
        id: nextId(),
        requirementId: reqId,
        description: "Accessibility standards (keyboard navigation and semantic tags) are preserved.",
        required: true,
        verificationMethod: "structural-check",
        status: "pending",
      },
      {
        id: nextId(),
        requirementId: reqId,
        description: "Existing layout components and global styles remain intact without regressions.",
        required: true,
        verificationMethod: "static-analysis",
        status: "pending",
      }
    );
    return criteria;
  }

  // 6. Generic Software Engineering Requirement
  criteria.push(
    {
      id: nextId(),
      requirementId: reqId,
      description: `Core functionality for "${description}" is implemented and operational.`,
      required: true,
      verificationMethod: "structural-check",
      status: "pending",
    },
    {
      id: nextId(),
      requirementId: reqId,
      description: "State modifications and parameters are validated and persisted correctly.",
      required: true,
      verificationMethod: "unit-test",
      status: "pending",
    },
    {
      id: nextId(),
      requirementId: reqId,
      description: "Edge cases and error conditions are handled cleanly without unhandled exceptions.",
      required: true,
      verificationMethod: "structural-check",
      status: "pending",
    },
    {
      id: nextId(),
      requirementId: reqId,
      description: "No syntax errors, unresolved relative imports, or malformed configurations.",
      required: true,
      verificationMethod: "static-analysis",
      status: "pending",
    },
    {
      id: nextId(),
      requirementId: reqId,
      description: "Existing codebase architecture and patterns remain intact without regressions.",
      required: true,
      verificationMethod: "static-analysis",
      status: "pending",
    }
  );

  return criteria;
}

/**
 * Extracts discrete requirement strings from a user prompt.
 * Ensures NO requirement is silently dropped!
 */
export function extractRequirementStringsFromPrompt(prompt: string): string[] {
  const trimmed = prompt.trim();
  if (!trimmed) return [];

  const rawLines = trimmed.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const requirements: string[] = [];

  for (const line of rawLines) {
    // Check if line is a numbered list item: "1. Do X" or "1) Do X"
    const numberedMatch = line.match(/^(\d+[\.\)]\s*)(.+)/);
    if (numberedMatch) {
      requirements.push(numberedMatch[2].trim());
      continue;
    }

    // Check if line is a bullet item: "- Do X" or "* Do X"
    const bulletMatch = line.match(/^([*\-•]\s*)(.+)/);
    if (bulletMatch) {
      requirements.push(bulletMatch[2].trim());
      continue;
    }

    // Check if line has multiple sentences or semicolon-separated clauses
    const sentences = line.split(/(?<=[.?!;])\s+(?=[A-Z0-9])/).map((s) => s.trim()).filter((s) => s.length > 5);
    if (sentences.length > 1) {
      for (const sentence of sentences) {
        requirements.push(sentence.replace(/[.;]$/, "").trim());
      }
    } else {
      // Check for compound action clauses separated by commas / 'and':
      // e.g. "Allow users to invite teammates by email, send invitation notifications, and track acceptance status."
      const clauses = line
        .split(/,\s+(?:and\s+)?|\s+and\s+(?=[a-z]+(?:ing\b|\b))/i)
        .map((c) => c.trim())
        .filter((c) => c.length > 10);

      if (
        clauses.length >= 2 &&
        clauses.some((c) =>
          /\b(allow|invite|send|track|create|add|update|delete|verify|check|display|show|ensure|prevent)\b/i.test(
            c
          )
        )
      ) {
        for (const clause of clauses) {
          requirements.push(clause.replace(/[.;]$/, "").trim());
        }
      } else {
        requirements.push(line.replace(/[.;]$/, "").trim());
      }
    }
  }

  // Deduplicate and filter out trivial fragments
  const cleaned: string[] = [];
  const seen = new Set<string>();

  for (const req of requirements) {
    const norm = req.toLowerCase().replace(/[^a-z0-9]/g, "");
    if (norm.length >= 4 && !seen.has(norm)) {
      seen.add(norm);
      cleaned.push(req);
    }
  }

  // If extraction yielded nothing or only 1 item from a prompt with compound clauses, fallback to full prompt
  if (cleaned.length === 0) {
    cleaned.push(trimmed);
  }

  return cleaned;
}

/**
 * Converts a raw prompt into a complete set of TrackedRequirements,
 * ensuring every requirement is tracked and accompanied by task-specific acceptance criteria.
 */
export function createTrackedRequirementsFromPrompt(
  prompt: string,
  inspection?: CodebaseInspection
): TrackedRequirement[] {
  const reqStrings = extractRequirementStringsFromPrompt(prompt);
  const now = Date.now();

  const tracked: TrackedRequirement[] = reqStrings.map((desc, idx) => {
    const id = `req-${idx + 1}`;
    const acceptanceCriteria = generateTaskAcceptanceCriteria(id, desc, inspection);

    return {
      id,
      description: desc,
      status: "PENDING",
      implementation: "Pending implementation",
      verification: "Pending verification",
      evidence: "",
      acceptanceCriteria,
      source: "user-prompt",
      createdAt: now,
      updatedAt: now,
    };
  });

  return tracked;
}
