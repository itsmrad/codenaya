import { describe, expect, it } from "vitest";
import { TaskContextManager } from "./context-manager";
import { CodebaseInspection, Subtask, ValidationCheck } from "../types";
import { UnderstoodTask } from "../pipeline/1-understand";
import { GitSafetyState, RepositoryCheckpoint } from "../safety/types";

describe("TaskContextManager", () => {
  it("initializes with empty default state", () => {
    const manager = new TaskContextManager();
    const snapshot = manager.getSnapshot();

    expect(snapshot.techStack.framework).toBe("unknown");
    expect(snapshot.architecture).toBe("");
    expect(snapshot.importantFiles).toEqual([]);
    expect(snapshot.existingPatterns).toEqual([]);
    expect(snapshot.requirements).toEqual([]);
    expect(snapshot.acceptanceCriteria).toEqual([]);
    expect(snapshot.epistemicLog).toEqual([]);
  });

  describe("Epistemic Truth Tracking", () => {
    it("enforces verifiable evidence for FACT entries and rejects empty evidence", () => {
      const manager = new TaskContextManager();

      expect(() => {
        manager.addFact("Next.js 16 is used", "");
      }).toThrow(/Cannot record FACT without verifiable ground-truth evidence/);

      const fact = manager.addFact("Next.js 16 is used", "package.json contains next@16.1.1");
      expect(fact.type).toBe("FACT");
      expect(fact.evidence).toBe("package.json contains next@16.1.1");
      expect(fact.verifiedAt).toBeDefined();

      const facts = manager.getEpistemicEntries("FACT");
      expect(facts).toHaveLength(1);
      expect(facts[0].statement).toBe("Next.js 16 is used");
    });

    it("records ASSUMPTION, DECISION, OPEN_QUESTION, and VERIFIED_RESULT", () => {
      const manager = new TaskContextManager();

      const assumption = manager.addAssumption("User prefers dark mode by default");
      expect(assumption.type).toBe("ASSUMPTION");
      expect(assumption.evidence).toBeUndefined();

      const decision = manager.addDecision("Use Tailwind v4 CSS variables", "Better theme token integration");
      expect(decision.type).toBe("DECISION");
      expect(decision.statement).toContain("Rationale: Better theme token integration");

      const question = manager.addOpenQuestion("Should anonymous users be redirected to login?");
      expect(question.type).toBe("OPEN_QUESTION");

      const verified = manager.addVerifiedResult(
        "Build compiles with 0 errors",
        "next build exited with code 0"
      );
      expect(verified.type).toBe("VERIFIED_RESULT");
      expect(verified.evidence).toBe("next build exited with code 0");

      expect(manager.getEpistemicEntries()).toHaveLength(4);
      expect(manager.getEpistemicEntries("ASSUMPTION")).toHaveLength(1);
      expect(manager.getEpistemicEntries("DECISION")).toHaveLength(1);
      expect(manager.getEpistemicEntries("OPEN_QUESTION")).toHaveLength(1);
      expect(manager.getEpistemicEntries("VERIFIED_RESULT")).toHaveLength(1);
    });

    it("prevents assumptions from silently becoming facts without ground-truth evidence", () => {
      const manager = new TaskContextManager();

      const assumption = manager.addAssumption("Database has index on users.email");

      expect(() => {
        manager.verifyAssumption(assumption.id, "");
      }).toThrow(/Cannot verify assumption .* without empirical evidence/);

      expect(() => {
        manager.verifyAssumption("non-existent-id", "Some proof");
      }).toThrow(/Assumption with id 'non-existent-id' not found/);

      const verified = manager.verifyAssumption(
        assumption.id,
        "Checked convex/schema.ts defineTable with indexby('email')"
      );

      expect(verified.type).toBe("FACT");
      expect(verified.evidence).toBe("Checked convex/schema.ts defineTable with indexby('email')");
      expect(verified.verifiedAt).toBeDefined();

      expect(manager.getEpistemicEntries("ASSUMPTION")).toHaveLength(0);
      expect(manager.getEpistemicEntries("FACT")).toHaveLength(1);
    });

    it("resolves open questions into facts or decisions", () => {
      const manager = new TaskContextManager();
      const question = manager.addOpenQuestion("What port does the server run on?");

      const resolvedAsFact = manager.resolveOpenQuestion(
        question.id,
        "3000",
        "package.json scripts specify port 3000"
      );
      expect(resolvedAsFact.type).toBe("FACT");
      expect(resolvedAsFact.evidence).toBe("package.json scripts specify port 3000");
    });
  });

  describe("Avoiding Redundant Rediscovery", () => {
    it("tracks established knowledge and avoids rediscovery", () => {
      const manager = new TaskContextManager();

      expect(manager.hasEstablished("techStack")).toBe(false);
      expect(manager.hasEstablished("architecture")).toBe(false);
      expect(manager.hasEstablished("patterns")).toBe(false);
      expect(manager.hasEstablished("importantFiles")).toBe(false);

      const mockInspection: CodebaseInspection = {
        framework: "nextjs",
        styling: "tailwind",
        hasTypeScript: true,
        packageDependencies: { react: "^19.0.0", next: "^16.1.1" },
        existingFiles: ["src/app/layout.tsx", "convex/schema.ts"],
        keyDirectories: ["src/app", "convex"],
        entryPoints: ["src/app/layout.tsx", "convex/schema.ts"],
        patterns: ["Server Actions", "Convex Reactive Queries"],
      };

      manager.recordCodebaseInspection(mockInspection);

      expect(manager.hasEstablished("techStack")).toBe(true);
      expect(manager.hasEstablished("architecture")).toBe(true);
      expect(manager.hasEstablished("patterns")).toBe(true);
      expect(manager.hasEstablished("importantFiles")).toBe(true);

      const snapshot = manager.getSnapshot();
      expect(snapshot.techStack.framework).toBe("Next.js (App Router)");
      expect(snapshot.importantFiles).toContain("src/app/layout.tsx");
      expect(snapshot.existingPatterns).toContain("Server Actions");

      // Verify facts were recorded automatically from inspection
      const facts = manager.getEpistemicEntries("FACT");
      expect(facts.length).toBeGreaterThan(0);
      expect(facts.some((f) => f.statement.includes("Next.js"))).toBe(true);
    });
  });

  describe("Task and Sub-agent Delegation", () => {
    it("initializes from understood task and records plan", () => {
      const manager = new TaskContextManager();

      const understood: UnderstoodTask = {
        rawPrompt: "Implement user profile editing",
        normalizedGoal: "Allow authenticated users to edit and save their profile details",
        detectedDomain: "fullstack",
        domain: "fullstack",
        estimatedComplexity: "moderate",
        extractedRequirements: ["User can edit profile", "Profile is persisted in DB"],
        identifiedConstraints: ["Must maintain responsive mobile layout"],
        suggestedRoles: ["Frontend Engineer", "Backend Engineer"],
        scopeBoundaries: {
          inScope: ["User can edit profile", "Profile is persisted in DB"],
          outOfScope: ["Password reset flow"],
        },
      } as unknown as UnderstoodTask;

      manager.initializeFromTask(understood);
      const snapshot = manager.getSnapshot();

      expect(snapshot.currentTask.goal).toBe(understood.normalizedGoal);
      expect(snapshot.currentTask.domain).toBe("fullstack");

      const subtasks: Subtask[] = [
        {
          id: "subtask-1",
          role: "frontend-engineer",
          title: "Build profile form",
          description: "Build reactive profile editor component",
          status: "PENDING",
          dependencies: [],
          targetFiles: ["src/components/profile/profile-form.tsx"],
          allowedFiles: ["src/components/profile/**"],
          constraints: ["Use existing form controls"],
          acceptanceCriteria: ["Form validates input"],
          expectedOutput: "ProfileForm component",
        },
      ];

      manager.recordPlan(
        ["User can edit profile"],
        [
          {
            id: "ac-1",
            description: "Form validates input",
            status: "pending",
            required: true,
            verificationMethod: "structural-check",
          },
        ],
        subtasks
      );

      expect(manager.getSnapshot().acceptanceCriteria).toHaveLength(1);
    });

    it("provides scoped, token-conserving context tailored for each sub-agent", () => {
      const manager = new TaskContextManager();

      manager.recordCodebaseInspection({
        framework: "nextjs",
        styling: "tailwind",
        hasTypeScript: true,
        packageDependencies: { react: "^19.0.0" },
        existingFiles: [
          "src/components/profile/profile-form.tsx",
          "convex/schema.ts",
          "convex/users.ts",
        ],
        keyDirectories: ["src/components", "convex"],
        entryPoints: ["src/components/profile/profile-form.tsx"],
        patterns: ["Tailwind CSS utility styling"],
      });

      const frontendSubtask: Subtask = {
        id: "sub-fe",
        role: "frontend-engineer",
        title: "Build profile UI",
        description: "Create form UI",
        status: "RUNNING",
        dependencies: [],
        targetFiles: ["src/components/profile/profile-form.tsx"],
        allowedFiles: ["src/components/profile/**"],
        constraints: ["Match theme"],
        acceptanceCriteria: ["Accessible inputs"],
        expectedOutput: "Component file",
      };

      const scopedContext = manager.getScopedContextForSubagent(frontendSubtask);

      expect(scopedContext).toContain("SCOPED SUBTASK CONTEXT: [FRONTEND-ENGINEER]");
      expect(scopedContext).toContain("Create form UI");
      expect(scopedContext).toContain("src/components/profile/**");
      expect(scopedContext).toContain("Framework=nextjs");
      expect(scopedContext).toContain("Styling=tailwind");
    });
  });

  describe("Lifecycle and Git Safety Integration", () => {
    it("tracks subtask execution, implementation changes, and validation", () => {
      const manager = new TaskContextManager();

      manager.updateSubtaskState("sub-1", "RUNNING");
      expect(manager.getSnapshot().activeSubtasks).toContain("sub-1");

      manager.recordImplementationChanges({
        filesCreated: ["src/components/profile/profile-form.tsx"],
        filesModified: ["src/app/profile/page.tsx"],
        filesDeleted: [],
      });

      const snapshot = manager.getSnapshot();
      expect(snapshot.currentImplementation.filesCreated).toContain(
        "src/components/profile/profile-form.tsx"
      );
      expect(snapshot.currentImplementation.filesModified).toContain("src/app/profile/page.tsx");

      manager.updateSubtaskState("sub-1", "ACCEPTED");
      expect(manager.getSnapshot().activeSubtasks).not.toContain("sub-1");
      expect(manager.getSnapshot().completedSubtasks).toContain("sub-1");

      const checks: ValidationCheck[] = [
        { name: "TypeScript compilation", type: "syntax", status: "passed", message: "No errors" },
      ];
      manager.recordValidationResults({
        passed: true,
        checks,
        errors: [],
        warnings: [],
      });

      expect(manager.getSnapshot().testResults).toHaveLength(1);

      manager.recordBestResult(95, "Fully working profile editor");
      expect(manager.getSnapshot().bestResult?.score).toBe(95);
    });

    it("records Git safety state and logs protected files as epistemic facts", () => {
      const manager = new TaskContextManager();

      const baselineCheckpoint: RepositoryCheckpoint = {
        id: "chk-baseline-1",
        name: "Initial Working Tree Baseline",
        type: "BASELINE",
        timestamp: Date.now(),
        files: new Map([["src/app/globals.css", "body { margin: 0; }"]]),
        fileList: ["src/app/globals.css"],
      };

      const gitSafetyState: GitSafetyState = {
        baseline: baselineCheckpoint,
        currentVersion: baselineCheckpoint,
        bestVersion: baselineCheckpoint,
        activeExperiment: null,
        checkpoints: [baselineCheckpoint],
        experiments: [],
        rollbacks: [],
        protectedFiles: ["src/app/globals.css"],
      };

      manager.recordGitSafety(gitSafetyState);

      const snapshot = manager.getSnapshot();
      expect(snapshot.gitSafety).toBeDefined();
      expect(snapshot.gitSafety?.protectedFiles).toContain("src/app/globals.css");
      expect(snapshot.gitSafety?.baseline?.type).toBe("BASELINE");

      // Verify facts reflect protected files
      const facts = manager.getEpistemicEntries("FACT");
      expect(
        facts.some((f) => f.statement.toLowerCase().includes("protected"))
      ).toBe(true);

      // Verify compact string includes git safety section
      const compact = manager.toCompactString();
      expect(compact).toContain("## GIT_SAFETY");
      expect(compact).toContain("Protected Files: 1");
    });
  });
});

