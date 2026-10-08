import {
  CodebaseInspection,
  ImplementationPlan,
  Subtask,
} from "../types";
import { UnderstoodTask } from "./1-understand";
import { RequirementTracker } from "../requirements/tracker";

/**
 * Phase 3: Plan
 * Converts the user request and codebase inspection into explicit requirements,
 * acceptance criteria, and selectively spawns only the required specialized sub-agents.
 */
export function createPlan(
  understood: UnderstoodTask,
  inspection: CodebaseInspection,
  requirementTracker?: RequirementTracker
): ImplementationPlan {
  const goal = understood.normalizedGoal;
  const complexity = understood.estimatedComplexity;
  const lowerGoal = goal.toLowerCase();

  // 1. Initialize requirement tracker ensuring every user requirement is converted
  const tracker = requirementTracker ?? new RequirementTracker();
  if (tracker.getAll().length === 0) {
    tracker.initializeFromPrompt(understood.rawPrompt, inspection);
  }

  // Ensure baseline engineering requirements are tracked as well
  const baselineReqs = [
    `Deliver functional solution for: "${goal}"`,
    `Preserve existing ${inspection.framework} architecture and ${inspection.styling} styling conventions`,
    `Avoid recreating existing functionality or introducing redundant utilities`,
    `Implement minimal, targeted changes with high cohesion`,
    `Ensure all TypeScript types and exports are properly defined and consistent`,
  ];
  for (const bReq of baselineReqs) {
    if (!tracker.getAll().some((r) => r.description.toLowerCase() === bReq.toLowerCase())) {
      tracker.addRequirement(bReq, { inspection, source: "orchestrator-baseline" });
    }
  }

  const trackedRequirements = tracker.getAll();
  const requirements = trackedRequirements.map((r) => r.description);
  const acceptanceCriteria = tracker.getAllAcceptanceCriteria();

  // 3. Intelligently determine which specialized agent roles are strictly necessary
  // (Do not spawn agents unnecessarily!)
  const isBugOrFix = /\b(fix|bug|error|crash|broken|issue|failing)\b/i.test(lowerGoal);
  const isSecurity = /\b(security|auth|token|credential|secret|ssrf|injection|permission)\b/i.test(lowerGoal);
  const isPerformance = /\b(perf|performance|slow|fast|latency|speed|bundle|waterfall|optimize)\b/i.test(lowerGoal);
  const isUx = /\b(ux|ui|accessibility|a11y|aria|contrast|mobile|layout|screen reader)\b/i.test(lowerGoal);
  const isDatabase = /\b(database|schema|table|convex|migration|sql|query|mutation)\b/i.test(lowerGoal);
  const isBackend = /\b(backend|api|endpoint|server|route|webhook|workflow)\b/i.test(lowerGoal);
  const isFrontend = !isBackend && !isDatabase || /\b(component|page|ui|view|frontend|button|modal|card|form)\b/i.test(lowerGoal);
  const isArchHeavy = complexity === "critical" || /\b(architect|architecture|refactor|restructure|overhaul|system)\b/i.test(lowerGoal);

  const subtasks: Subtask[] = [];
  const baseConstraints = [
    "Make minimal targeted changes",
    "Do not independently redesign unrelated parts of the project",
    "Preserve existing naming conventions and framework patterns",
  ];

  // A. Architect (only when architectural alignment or high/critical complexity is needed)
  if (isArchHeavy) {
    subtasks.push({
      id: "subtask-arch",
      title: "Architectural alignment and interface contract definition",
      description: `Define system boundaries, interfaces, and module contracts for "${goal}".`,
      objective: "Establish architectural blueprint and contracts without breaking existing modules",
      relevantContext: `Existing framework: ${inspection.framework}, files: ${inspection.existingFiles.slice(0, 8).join(", ")}`,
      constraints: [...baseConstraints, "Do not alter established framework patterns"],
      expectedOutput: "Architectural blueprint and interface contracts",
      allowedFiles: ["src/types/", "src/lib/"],
      role: "architect",
      complexity: complexity === "critical" ? "critical" : "medium",
      recommendedModelTier: complexity === "critical" ? "reasoning" : "advanced",
      executionMode: "sequential",
      dependencies: [],
      targetFiles: inspection.hasTypeScript ? ["src/types/index.ts"] : [],
      status: "PENDING",
    });
  }

  // B. Debugger (only when task is diagnosing/fixing an error)
  if (isBugOrFix) {
    subtasks.push({
      id: "subtask-debug",
      title: "Diagnose root cause and formulate remediation patch",
      description: `Investigate root cause of "${goal}" and prepare surgical fix.`,
      objective: "Identify defect origin and isolate root cause",
      relevantContext: `Error or defect context from user request: ${goal}`,
      constraints: [...baseConstraints, "Fix only the identified defect without unrelated changes"],
      expectedOutput: "Root-cause diagnosis and verified remediation patch",
      allowedFiles: [],
      role: "debugger",
      complexity: "high",
      recommendedModelTier: "advanced",
      executionMode: "sequential",
      dependencies: isArchHeavy ? ["subtask-arch"] : [],
      targetFiles: [],
      status: "PENDING",
    });
  }

  // C. Database Engineer (only when database/schema changes are requested)
  if (isDatabase) {
    subtasks.push({
      id: "subtask-database",
      title: "Database schema and query definitions",
      description: `Update schema definitions and mutations for "${goal}".`,
      objective: "Define data models, tables, and mutations ensuring backward compatibility",
      relevantContext: `Convex schema and data model conventions`,
      constraints: [...baseConstraints, "Ensure non-breaking schema modifications"],
      expectedOutput: "Updated schema and mutation definitions",
      allowedFiles: ["convex/"],
      role: "database-engineer",
      complexity: "medium",
      recommendedModelTier: "standard",
      executionMode: isArchHeavy ? "sequential" : "parallel",
      dependencies: isArchHeavy ? ["subtask-arch"] : [],
      targetFiles: ["convex/schema.ts"],
      status: "PENDING",
    });
  }

  // D. Backend Engineer (only when API/server logic is requested)
  if (isBackend) {
    const backendDeps = [
      ...(isArchHeavy ? ["subtask-arch"] : []),
      ...(isDatabase ? ["subtask-database"] : []),
    ];
    subtasks.push({
      id: "subtask-backend",
      title: "Backend service and endpoint implementation",
      description: `Implement server-side logic and API routes for "${goal}".`,
      objective: "Implement secure, performant server routes and actions",
      relevantContext: `Server environment for ${inspection.framework}`,
      constraints: [...baseConstraints, "Enforce input validation with zod and handle errors cleanly"],
      expectedOutput: "Production-ready backend routes and server logic",
      allowedFiles: ["src/app/api/", "convex/"],
      role: "backend-engineer",
      complexity: "medium",
      recommendedModelTier: "standard",
      executionMode: "sequential",
      dependencies: backendDeps,
      targetFiles: [],
      status: "PENDING",
    });
  }

  // E. Frontend Engineer (for UI/client implementations)
  if (isFrontend) {
    const frontendDeps = [
      ...(isArchHeavy ? ["subtask-arch"] : []),
      ...(isBackend ? ["subtask-backend"] : []),
      ...(isDatabase ? ["subtask-database"] : []),
      ...(isBugOrFix ? ["subtask-debug"] : []),
    ];
    subtasks.push({
      id: "subtask-frontend-core",
      title: "Implement primary frontend components and views",
      description: `Implement UI components and layout for "${goal}".`,
      objective: "Build responsive, accessible, beautifully styled user interface components",
      relevantContext: `Styling: ${inspection.styling}, Framework: ${inspection.framework}`,
      constraints: [...baseConstraints, "Use existing shadcn/Tailwind design tokens and avoid inline styles"],
      expectedOutput: "Production-ready frontend components matching design system",
      allowedFiles: ["src/components/", "src/app/", "src/pages/"],
      role: "frontend-engineer",
      complexity: complexity === "critical" ? "high" : complexity,
      recommendedModelTier: complexity === "low" ? "fast" : "standard",
      executionMode: "sequential",
      dependencies: frontendDeps,
      targetFiles: [],
      status: "PENDING",
    });

    // If high complexity, add a parallel auxiliary frontend subtask with non-overlapping allowed files
    if (complexity === "high" || complexity === "critical") {
      subtasks.push({
        id: "subtask-frontend-aux",
        title: "Implement auxiliary frontend helpers and hooks",
        description: `Implement supporting client hooks or utility functions for "${goal}".`,
        objective: "Provide encapsulated custom hooks or UI helpers",
        relevantContext: "Client state and hook conventions",
        constraints: [...baseConstraints, "Encapsulate logic cleanly"],
        expectedOutput: "Custom React hooks and utilities",
        allowedFiles: ["src/hooks/", "src/lib/"],
        role: "frontend-engineer",
        complexity: "medium",
        recommendedModelTier: "standard",
        executionMode: "parallel",
        dependencies: frontendDeps,
        targetFiles: [],
        status: "PENDING",
      });
    }
  }

  // Fallback: If no implementation subtask was generated, ensure at least one implementer subtask
  if (subtasks.length === 0 || !subtasks.some((s) => s.role.includes("engineer") || s.role === "debugger")) {
    subtasks.push({
      id: "subtask-impl-core",
      title: "Implement primary functionality",
      description: `Implement changes for "${goal}".`,
      objective: "Implement requested feature cleanly",
      relevantContext: `Project files: ${inspection.existingFiles.slice(0, 5).join(", ")}`,
      constraints: baseConstraints,
      expectedOutput: "Implemented code changes",
      allowedFiles: [],
      role: "frontend-engineer",
      complexity,
      recommendedModelTier: "standard",
      executionMode: "sequential",
      dependencies: [],
      targetFiles: [],
      status: "PENDING",
    });
  }

  // F. Tester (always present to verify implementation)
  const implSubtaskIds = subtasks.map((s) => s.id);
  subtasks.push({
    id: "subtask-test",
    title: "Run automated validation and contract checks",
    description: "Verify syntax, relative imports, brackets, and structural integrity.",
    objective: "Ensure 0 syntax errors, valid JSON, and unbroken import chains",
    relevantContext: "Updated workspace file tree",
    constraints: ["Read-only validation, do not modify application files"],
    expectedOutput: "Comprehensive validation check results and diagnostic findings",
    allowedFiles: [],
    role: "tester",
    complexity: "low",
    recommendedModelTier: "fast",
    executionMode: "sequential",
    dependencies: implSubtaskIds,
    targetFiles: [],
    status: "PENDING",
  });

  // G. Specialized Reviewers (only spawned when domain demands them)
  const preReviewDeps = ["subtask-test"];

  if (isSecurity) {
    subtasks.push({
      id: "subtask-security-review",
      title: "Security & Credential Audit",
      description: "Audit code for hardcoded secrets, injection sinks, and auth checks.",
      objective: "Verify zero credential leaks and hardened security boundaries",
      relevantContext: "Security critical files and environment handling",
      constraints: ["Read-only inspection"],
      expectedOutput: "Security audit findings and risk ratings",
      allowedFiles: [],
      role: "security-reviewer",
      complexity: "critical",
      recommendedModelTier: "reasoning",
      executionMode: "parallel",
      dependencies: preReviewDeps,
      targetFiles: [],
      status: "PENDING",
    });
  }

  if (isPerformance) {
    subtasks.push({
      id: "subtask-perf-review",
      title: "Performance & Resource Audit",
      description: "Inspect code for waterfalls, re-renders, and bundle overhead.",
      objective: "Identify performance bottlenecks and bundle bloat",
      relevantContext: "Component structure and data fetching pipelines",
      constraints: ["Read-only inspection"],
      expectedOutput: "Performance optimization recommendations",
      allowedFiles: [],
      role: "performance-reviewer",
      complexity: "high",
      recommendedModelTier: "advanced",
      executionMode: "parallel",
      dependencies: preReviewDeps,
      targetFiles: [],
      status: "PENDING",
    });
  }

  if (isUx) {
    subtasks.push({
      id: "subtask-ux-review",
      title: "UX & Accessibility Audit",
      description: "Inspect component hierarchy, aria labels, and responsive layout.",
      objective: "Ensure high accessibility compliance and delightful UX",
      relevantContext: "UI component markup and interactive states",
      constraints: ["Read-only inspection"],
      expectedOutput: "Accessibility and UX findings",
      allowedFiles: [],
      role: "ux-reviewer",
      complexity: "medium",
      recommendedModelTier: "standard",
      executionMode: "parallel",
      dependencies: preReviewDeps,
      targetFiles: [],
      status: "PENDING",
    });
  }

  // H. Senior Code Reviewer (always responsible for final acceptance/rejection)
  const allReviewerDeps = subtasks
    .filter((s) => s.id.includes("review") || s.id === "subtask-test")
    .map((s) => s.id);

  subtasks.push({
    id: "subtask-final-code-review",
    title: "Senior engineering lead review against acceptance criteria",
    description: "Assess code quality, criteria satisfaction, and identify improvement opportunities.",
    objective: "Comprehensive quality review and final acceptance assessment",
    relevantContext: "Full task requirements and acceptance criteria",
    constraints: ["Read-only review against explicit acceptance criteria"],
    expectedOutput: "Senior lead review verdict with criteria scorecard and quality score",
    allowedFiles: [],
    role: "code-reviewer",
    complexity: "high",
    recommendedModelTier: "advanced",
    executionMode: "sequential",
    dependencies: allReviewerDeps,
    targetFiles: [],
    status: "PENDING",
  });

  return {
    goal,
    requirements,
    trackedRequirements,
    acceptanceCriteria,
    subtasks,
    estimatedComplexity: complexity,
    architecturalNotes: [
      `Targeting ${inspection.framework} environment with ${inspection.styling}.`,
      `Converted ${trackedRequirements.length} explicit requirements into tracked items with ${acceptanceCriteria.length} task-specific acceptance criteria.`,
      `Selectively spawned ${subtasks.length} specialized subagents tailored specifically for this task.`,
      `No unnecessary agents spawned; clear boundaries and constraints enforced.`,
    ],
  };
}
