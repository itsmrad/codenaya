import { describe, it, expect } from "vitest";
import { GitStatusInspector } from "./git-inspector";
import { SafeFileSystem } from "./safe-file-system";
import { VersionManager } from "./version-manager";
import { RegressionAnalyzer } from "./regression-analyzer";
import { InMemoryFileSystem } from "../codebase/file-system";
import { SoftwareDevelopmentOrchestrator } from "../orchestrator";

describe("Git Safety & Rollback System", () => {
  describe("Git Status Inspector & User Work Detection", () => {
    it("inspects git status and detects uncommitted and untracked user changes", () => {
      const gitStatusOutput = `
## main...origin/main
 M src/app/globals.css
 M src/app/page.tsx
?? src/components/untracked-widget.tsx
 D src/legacy-file.ts
`;
      const inspector = new GitStatusInspector(gitStatusOutput);
      const report = inspector.getReport();

      expect(report.isClean).toBe(false);
      expect(report.branch).toBe("main");
      expect(report.existingUserChanges.length).toBe(4);
      expect(report.protectedFiles).toContain("src/app/globals.css");
      expect(report.protectedFiles).toContain("src/app/page.tsx");
      expect(report.protectedFiles).toContain("src/components/untracked-widget.tsx");
      expect(report.untrackedUserFiles).toContain("src/components/untracked-widget.tsx");

      expect(inspector.isUserWork("src/app/globals.css")).toBe(true);
      expect(inspector.isUserWork("src/components/untracked-widget.tsx")).toBe(true);
      expect(inspector.isUserWork("src/unrelated/new-file.ts")).toBe(false);
    });

    it("reports clean repository when no working tree changes exist", () => {
      const cleanOutput = `## main...origin/main\n`;
      const inspector = new GitStatusInspector(cleanOutput);
      const report = inspector.getReport();

      expect(report.isClean).toBe(true);
      expect(report.existingUserChanges.length).toBe(0);
      expect(report.protectedFiles.length).toBe(0);
      expect(report.summary).toContain("clean");
    });
  });

  describe("Safe File System & User Work Protection", () => {
    it("never overwrites or resets user work without explicit authorization", async () => {
      const fs = new InMemoryFileSystem({
        "src/app/globals.css": "/* User's custom styles */",
        "src/app/page.tsx": "export default function Page() { return <div>User work</div>; }",
        "src/lib/utils.ts": "export const add = (a: number, b: number) => a + b;",
      });

      const inspector = new GitStatusInspector();
      inspector.protectFile("src/app/globals.css");
      inspector.protectFile("src/app/page.tsx");

      const safeFs = new SafeFileSystem(fs, inspector);

      // Attempting to overwrite protected user file must throw a safety violation
      await expect(
        safeFs.writeFile("src/app/globals.css", "/* Overwritten by agent */")
      ).rejects.toThrow(/Git Safety Violation/i);

      // Attempting to delete protected user file must throw a safety violation
      await expect(
        safeFs.deleteFile("src/app/page.tsx")
      ).rejects.toThrow(/Git Safety Violation/i);

      // Verify the user's files remained completely intact
      expect(await fs.readFile("src/app/globals.css")).toBe("/* User's custom styles */");
      expect(await fs.readFile("src/app/page.tsx")).toContain("User work");

      // Modifying non-protected files is safely allowed
      await safeFs.writeFile("src/lib/utils.ts", "export const add = (a: number, b: number) => a + b + 0;");
      expect(await fs.readFile("src/lib/utils.ts")).toContain("a + b + 0");

      // Creating new files in allowed areas is allowed
      await safeFs.writeFile("src/lib/new-helper.ts", "export const helper = true;");
      expect(await fs.readFile("src/lib/new-helper.ts")).toBe("export const helper = true;");
    });

    it("allows modifying user work ONLY when explicit authorization is granted", async () => {
      const fs = new InMemoryFileSystem({
        "src/app/globals.css": "/* User custom theme */",
      });

      const inspector = new GitStatusInspector();
      inspector.protectFile("src/app/globals.css");

      // Explicitly authorize globals.css override
      const safeFs = new SafeFileSystem(fs, inspector, ["src/app/globals.css"]);

      await safeFs.writeFile("src/app/globals.css", "/* Authorized updated theme */");
      expect(await fs.readFile("src/app/globals.css")).toBe("/* Authorized updated theme */");
    });

    it("tracks touched, created, modified, and deleted files accurately", async () => {
      const fs = new InMemoryFileSystem({
        "existing.ts": "original",
        "to-delete.ts": "doomed",
      });

      const inspector = new GitStatusInspector();
      const safeFs = new SafeFileSystem(fs, inspector);

      await safeFs.writeFile("existing.ts", "modified");
      await safeFs.writeFile("new-file.ts", "brand new");
      await safeFs.deleteFile("to-delete.ts");

      expect(safeFs.getModifiedFiles()).toContain("existing.ts");
      expect(safeFs.getCreatedFiles()).toContain("new-file.ts");
      expect(safeFs.getDeletedFiles()).toContain("to-delete.ts");
      expect(safeFs.getTouchedFiles().length).toBe(3);
    });
  });

  describe("Version Management & Monotonic Best Version Protection", () => {
    it("maintains BASELINE, CURRENT_VERSION, BEST_VERSION, and EXPERIMENT_VERSION", async () => {
      const fs = new InMemoryFileSystem({
        "src/index.ts": "export const version = 1;",
      });

      const vm = new VersionManager();

      // 1. Establish Baseline
      const baseline = await vm.establishBaseline(fs, "Initial Baseline");
      expect(baseline.type).toBe("BASELINE");
      expect(vm.getBaseline()?.id).toBe(baseline.id);
      expect(vm.getCurrentVersion()?.id).toBe(baseline.id);
      expect(vm.getBestVersion()?.id).toBe(baseline.id);

      // 2. Start traceable experiment (creates EXPERIMENT_VERSION checkpoint)
      const exp1 = await vm.startExperiment(fs, "Add greeting feature", ["src/greeting.ts"]);
      expect(exp1.status).toBe("IN_PROGRESS");
      expect(exp1.checkpointBeforeId).toBeDefined();

      // Implement feature
      await fs.writeFile("src/greeting.ts", "export const greet = () => 'Hello';");

      // 3. Accept experiment and promote to BEST_VERSION
      const acceptedCheckpoint = await vm.acceptExperiment(fs, exp1.id, 90);
      expect(acceptedCheckpoint.type).toBe("CURRENT_VERSION");
      expect(vm.getBestVersion()?.name).toContain("Best Verified: Add greeting feature");
      expect(vm.getBestVersion()?.files.get("src/greeting.ts")).toBeDefined();
    });

    it("never destroys a previously verified best implementation", async () => {
      const fs = new InMemoryFileSystem({
        "src/index.ts": "export const BASE = true;",
      });

      const vm = new VersionManager();
      await vm.establishBaseline(fs);

      // High-quality verified experiment 1 (Score 95)
      const exp1 = await vm.startExperiment(fs, "Solid implementation");
      await fs.writeFile("src/index.ts", "export const HIGH_QUALITY = 95;");
      await vm.acceptExperiment(fs, exp1.id, 95);

      const bestAfterExp1 = vm.getBestVersion();
      expect(bestAfterExp1?.files.get("src/index.ts")).toContain("HIGH_QUALITY = 95");

      // Sub-optimal experiment 2 (Score 65 - lower than best)
      const exp2 = await vm.startExperiment(fs, "Inferior trial");
      await fs.writeFile("src/index.ts", "export const INFERIOR = 65;");
      await vm.acceptExperiment(fs, exp2.id, 65);

      // Best version MUST NOT be degraded or destroyed by lower score
      const bestAfterExp2 = vm.getBestVersion();
      expect(bestAfterExp2?.files.get("src/index.ts")).toContain("HIGH_QUALITY = 95");
      expect(bestAfterExp2?.name).toContain("95/100");
    });
  });

  describe("Rejection & Clean Rollback Flow", () => {
    it("restores previous best verified state and cleans up failed experimental files", async () => {
      const fs = new InMemoryFileSystem({
        "src/index.ts": "export const STABLE = true;",
        "src/unrelated.ts": "export const UNTOUCHED = true;",
      });

      const vm = new VersionManager();
      await vm.establishBaseline(fs);

      // Verify a baseline best state
      const exp1 = await vm.startExperiment(fs, "Step 1 Stable");
      await fs.writeFile("src/index.ts", "export const BEST_VERIFIED = true;");
      await vm.acceptExperiment(fs, exp1.id, 90);

      // Start an experiment that breaks things
      const exp2 = await vm.startExperiment(fs, "Experimental Feature with Regression", [
        "src/index.ts",
        "src/broken-experiment.ts",
      ]);

      // Modify stable file and create a new transient file
      await fs.writeFile("src/index.ts", "export const BROKEN_SYNTAX = {{{");
      await fs.writeFile("src/broken-experiment.ts", "export const FAILED_TRY = 1;");

      expect(await fs.exists("src/broken-experiment.ts")).toBe(true);

      // Execute Rollback:
      // REJECT CHANGE → ROLLBACK → ANALYZE → CREATE ALTERNATIVE → TEST AGAIN
      const rollbackResult = await vm.rejectAndRollback(
        fs,
        exp2.id,
        "Syntax validation failed with mismatched curly braces",
        {
          validation: {
            passed: false,
            checks: [
              {
                name: "Brace Balance: src/index.ts",
                type: "syntax",
                status: "failed",
                message: "Mismatched curly braces in src/index.ts",
                filePath: "src/index.ts",
              },
            ],
            errors: ["Mismatched curly braces in src/index.ts"],
            warnings: [],
          },
        }
      );

      // 1. Rollback must succeed
      expect(rollbackResult.success).toBe(true);

      // 2. Previously verified best version must be restored
      expect(await fs.readFile("src/index.ts")).toBe("export const BEST_VERIFIED = true;");

      // 3. Failed experimental files must NOT be left behind
      expect(await fs.exists("src/broken-experiment.ts")).toBe(false);
      expect(rollbackResult.filesCleanedUp).toContain("src/broken-experiment.ts");

      // 4. Unrelated files must remain untouched
      expect(await fs.readFile("src/unrelated.ts")).toBe("export const UNTOUCHED = true;");

      // 5. Regression analysis must formulate root cause and proposed alternative
      expect(rollbackResult.analysis.failureType).toBe("syntax");
      expect(rollbackResult.analysis.rootCause).toContain("Mismatched curly braces");
      expect(rollbackResult.alternativeStrategy).toBeTruthy();
      expect(rollbackResult.analysis.nextSteps.length).toBeGreaterThan(0);
    });

    it("handles regression analyzer diagnosis for various failure types", () => {
      const analyzer = new RegressionAnalyzer();

      // Score regression diagnosis
      const scoreDrop = analyzer.analyzeFailure({
        experimentDescription: "Refactor architecture",
        targetFiles: ["src/core.ts"],
        previousBestScore: 90,
        review: {
          approved: false,
          score: 60,
          criteriaAssessments: [],
          findings: [
            {
              severity: "major",
              title: "Loss of type safety",
              description: "Public functions now accept any",
            },
          ],
          improvementOpportunities: [],
          summary: "Quality degraded",
        },
      });

      expect(scoreDrop.failureType).toBe("score-drop");
      expect(scoreDrop.rootCause).toContain("90/100 down to 60/100");
      expect(scoreDrop.proposedAlternative).toContain("incremental delta");

      // Unauthorized file access diagnosis
      const unauthorizedAccess = analyzer.analyzeFailure({
        experimentDescription: "Update global styles",
        targetFiles: ["src/app/globals.css"],
        customError: "Git Safety Violation: Cannot overwrite, reset, or delete user work in 'src/app/globals.css'",
      });

      expect(unauthorizedAccess.failureType).toBe("unauthorized-file-access");
      expect(unauthorizedAccess.proposedAlternative).toContain("modular files");
    });
  });

  describe("End-to-End Orchestrator Git Safety Integration", () => {
    it("orchestrator inspects git status, establishes baseline, and safeguards user work", async () => {
      const fs = new InMemoryFileSystem({
        "package.json": JSON.stringify({ name: "demo", dependencies: { react: "19.0.0" } }),
        "src/app/globals.css": "/* User uncommitted theme work */",
        "src/index.ts": "export const APP_ID = 'demo';",
      });

      const gitStatusOutput = `
## main...origin/main
 M src/app/globals.css
`;

      const orchestrator = new SoftwareDevelopmentOrchestrator(fs);

      const output = await orchestrator.execute("Add a utility function for string capitalization", {
        taskId: "e2e-git-safety-clean",
        gitStatusOutput,
      });

      // 1. Git inspection recorded
      expect(output.gitInspection).toBeDefined();
      expect(output.gitInspection.isClean).toBe(false);
      expect(output.gitInspection.protectedFiles).toContain("src/app/globals.css");

      // 2. Baseline established
      expect(output.gitSafety.baseline).toBeDefined();
      expect(output.gitSafety.baseline?.type).toBe("BASELINE");

      // 3. User work untouched
      expect(await fs.readFile("src/app/globals.css")).toBe("/* User uncommitted theme work */");

      // 4. Best version maintained
      expect(output.gitSafety.bestVersion).toBeDefined();

      // 5. Traceable experiment recorded
      expect(output.gitSafety.experiments.length).toBeGreaterThan(0);
      expect(output.gitSafety.experiments[0].status).toBe("ACCEPTED");

      // 6. Context manager tracks git safety
      expect(output.context.gitSafety).toBeDefined();
      expect(output.context.gitSafety?.protectedFiles).toContain("src/app/globals.css");
    });

    it("orchestrator safely rolls back and cleans up when a regression is detected", async () => {
      // Create broken filesystem that will fail validation
      const fs = new InMemoryFileSystem({
        "package.json": JSON.stringify({ name: "broken-app" }),
        "src/index.ts": "export function broken() { if (true) { return 1; }", // Syntax error: missing closing brace
      });

      const orchestrator = new SoftwareDevelopmentOrchestrator(fs);

      const output = await orchestrator.execute("Attempt implementation that encounters regression", {
        taskId: "e2e-git-safety-regression",
      });

      // 1. Regression triggers rollback
      expect(output.gitSafety.rollbacks.length).toBeGreaterThan(0);
      const rollback = output.gitSafety.rollbacks[0];
      expect(rollback.success).toBe(true);

      // 2. Flow: REJECT CHANGE → ROLLBACK → ANALYZE → CREATE ALTERNATIVE → TEST AGAIN
      expect(output.events.some((ev) => ev.message.includes("ROLLBACK"))).toBe(true);
      expect(rollback.analysis.proposedAlternative).toBeTruthy();

      // 3. Experiment marked ROLLED_BACK
      const exp = output.gitSafety.experiments.find((e) => e.id === rollback.experimentId);
      expect(exp?.status).toBe("ROLLED_BACK");

      // 4. Review is not approved due to regression
      expect(output.review.approved).toBe(false);
    });
  });
});

