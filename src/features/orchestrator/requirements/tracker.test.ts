import { describe, it, expect } from "vitest";
import { RequirementTracker } from "./tracker";
import {
  generateTaskAcceptanceCriteria,
  extractRequirementStringsFromPrompt,
  createTrackedRequirementsFromPrompt,
} from "./generator";
import {
  SoftwareDevelopmentOrchestrator,
  InMemoryFileSystem,
} from "../index";

describe("Requirement-Tracking System", () => {
  describe("Requirement Extraction & Conversion", () => {
    it("converts multi-point user prompts into tracked requirements without silently dropping any", () => {
      const prompt = `
        1. New users should see onboarding.
        2. Users must authenticate with Google OAuth.
        3. Dashboard must display monthly usage statistics.
        - Persist onboarding state in the database.
        - Prevent unauthorized access to administrative endpoints.
      `;

      const tracker = new RequirementTracker();
      const requirements = tracker.initializeFromPrompt(prompt);

      expect(requirements.length).toBe(5);

      // Verify each requirement maintains all 6 required fields:
      // REQUIREMENT_ID, DESCRIPTION, STATUS, IMPLEMENTATION, VERIFICATION, EVIDENCE
      for (const req of requirements) {
        expect(req.id).toMatch(/^req-\d+$/);
        expect(req.description).toBeTruthy();
        expect(req.status).toBe("PENDING");
        expect(req.implementation).toBe("Pending implementation");
        expect(req.verification).toBe("Pending verification");
        expect(req.evidence).toBe("");
        expect(req.acceptanceCriteria.length).toBeGreaterThan(0);
      }

      // Check specific descriptions were extracted
      const descriptions = requirements.map((r) => r.description.toLowerCase());
      expect(descriptions.some((d) => d.includes("new users should see onboarding"))).toBe(true);
      expect(descriptions.some((d) => d.includes("google oauth"))).toBe(true);
      expect(descriptions.some((d) => d.includes("monthly usage statistics"))).toBe(true);
      expect(descriptions.some((d) => d.includes("persist onboarding state"))).toBe(true);
      expect(descriptions.some((d) => d.includes("prevent unauthorized access"))).toBe(true);
    });

    it("extracts compound sentence requirements from unstructured prose", () => {
      const prompt = "Allow users to invite teammates by email, send invitation notifications, and track acceptance status.";
      const extracted = extractRequirementStringsFromPrompt(prompt);

      expect(extracted.length).toBeGreaterThanOrEqual(2);
      expect(extracted.some((e) => e.toLowerCase().includes("invite teammates"))).toBe(true);
      expect(extracted.some((e) => e.toLowerCase().includes("track acceptance"))).toBe(true);
    });

    it("guarantees single-line prompts become at least one tracked requirement", () => {
      const prompt = "Add dark mode toggle to header";
      const tracker = new RequirementTracker();
      const requirements = tracker.initializeFromPrompt(prompt);

      expect(requirements.length).toBe(1);
      expect(requirements[0].description).toBe("Add dark mode toggle to header");
      expect(requirements[0].status).toBe("PENDING");
    });

    it("creates tracked requirements directly with createTrackedRequirementsFromPrompt", () => {
      const prompt = "1. Enable caching\n2. Add audit logs";
      const tracked = createTrackedRequirementsFromPrompt(prompt);
      expect(tracked.length).toBe(2);
      expect(tracked[0].id).toBe("req-1");
      expect(tracked[1].id).toBe("req-2");
    });
  });

  describe("Task-Specific Acceptance Criteria Generation", () => {
    it("generates onboarding acceptance criteria matching the exact specification", () => {
      const criteria = generateTaskAcceptanceCriteria("req-1", "New users should see onboarding.");

      const descriptions = criteria.map((c) => c.description.toLowerCase());

      // Specification example checks:
      // * New authenticated user is detected.
      // * User is redirected to onboarding.
      // * Completed onboarding is persisted.
      // * Completed users are redirected to the dashboard.
      // * Refresh does not lose progress.
      // * Existing functionality remains intact.
      expect(descriptions.some((d) => d.includes("new authenticated user is detected"))).toBe(true);
      expect(descriptions.some((d) => d.includes("redirected to onboarding"))).toBe(true);
      expect(descriptions.some((d) => d.includes("persisted"))).toBe(true);
      expect(descriptions.some((d) => d.includes("redirected to the dashboard"))).toBe(true);
      expect(descriptions.some((d) => d.includes("refresh does not lose progress"))).toBe(true);
      expect(descriptions.some((d) => d.includes("existing functionality remains intact"))).toBe(true);

      for (const crit of criteria) {
        expect(crit.requirementId).toBe("req-1");
        expect(crit.status).toBe("pending");
        expect(crit.required).toBe(true);
      }
    });

    it("generates authentication and security acceptance criteria", () => {
      const criteria = generateTaskAcceptanceCriteria("req-auth", "Implement OAuth user login session token authentication");

      const descriptions = criteria.map((c) => c.description.toLowerCase());
      expect(descriptions.some((d) => d.includes("session identity") || d.includes("authentication state"))).toBe(true);
      expect(descriptions.some((d) => d.includes("unauthorized requests"))).toBe(true);
      expect(descriptions.some((d) => d.includes("tokens") || d.includes("credential"))).toBe(true);
    });

    it("generates database and schema acceptance criteria", () => {
      const criteria = generateTaskAcceptanceCriteria("req-db", "Create database schema for project team member roles");

      const descriptions = criteria.map((c) => c.description.toLowerCase());
      expect(descriptions.some((d) => d.includes("database schema"))).toBe(true);
      expect(descriptions.some((d) => d.includes("data integrity"))).toBe(true);
    });

    it("generates defect/bug fix acceptance criteria", () => {
      const criteria = generateTaskAcceptanceCriteria("req-fix", "Fix crash when clicking empty table row");

      const descriptions = criteria.map((c) => c.description.toLowerCase());
      expect(descriptions.some((d) => d.includes("root cause"))).toBe(true);
      expect(descriptions.some((d) => d.includes("defect") || d.includes("crash"))).toBe(true);
      expect(descriptions.some((d) => d.includes("intact"))).toBe(true);
    });
  });

  describe("Lifecycle Status Transitions & Evidence Enforcement", () => {
    it("transitions requirements through PENDING -> IN_PROGRESS -> IMPLEMENTED -> VERIFIED", () => {
      const tracker = new RequirementTracker();
      const req = tracker.addRequirement("Export report to CSV file format");

      expect(req.status).toBe("PENDING");

      tracker.markInProgress(req.id, "Subagent assigned");
      expect(tracker.getRequirement(req.id)?.status).toBe("IN_PROGRESS");

      tracker.markImplemented(req.id, "Created exportCsv utility", ["src/lib/csv.ts"]);
      const implemented = tracker.getRequirement(req.id);
      expect(implemented?.status).toBe("IMPLEMENTED");
      expect(implemented?.implementation).toContain("src/lib/csv.ts");

      // Verify requirement with empirical evidence
      tracker.verifyRequirement(
        req.id,
        "Automated CSV test passed with 100 sample records. Review approved.",
        "Verified against test execution"
      );

      const verified = tracker.getRequirement(req.id);
      expect(verified?.status).toBe("VERIFIED");
      expect(verified?.evidence).toContain("Automated CSV test passed");
      expect(verified?.verifiedAt).toBeDefined();

      // All child acceptance criteria should be marked passed
      expect(verified?.acceptanceCriteria.every((c) => c.status === "passed")).toBe(true);
    });

    it("refuses to verify a requirement without empirical evidence (epistemic integrity)", () => {
      const tracker = new RequirementTracker();
      const req = tracker.addRequirement("Encrypt sensitive tokens at rest");

      // Verification without evidence MUST throw to prevent ungrounded claims
      expect(() => {
        tracker.verifyRequirement(req.id, "");
      }).toThrow(/without verifiable evidence/i);

      expect(() => {
        tracker.verifyRequirement(req.id, "   ");
      }).toThrow(/without verifiable evidence/i);

      expect(tracker.getRequirement(req.id)?.status).toBe("PENDING");
    });

    it("handles BLOCKED and FAILED requirement states", () => {
      const tracker = new RequirementTracker();
      const req1 = tracker.addRequirement("Integrate Stripe payment checkout");
      const req2 = tracker.addRequirement("Connect external webhooks");

      tracker.markBlocked(req1.id, "Stripe API credentials missing from environment");
      expect(tracker.getRequirement(req1.id)?.status).toBe("BLOCKED");
      expect(tracker.getRequirement(req1.id)?.verification).toContain("Stripe API credentials missing");

      tracker.markFailed(req2.id, "Endpoint failed with 500 error", "Webhook listener timed out");
      expect(tracker.getRequirement(req2.id)?.status).toBe("FAILED");
      expect(tracker.getRequirement(req2.id)?.evidence).toBe("Webhook listener timed out");
    });
  });

  describe("Pre-Completion Verification Audit", () => {
    it("flags unverified requirements and prevents premature declaration of complete task", () => {
      const tracker = new RequirementTracker();
      const req1 = tracker.addRequirement("Requirement 1");
      const req2 = tracker.addRequirement("Requirement 2");
      const req3 = tracker.addRequirement("Requirement 3");

      tracker.verifyRequirement(req1.id, "Evidence 1: Unit tests passed");
      tracker.markImplemented(req2.id, "Code written but not tested");
      tracker.markFailed(req3.id, "Integration test failed");

      const audit = tracker.verifyAllBeforeCompletion();

      expect(audit.allVerified).toBe(false);
      expect(audit.totalCount).toBe(3);
      expect(audit.verifiedCount).toBe(1);
      expect(audit.implementedCount).toBe(1);
      expect(audit.failedCount).toBe(1);
      expect(audit.unverifiedRequirements.length).toBe(2);
      expect(audit.unverifiedRequirements.map((r) => r.id)).toEqual([req2.id, req3.id]);
    });

    it("confirms allVerified when every requirement is verified individually with evidence", () => {
      const tracker = new RequirementTracker();
      const req1 = tracker.addRequirement("Feature Alpha");
      const req2 = tracker.addRequirement("Feature Beta");

      tracker.verifyRequirement(req1.id, "Alpha verified: UI rendered and click handlers fired");
      tracker.verifyRequirement(req2.id, "Beta verified: API response parsed successfully");

      const audit = tracker.verifyAllBeforeCompletion();

      expect(audit.allVerified).toBe(true);
      expect(audit.verifiedCount).toBe(2);
      expect(audit.unverifiedRequirements.length).toBe(0);
      expect(audit.summary).toContain("2/2 verified");
    });

    it("detects when a requirement is missing from the tracker (never silently drop)", () => {
      const tracker = new RequirementTracker();
      const prompt = `
        1. Implement password reset
        2. Send email verification token
        3. Rate-limit reset attempts
      `;
      tracker.initializeFromPrompt(prompt);

      expect(tracker.getAll().length).toBe(3);

      const auditBefore = tracker.verifyAllBeforeCompletion();
      expect(auditBefore.allVerified).toBe(false);
      expect(auditBefore.unverifiedRequirements.length).toBe(3);
    });

    it("generates markdown status report table with all 6 required fields", () => {
      const tracker = new RequirementTracker();
      const req = tracker.addRequirement("Track user analytics events");
      tracker.recordImplementation(req.id, "Added trackEvent helper in src/analytics.ts");
      tracker.verifyRequirement(req.id, "Verified by firing 5 mock events with telemetry assertion");

      const md = tracker.toMarkdownTable();
      expect(md).toContain("| REQUIREMENT_ID | DESCRIPTION | STATUS | IMPLEMENTATION | VERIFICATION | EVIDENCE |");
      expect(md).toContain(req.id);
      expect(md).toContain("VERIFIED");
      expect(md).toContain("Track user analytics events");
      expect(md).toContain("src/analytics.ts");
      expect(md).toContain("Verified by firing 5 mock events");
    });
  });

  describe("Orchestrator Integration", () => {
    it("orchestrator tracks, verifies individually, and reports all requirements throughout execution", async () => {
      const fs = new InMemoryFileSystem({
        "package.json": JSON.stringify({
          name: "tracker-test-app",
          dependencies: { react: "19.0.0" },
        }),
        "src/types.ts": "export interface UserProfile { id: string; name: string; }",
        "src/index.ts": "export const APP_VERSION = '1.0.0';",
      });

      const orchestrator = new SoftwareDevelopmentOrchestrator(fs);

      const output = await orchestrator.execute(
        "1. Define user profile schema and types.\n2. Ensure existing functionality remains intact.",
        { taskId: "e2e-requirement-tracking-test" }
      );

      // Verify tracked requirements exist on output
      expect(output.trackedRequirements.length).toBeGreaterThanOrEqual(2);

      // Check all 6 required fields are maintained on every requirement
      for (const req of output.trackedRequirements) {
        expect(req.id).toBeDefined();
        expect(req.description).toBeDefined();
        expect(req.status).toBeDefined();
        expect(req.implementation).toBeDefined();
        expect(req.verification).toBeDefined();
        expect(req.evidence).toBeDefined();
      }

      // Verify requirementReport is provided
      expect(output.requirementReport).toBeDefined();
      expect(output.requirementReport.totalCount).toBe(output.trackedRequirements.length);

      // Verify report includes requirementsStatus
      expect(output.report.requirementsStatus).toBeDefined();
      expect(output.report.requirementsStatus?.total).toBe(output.trackedRequirements.length);

      // Verify every requirement was verified individually
      expect(output.requirementReport.allVerified).toBe(true);
      expect(output.report.requirementsStatus?.allVerified).toBe(true);

      // Verify context manager snapshot recorded the tracked requirements
      expect(output.context.trackedRequirements?.length).toBe(output.trackedRequirements.length);
    });

    it("orchestrator rejects approval if requirements cannot be verified", async () => {
      // Codebase with invalid JSON causing validation errors
      const brokenFs = new InMemoryFileSystem({
        "data.json": "{ invalid_json: missing_quotes }",
        "src/index.ts": "export function test() { if (true) { return 1; }", // Missing brace
      });

      const orchestrator = new SoftwareDevelopmentOrchestrator(brokenFs);

      const output = await orchestrator.execute(
        "Fix table rendering bug and ensure data integrity",
        { taskId: "e2e-failed-requirement-test" }
      );

      // Because validation failed, requirements must NOT be marked verified
      expect(output.requirementReport.allVerified).toBe(false);
      expect(output.requirementReport.failedCount).toBeGreaterThan(0);
      expect(output.review.approved).toBe(false);
      expect(output.report.requirementsStatus?.allVerified).toBe(false);
    });
  });
});
