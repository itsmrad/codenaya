import { describe, it, expect } from "vitest";
import {
  SoftwareDevelopmentOrchestrator,
  InMemoryFileSystem,
  ModelSelector,
  understandTask,
  inspectCodebase,
  createPlan,
  buildExecutionBatches,
  runValidation,
  runReview,
  generateFinalReport,
} from "./index";

describe("SoftwareDevelopmentOrchestrator", () => {
  it("Phase 1: understandTask correctly extracts goal, domain, and complexity", () => {
    const taskLow = understandTask("Fix typo in README.md");
    expect(taskLow.estimatedComplexity).toBe("low");
    expect(taskLow.normalizedGoal).toBe("Fix typo in README.md");

    const taskHigh = understandTask("Build a new multi-page analytics dashboard with charts");
    expect(taskHigh.estimatedComplexity).toBe("high");
    expect(taskHigh.domain).toBe("web-frontend");

    const taskCritical = understandTask("Refactor architecture and database overhaul");
    expect(taskCritical.estimatedComplexity).toBe("critical");
    expect(taskCritical.domain).toBe("full-stack");
  });

  it("Phase 2: inspectCodebase identifies architecture, framework, and dependencies", async () => {
    const fs = new InMemoryFileSystem({
      "package.json": JSON.stringify({
        name: "test-app",
        dependencies: {
          next: "15.0.0",
          react: "19.0.0",
          "lucide-react": "^0.500.0",
        },
      }),
      "src/app/page.tsx": "export default function Home() { return <div>Home</div>; }",
      "components.json": JSON.stringify({ style: "default" }),
    });

    const inspection = await inspectCodebase(fs, "medium");
    expect(inspection.framework).toBe("nextjs");
    expect(inspection.styling).toBe("shadcn");
    expect(inspection.hasTypeScript).toBe(true);
    expect(inspection.packageDependencies["next"]).toBe("15.0.0");
    expect(inspection.entryPoints).toContain("src/app/page.tsx");
    expect(inspection.patterns.length).toBeGreaterThan(0);
  });

  it("Phase 3: createPlan generates requirements, acceptance criteria, and subtasks", () => {
    const understood = understandTask("Architect and implement a user profile settings page");
    const inspection = {
      framework: "nextjs" as const,
      styling: "tailwind" as const,
      hasTypeScript: true,
      packageDependencies: { react: "19.0.0" },
      keyDirectories: ["src/app"],
      existingFiles: ["src/app/page.tsx"],
      patterns: ["Next.js App Router"],
      entryPoints: ["src/app/page.tsx"],
      summary: "Next.js project",
    };

    const plan = createPlan(understood, inspection);
    expect(plan.requirements.length).toBeGreaterThan(0);
    expect(plan.acceptanceCriteria.length).toBeGreaterThanOrEqual(4);
    expect(plan.subtasks.length).toBeGreaterThanOrEqual(3);

    // Verify subtask roles and dependencies
    const archTask = plan.subtasks.find((s) => s.role === "architect");
    const implTasks = plan.subtasks.filter((s) => s.role.includes("engineer") || s.role === "implementer");
    const testTask = plan.subtasks.find((s) => s.role === "tester");
    const reviewTask = plan.subtasks.find((s) => s.role.includes("reviewer"));

    expect(archTask).toBeDefined();
    expect(implTasks.length).toBeGreaterThan(0);
    expect(testTask).toBeDefined();
    expect(reviewTask).toBeDefined();

    // Verify dependency graph
    expect(testTask?.dependencies).toContain(implTasks[0].id);
    expect(reviewTask?.dependencies).toContain(testTask!.id);
  });

  it("Phase 4: ModelSelector maps task complexity and role to appropriate models", () => {
    const selector = new ModelSelector(new Set(["openai", "anthropic", "google"]));

    // Fast tier for low complexity implementer or tester
    const fastSelection = selector.selectModel("low", "implementer");
    expect(fastSelection.tier).toBe("fast");

    // Standard tier for medium complexity implementer
    const stdSelection = selector.selectModel("medium", "implementer");
    expect(stdSelection.tier).toBe("standard");

    // Advanced or reasoning for architect / critical
    const advSelection = selector.selectModel("critical", "architect");
    expect(["reasoning", "advanced"]).toContain(advSelection.tier);

    // Fallback when no providers are configured
    const mockSelector = new ModelSelector(new Set());
    const fallbackSelection = mockSelector.selectModel("high", "implementer");
    expect(fallbackSelection.provider).toBe("mock");
  });

  it("Phase 5: buildExecutionBatches resolves dependencies with sequential and parallel batches", () => {
    const plan = {
      goal: "Test batching",
      requirements: [],
      acceptanceCriteria: [],
      estimatedComplexity: "high" as const,
      architecturalNotes: [],
      subtasks: [
        {
          id: "step-1",
          title: "Step 1",
          description: "Architecture setup",
          role: "architect" as const,
          complexity: "medium" as const,
          recommendedModelTier: "advanced" as const,
          executionMode: "sequential" as const,
          dependencies: [],
          targetFiles: [],
          status: "PENDING" as const,
        },
        {
          id: "step-2a",
          title: "Step 2a",
          description: "Parallel Component A",
          role: "implementer" as const,
          complexity: "low" as const,
          recommendedModelTier: "fast" as const,
          executionMode: "parallel" as const,
          dependencies: ["step-1"],
          targetFiles: [],
          status: "PENDING" as const,
        },
        {
          id: "step-2b",
          title: "Step 2b",
          description: "Parallel Component B",
          role: "implementer" as const,
          complexity: "low" as const,
          recommendedModelTier: "fast" as const,
          executionMode: "parallel" as const,
          dependencies: ["step-1"],
          targetFiles: [],
          status: "PENDING" as const,
        },
        {
          id: "step-3",
          title: "Step 3",
          description: "Test verification",
          role: "tester" as const,
          complexity: "low" as const,
          recommendedModelTier: "fast" as const,
          executionMode: "sequential" as const,
          dependencies: ["step-2a", "step-2b"],
          targetFiles: [],
          status: "PENDING" as const,
        },
      ],
    };

    const batches = buildExecutionBatches(plan);
    expect(batches.length).toBe(3);
    expect(batches[0].mode).toBe("sequential");
    expect(batches[0].subtasks[0].id).toBe("step-1");

    expect(batches[1].mode).toBe("parallel");
    expect(batches[1].subtasks.map((s) => s.id)).toEqual(["step-2a", "step-2b"]);

    expect(batches[2].mode).toBe("sequential");
    expect(batches[2].subtasks[0].id).toBe("step-3");
  });

  it("Phase 7: runValidation detects JSON errors and mismatched braces", async () => {
    const invalidFs = new InMemoryFileSystem({
      "data.json": "{ invalid_json }",
      "bad.ts": "export function broken() { if (true) { return 1; }", // Missing closing brace
    });

    const validation = await runValidation(invalidFs);
    expect(validation.passed).toBe(false);
    expect(validation.errors.length).toBeGreaterThan(0);
    expect(validation.checks.some((c) => c.status === "failed")).toBe(true);

    const validFs = new InMemoryFileSystem({
      "data.json": '{"valid": true}',
      "ok.ts": "export function working() { if (true) { return 1; } }",
    });

    const validValidation = await runValidation(validFs);
    expect(validValidation.passed).toBe(true);
    expect(validValidation.errors.length).toBe(0);
  });

  it("Phase 8 & 9: runReview and generateFinalReport synthesize an executive report", async () => {
    const fs = new InMemoryFileSystem({
      "src/types.ts": "export interface User { id: string; name: string; }",
      "src/app/page.tsx": "export default function Page() { return <h1>Dashboard</h1>; }",
    });

    const understood = understandTask("Create user profile dashboard");
    const inspection = await inspectCodebase(fs, "medium");
    const plan = createPlan(understood, inspection);

    const review = await runReview(plan, fs);
    expect(review.score).toBeGreaterThan(0);
    expect(review.criteriaAssessments.length).toBe(plan.acceptanceCriteria.length);

    const report = generateFinalReport({
      taskId: "test-task-1",
      goal: understood.normalizedGoal,
      inspection,
      plan,
      implementation: {
        completedSubtasks: plan.subtasks,
        filesCreated: ["src/types.ts"],
        filesModified: ["src/app/page.tsx"],
        filesDeleted: [],
        success: true,
        errors: [],
        rejections: [],
      },
      validation: {
        passed: true,
        checks: [],
        errors: [],
        warnings: [],
      },
      review,
    });

    expect(report.taskId).toBe("test-task-1");
    expect(report.headline.toLowerCase()).toContain("user profile dashboard");
    expect(report.filesCreated).toContain("src/types.ts");
    expect(report.validationSummary.passed).toBe(true);
    expect(report.acceptanceCriteriaStatus.total).toBe(plan.acceptanceCriteria.length);
  });

  it("Executes full end-to-end workflow through SoftwareDevelopmentOrchestrator", async () => {
    const fs = new InMemoryFileSystem({
      "package.json": JSON.stringify({
        name: "codenaya-demo",
        dependencies: { react: "19.0.0" },
      }),
      "src/index.ts": "export const APP_NAME = 'Demo';",
    });

    const eventsCaptured: string[] = [];
    const orchestrator = new SoftwareDevelopmentOrchestrator(fs);

    const output = await orchestrator.execute("Add a theme toggle utility", {
      taskId: "orchestrator-e2e-test",
      onEvent: (ev) => eventsCaptured.push(ev.stage),
    });

    // Verify all stages of the workflow were executed in correct sequence:
    // Understand → Inspect → Plan → Select Models → Delegate → Implement → Test → Review → Evaluate → Improve → Verify → Complete
    const uniqueStages = eventsCaptured.filter((stage, idx, arr) => arr.indexOf(stage) === idx);
    expect(uniqueStages).toEqual([
      "understand",
      "inspect",
      "plan",
      "select-models",
      "delegate",
      "implement",
      "test",
      "review",
      "evaluate",
      "improve",
      "verify",
      "complete",
    ]);

    expect(output.taskId).toBe("orchestrator-e2e-test");
    expect(output.inspection.existingFiles).toContain("package.json");
    expect(output.plan.subtasks.length).toBeGreaterThan(0);
    expect(output.report.validationSummary.passed).toBe(true);
    expect(output.review.approved).toBe(true);
  });
});
