import { describe, it, expect } from "vitest";
import {
  InMemoryFileSystem,
  SubagentRegistry,
  ExplorerSubagent,
  FrontendEngineerSubagent,
  SecurityReviewerSubagent,
  createPlan,
  understandTask,
  buildExecutionBatches,
  ImplementationCoordinator,
} from "../index";

describe("Specialized Sub-Agent System", () => {
  const fs = new InMemoryFileSystem({
    "package.json": JSON.stringify({ name: "demo", dependencies: { react: "19.0.0" } }),
    "convex/schema.ts": "import { defineSchema } from 'convex/server';",
    "src/app/page.tsx": "export default function Home() { return <div>Home</div>; }",
  });

  describe("Subagent Registry (11 Reusable Roles)", () => {
    const registry = new SubagentRegistry();

    const expectedRoles = [
      "explorer",
      "architect",
      "frontend-engineer",
      "backend-engineer",
      "database-engineer",
      "debugger",
      "tester",
      "security-reviewer",
      "performance-reviewer",
      "ux-reviewer",
      "code-reviewer",
    ] as const;

    it.each(expectedRoles)("has registered specialized subagent for role '%s'", (role) => {
      const agent = registry.getAgent(role);
      expect(agent).toBeDefined();
      expect(agent?.role).toBe(role);
    });
  });

  describe("Orchestrator Selects Agents Without Unnecessary Spawning", () => {
    const baseInspection = {
      framework: "nextjs" as const,
      styling: "tailwind" as const,
      hasTypeScript: true,
      packageDependencies: { react: "19.0.0" },
      keyDirectories: ["src/app"],
      existingFiles: ["src/app/page.tsx"],
      patterns: [],
      entryPoints: ["src/app/page.tsx"],
      summary: "Next.js project",
    };

    it("spawns only frontend engineer, tester, and code reviewer for basic UI change", () => {
      const understood = understandTask("Update button styling on home page");
      const plan = createPlan(understood, baseInspection);

      const roles = plan.subtasks.map((s) => s.role);
      expect(roles).toContain("frontend-engineer");
      expect(roles).toContain("tester");
      expect(roles).toContain("code-reviewer");

      // Verify unnecessary agents were NOT spawned
      expect(roles).not.toContain("database-engineer");
      expect(roles).not.toContain("backend-engineer");
      expect(roles).not.toContain("debugger");
      expect(roles).not.toContain("security-reviewer");
      expect(roles).not.toContain("performance-reviewer");
    });

    it("spawns database-engineer only when database/schema task is requested", () => {
      const understood = understandTask("Add an auditLogs table to Convex database schema");
      const plan = createPlan(understood, baseInspection);

      const roles = plan.subtasks.map((s) => s.role);
      expect(roles).toContain("database-engineer");
      expect(roles).not.toContain("debugger");
      expect(roles).not.toContain("ux-reviewer");
    });

    it("spawns debugger only when fixing a defect or error", () => {
      const understood = understandTask("Fix crashing bug when clicking submit");
      const plan = createPlan(understood, baseInspection);

      const roles = plan.subtasks.map((s) => s.role);
      expect(roles).toContain("debugger");
    });

    it("spawns security-reviewer when security or authentication is requested", () => {
      const understood = understandTask("Implement SSRF safe proxy with auth token encryption");
      const plan = createPlan(understood, baseInspection);

      const roles = plan.subtasks.map((s) => s.role);
      expect(roles).toContain("security-reviewer");
    });

    it("spawns ux-reviewer when accessibility or UX design is requested", () => {
      const understood = understandTask("Audit mobile layout and screen reader accessibility");
      const plan = createPlan(understood, baseInspection);

      const roles = plan.subtasks.map((s) => s.role);
      expect(roles).toContain("ux-reviewer");
    });
  });

  describe("Sub-Agent Input and Reporting Contracts", () => {
    it("sub-agents receive explicit objectives, constraints, and allowed files", async () => {
      const explorer = new ExplorerSubagent();
      const report = await explorer.runTask({
        subtaskId: "st-explore-1",
        role: "explorer",
        objective: "Explore repository structure",
        relevantContext: "Initial workspace check",
        constraints: ["Do not mutate files"],
        expectedOutput: "Catalog of repository files",
        allowedFiles: [],
        acceptanceCriteria: [],
        complexity: "low",
        modelSelection: { provider: "mock", modelId: "mock", tier: "fast", reason: "fast exploration" },
        fileSystem: fs,
      });

      expect(report.subtaskId).toBe("st-explore-1");
      expect(report.role).toBe("explorer");
      expect(report.status).toBe("COMPLETED");
      expect(report.findings.length).toBeGreaterThan(0);
      expect(report.boundaryViolations.length).toBe(0);
    });

    it("SecurityReviewer detects hardcoded credential patterns", async () => {
      const insecureFs = new InMemoryFileSystem({
        "src/api/key.ts": "const apiKey = 'sk-123456789012345678901234';",
      });

      const securityReviewer = new SecurityReviewerSubagent();
      const report = await securityReviewer.runTask({
        subtaskId: "sec-check",
        role: "security-reviewer",
        objective: "Audit codebase for secrets",
        relevantContext: "Pre-deployment audit",
        constraints: ["Read-only inspection"],
        expectedOutput: "Audit findings",
        allowedFiles: [],
        acceptanceCriteria: [],
        complexity: "critical",
        modelSelection: { provider: "mock", modelId: "mock", tier: "reasoning", reason: "security check" },
        fileSystem: insecureFs,
      });

      expect(report.success).toBe(false);
      expect(report.status).toBe("FAILED");
      expect(report.findings.some((f) => f.includes("CRITICAL"))).toBe(true);
    });
  });

  describe("Orchestrator Boundary Enforcement & Acceptance/Rejection Gate", () => {
    it("orchestrator REJECTS subtask modifications outside allowedFiles", async () => {
      const localFs = new InMemoryFileSystem({
        "src/components/button.tsx": "export const Button = () => <button>Click</button>;",
        "src/server/auth.ts": "export const auth = {};",
      });
      const plan = {
        goal: "Update button styling",
        requirements: [],
        acceptanceCriteria: [],
        estimatedComplexity: "low" as const,
        architecturalNotes: [],
        subtasks: [
          {
            id: "rogue-frontend-task",
            title: "Update button",
            description: "Update button component",
            role: "frontend-engineer" as const,
            complexity: "low" as const,
            recommendedModelTier: "fast" as const,
            executionMode: "sequential" as const,
            dependencies: [],
            targetFiles: ["src/components/button.tsx"],
            allowedFiles: ["src/components/"], // Only allowed inside components!
            status: "PENDING" as const,
          },
        ],
      };

      // Mock subagent returning changes OUTSIDE allowedFiles (e.g. attempting to redesign server/auth.ts)
      const mockRogueAgent = new FrontendEngineerSubagent();
      mockRogueAgent.runTask = async () => ({
        subtaskId: "rogue-frontend-task",
        role: "frontend-engineer",
        success: true,
        status: "COMPLETED",
        summary: "Attempted unapproved server auth redesign",
        findings: [],
        proposedChanges: {
          filesCreated: [],
          filesModified: [{ path: "src/server/auth.ts", content: "compromised" }],
          filesDeleted: [],
        },
        boundaryViolations: ["Forbidden modification: src/server/auth.ts is outside allowed areas"],
      });

      const registry = new SubagentRegistry();
      registry.registerAgent("frontend-engineer", mockRogueAgent);

      const customCoordinator = new ImplementationCoordinator(registry);
      const result = await customCoordinator.executePlan(plan, new Map(), localFs);

      const task = result.completedSubtasks[0];
      expect(task.status).toBe("REJECTED");
      expect(task.rejectionReason).toContain("Boundary violation");
      // Verify file on disk was NOT modified!
      const originalAuth = await localFs.readFile("src/server/auth.ts");
      expect(originalAuth).toBe("export const auth = {};");
    });

    it("orchestrator ACCEPTS valid changes within boundaries and writes to filesystem", async () => {
      const localFs = new InMemoryFileSystem({
        "src/components/button.tsx": "export const Button = () => <button>Old</button>;",
      });

      const plan = {
        goal: "Update button label",
        requirements: [],
        acceptanceCriteria: [],
        estimatedComplexity: "low" as const,
        architecturalNotes: [],
        subtasks: [
          {
            id: "valid-frontend-task",
            title: "Update button label",
            description: "Update button text",
            role: "frontend-engineer" as const,
            complexity: "low" as const,
            recommendedModelTier: "fast" as const,
            executionMode: "sequential" as const,
            dependencies: [],
            targetFiles: ["src/components/button.tsx"],
            allowedFiles: ["src/components/button.tsx"],
            status: "PENDING" as const,
          },
        ],
      };

      const mockAgent = new FrontendEngineerSubagent();
      mockAgent.runTask = async () => ({
        subtaskId: "valid-frontend-task",
        role: "frontend-engineer",
        success: true,
        status: "COMPLETED",
        summary: "Updated button label",
        findings: ["Updated button component"],
        proposedChanges: {
          filesCreated: [],
          filesModified: [{ path: "src/components/button.tsx", content: "export const Button = () => <button>New</button>;" }],
          filesDeleted: [],
        },
        boundaryViolations: [],
      });

      const registry = new SubagentRegistry();
      registry.registerAgent("frontend-engineer", mockAgent);

      const coordinator = new ImplementationCoordinator(registry);
      const result = await coordinator.executePlan(plan, new Map(), localFs);

      const task = result.completedSubtasks[0];
      expect(task.status).toBe("ACCEPTED");
      const updated = await localFs.readFile("src/components/button.tsx");
      expect(updated).toContain("New");
    });
  });

  describe("Sequential vs Parallel Execution with Overlapping Files", () => {
    it("runs independent disjoint subtasks in parallel", () => {
      const plan = {
        goal: "Independent changes",
        requirements: [],
        acceptanceCriteria: [],
        estimatedComplexity: "medium" as const,
        architecturalNotes: [],
        subtasks: [
          {
            id: "task-nav",
            title: "Navbar component",
            description: "Navbar",
            role: "frontend-engineer" as const,
            complexity: "low" as const,
            recommendedModelTier: "fast" as const,
            executionMode: "parallel" as const,
            dependencies: [],
            targetFiles: ["src/components/navbar.tsx"],
            allowedFiles: ["src/components/navbar.tsx"],
            status: "PENDING" as const,
          },
          {
            id: "task-footer",
            title: "Footer component",
            description: "Footer",
            role: "frontend-engineer" as const,
            complexity: "low" as const,
            recommendedModelTier: "fast" as const,
            executionMode: "parallel" as const,
            dependencies: [],
            targetFiles: ["src/components/footer.tsx"],
            allowedFiles: ["src/components/footer.tsx"],
            status: "PENDING" as const,
          },
        ],
      };

      const batches = buildExecutionBatches(plan);
      expect(batches.length).toBe(1);
      expect(batches[0].mode).toBe("parallel");
      expect(batches[0].subtasks.length).toBe(2);
    });

    it("forces sequential execution when subtasks touch overlapping files", () => {
      const plan = {
        goal: "Overlapping changes",
        requirements: [],
        acceptanceCriteria: [],
        estimatedComplexity: "medium" as const,
        architecturalNotes: [],
        subtasks: [
          {
            id: "task-page-header",
            title: "Update header on page",
            description: "Update header",
            role: "frontend-engineer" as const,
            complexity: "low" as const,
            recommendedModelTier: "fast" as const,
            executionMode: "parallel" as const,
            dependencies: [],
            targetFiles: ["src/app/page.tsx"],
            allowedFiles: ["src/app/page.tsx"],
            status: "PENDING" as const,
          },
          {
            id: "task-page-footer",
            title: "Update footer on same page",
            description: "Update footer on same page",
            role: "frontend-engineer" as const,
            complexity: "low" as const,
            recommendedModelTier: "fast" as const,
            executionMode: "parallel" as const, // Marked parallel, but touches same file!
            dependencies: [],
            targetFiles: ["src/app/page.tsx"],
            allowedFiles: ["src/app/page.tsx"],
            status: "PENDING" as const,
          },
        ],
      };

      const batches = buildExecutionBatches(plan);
      // Because both subtasks target src/app/page.tsx, they MUST NOT run in parallel!
      expect(batches.length).toBe(2);
      expect(batches[0].mode).toBe("sequential");
      expect(batches[1].mode).toBe("sequential");
      expect(batches[0].subtasks[0].id).toBe("task-page-header");
      expect(batches[1].subtasks[0].id).toBe("task-page-footer");
    });
  });
});
