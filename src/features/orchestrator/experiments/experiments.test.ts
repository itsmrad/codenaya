import { describe, expect, it } from "vitest";
import { InMemoryFileSystem } from "../codebase/file-system";
import { VersionManager } from "../safety/version-manager";
import { ExperimentManager } from "./experiment-manager";

describe("Optimization Experiment Framework", () => {
  describe("Experiment Structure and Lifecycle", () => {
    it("creates an experiment containing all mandatory properties", async () => {
      const fs = new InMemoryFileSystem({ "src/app.ts": "export const a = 1;" });
      const manager = new ExperimentManager();

      const exp = await manager.createExperiment(fs, {
        hypothesis: "Memoizing heavy calculation reduces CPU overhead without regressions",
        proposedChange: "Wrap calculateMetrics in useMemo with dependency on items",
        expectedImprovement: "Zero re-renders on unrelated state changes, score +10",
        filesAffected: ["src/app.ts"],
        testsRequired: ["unit-test-memoization", "regression-check"],
        baseline: { score: 75 },
      });

      // Verify all required properties
      expect(exp.experimentId).toMatch(/^exp-opt-/);
      expect(exp.hypothesis).toBe("Memoizing heavy calculation reduces CPU overhead without regressions");
      expect(exp.baseline).toBeDefined();
      expect(exp.baseline.score).toBe(75);
      expect(exp.proposedChange).toContain("useMemo");
      expect(exp.expectedImprovement).toContain("Zero re-renders");
      expect(exp.filesAffected).toEqual(["src/app.ts"]);
      expect(exp.testsRequired).toEqual(["unit-test-memoization", "regression-check"]);
      expect(exp.startedAt).toBeGreaterThan(0);
      expect(exp.decision).toBeUndefined(); // Pending execution
      expect(exp.result).toBeUndefined();
    });
  });

  describe("Decisions: ACCEPT, REJECT, RETRY, ABANDON", () => {
    it("decision: ACCEPT - promotes experiment to new best result only after passing validation and demonstrating meaningful improvement", async () => {
      const fs = new InMemoryFileSystem({ "src/calc.ts": "export function calc() { return 1; }" });
      const vm = new VersionManager();
      await vm.establishBaseline(fs);

      const manager = new ExperimentManager({ versionManager: vm });

      const exp = await manager.createExperiment(fs, {
        hypothesis: "Optimize algorithm from O(n^2) to O(n)",
        proposedChange: "Use hash map lookup",
        expectedImprovement: "Score +15",
        filesAffected: ["src/calc.ts"],
        testsRequired: ["perf-test", "correctness-test"],
        baseline: { score: 70 },
      });

      // Evaluate with passing validation and higher score (+20)
      const evaluation = await manager.evaluateExperiment(fs, exp.experimentId, {
        customScore: 90,
        requiredTestsPassed: true,
        validation: {
          passed: true,
          checks: [{ name: "syntax", type: "syntax", status: "passed", message: "OK" }],
          errors: [],
          warnings: [],
        },
      });

      expect(evaluation.decision).toBe("ACCEPT");
      expect(evaluation.promotedToBest).toBe(true);
      expect(evaluation.experiment.result?.demonstratedImprovement).toBe(true);
      expect(evaluation.experiment.result?.scoreDelta).toBe(20);
      expect(manager.getCurrentBest()?.experimentId).toBe(exp.experimentId);
    });

    it("never silently replaces current best with unverified experiment or lower score", async () => {
      const fs = new InMemoryFileSystem({ "src/calc.ts": "export function calc() { return 1; }" });
      const manager = new ExperimentManager();

      // First experiment accepted at 85
      const exp1 = await manager.createExperiment(fs, {
        hypothesis: "First solid implementation",
        proposedChange: "Clean implementation",
        expectedImprovement: "Score 85",
        filesAffected: ["src/calc.ts"],
        testsRequired: ["test-1"],
        baseline: { score: 0 },
      });

      await manager.evaluateExperiment(fs, exp1.experimentId, {
        customScore: 85,
        requiredTestsPassed: true,
      });

      expect(manager.getCurrentBest()?.experimentId).toBe(exp1.experimentId);

      // Second experiment with a lower score (70) or failure
      const exp2 = await manager.createExperiment(fs, {
        hypothesis: "Experimental refactor to micro-service pattern",
        proposedChange: "Decouple into distributed handlers",
        expectedImprovement: "Scalability gain",
        filesAffected: ["src/service.ts"],
        testsRequired: ["test-2"],
        baseline: { score: 85 },
      });

      const evaluation2 = await manager.evaluateExperiment(fs, exp2.experimentId, {
        customScore: 70, // Worse than baseline
        requiredTestsPassed: false,
        failedTestNames: ["test-2 failed: latency increased"],
      });

      expect(evaluation2.decision).toBe("REJECT");
      expect(evaluation2.promotedToBest).toBe(false);

      // Inviolable rule: Best result MUST remain exp1 (never silently replaced)
      expect(manager.getCurrentBest()?.experimentId).toBe(exp1.experimentId);
      expect(manager.getCurrentBest()?.result?.score).toBe(85);
    });

    it("decision: RETRY - allows retry for minor addressable errors within retry limit", async () => {
      const fs = new InMemoryFileSystem();
      const manager = new ExperimentManager();

      const exp = await manager.createExperiment(fs, {
        hypothesis: "Add exported helper function",
        proposedChange: "Add helper in src/utils.ts",
        expectedImprovement: "Reusable utility",
        filesAffected: ["src/utils.ts"],
        testsRequired: ["lint-check"],
        maxRetries: 2,
        baseline: { score: 70 },
      });

      // Minor import typo detected
      const eval1 = await manager.evaluateExperiment(fs, exp.experimentId, {
        allowRetryIfMinor: true,
        validation: {
          passed: false,
          checks: [],
          errors: ["Missing import export typo: util is not exported"],
          warnings: [],
        },
      });

      expect(eval1.decision).toBe("RETRY");
      expect(eval1.experiment.retryCount).toBe(1);
    });

    it("decision: ABANDON - abandons approach on severe regression or exhausted retries", async () => {
      const fs = new InMemoryFileSystem();
      const manager = new ExperimentManager();

      const exp = await manager.createExperiment(fs, {
        hypothesis: "Rewrite parser with regex instead of AST",
        proposedChange: "Replace parser with single regex",
        expectedImprovement: "Simpler code",
        filesAffected: ["src/parser.ts"],
        testsRequired: ["ast-compliance"],
        baseline: { score: 80 },
      });

      // Catastrophic failure (score 25, critical review finding)
      const evaluation = await manager.evaluateExperiment(fs, exp.experimentId, {
        customScore: 25,
        review: {
          approved: false,
          score: 25,
          findings: [
            {
              severity: "critical",
              title: "Catastrophic parsing failure on nested structures",
              description: "Regex parser blows up stack on recursive nodes",
            },
          ],
          summary: "Total regression",
          criteriaAssessments: [],
        },
      });

      expect(evaluation.decision).toBe("ABANDON");
      expect(evaluation.promotedToBest).toBe(false);

      // Verify logged in failed strategies
      const failed = manager.getFailedStrategies();
      expect(failed.some((f) => f.experimentId === exp.experimentId)).toBe(true);
    });
  });

  describe("Strategy Viability & Repetition Prevention", () => {
    it("blocks repeated attempts of the same failed strategy without new justifying information", async () => {
      const fs = new InMemoryFileSystem();
      const manager = new ExperimentManager();

      // 1. Run and fail initial experiment
      const exp1 = await manager.createExperiment(fs, {
        hypothesis: "Inline all CSS styles into JSX style props for performance",
        proposedChange: "Remove CSS file and inline all styles into elements",
        expectedImprovement: "Zero CSS bundle size",
        filesAffected: ["src/components/button.tsx"],
        testsRequired: ["theme-compliance"],
        baseline: { score: 75 },
      });

      await manager.evaluateExperiment(fs, exp1.experimentId, {
        customScore: 30,
        requiredTestsPassed: false,
        failedTestNames: ["theme-compliance: broke responsive media queries"],
      });

      expect(manager.getFailedStrategies().length).toBe(1);

      // 2. Propose the same failed strategy again without justification
      await expect(
        manager.createExperiment(fs, {
          hypothesis: "Inline all CSS styles into JSX style props for performance",
          proposedChange: "Remove CSS file and inline styles into elements",
          expectedImprovement: "Zero CSS bundle",
          filesAffected: ["src/components/button.tsx"],
          testsRequired: ["theme-compliance"],
        })
      ).rejects.toThrow(/Repeated failed strategy blocked/);
    });

    it("permits retrying a previously failed approach when new information justifies it", async () => {
      const fs = new InMemoryFileSystem();
      const manager = new ExperimentManager();

      // 1. Run and fail initial experiment
      const exp1 = await manager.createExperiment(fs, {
        hypothesis: "Use Web Workers for background markdown parsing",
        proposedChange: "Spawn dedicated Worker in worker.ts",
        expectedImprovement: "Offload main thread",
        filesAffected: ["src/worker.ts"],
        testsRequired: ["worker-test"],
        baseline: { score: 70 },
      });

      await manager.evaluateExperiment(fs, exp1.experimentId, {
        customScore: 35,
        requiredTestsPassed: false,
        failedTestNames: ["Web Worker API not available in SSR node environment"],
      });

      // 2. Propose similar approach BUT with new information justification (e.g. check environment first)
      const exp2 = await manager.createExperiment(fs, {
        hypothesis: "Use Web Workers for background markdown parsing",
        proposedChange: "Spawn dedicated Worker in worker.ts with typeof window guard",
        expectedImprovement: "Offload main thread with SSR fallback",
        filesAffected: ["src/worker.ts"],
        testsRequired: ["worker-test", "ssr-test"],
        newInformationJustification: "Added typeof window guard and synchronous fallback for Node SSR environment",
      });

      expect(exp2.experimentId).toBeDefined();
      expect(exp2.justificationForRetry).toContain("typeof window guard");
    });
  });

  describe("Integration with VersionManager and Rollback", () => {
    it("rolls back filesystem and deletes transient files when experiment is rejected", async () => {
      const fs = new InMemoryFileSystem({
        "src/main.ts": "export const original = true;",
      });
      const vm = new VersionManager();
      await vm.establishBaseline(fs, "Clean baseline");

      const manager = new ExperimentManager({ versionManager: vm });

      const exp = await manager.createExperiment(fs, {
        hypothesis: "Refactor core engine to async generators",
        proposedChange: "Rewrite main.ts with async generators",
        expectedImprovement: "Streaming tokens",
        filesAffected: ["src/main.ts"],
        testsRequired: ["streaming-test"],
        baseline: { score: 80 },
      });

      // Experiment modifies main.ts and creates transient file
      await fs.writeFile("src/main.ts", "export const broken = undefined;");
      await fs.writeFile("src/transient-temp.ts", "export const junk = 1;");

      expect(await fs.exists("src/transient-temp.ts")).toBe(true);

      // Evaluate and reject
      const evalResult = await manager.evaluateExperiment(fs, exp.experimentId, {
        customScore: 40,
        requiredTestsPassed: false,
        validation: {
          passed: false,
          checks: [],
          errors: ["Async generator runtime crash"],
          warnings: [],
        },
      });

      expect(evalResult.decision).toBe("REJECT");

      // Verify filesystem was cleanly rolled back to baseline
      expect(await fs.readFile("src/main.ts")).toBe("export const original = true;");
      expect(await fs.exists("src/transient-temp.ts")).toBe(false);
    });

    it("generates markdown summary table of all experiments", async () => {
      const manager = new ExperimentManager();
      const fs = new InMemoryFileSystem();

      const exp1 = await manager.createExperiment(fs, {
        hypothesis: "Add caching layer to database queries",
        proposedChange: "Cache queries in memory",
        expectedImprovement: "Faster reads",
        filesAffected: ["src/db.ts"],
        testsRequired: ["cache-hit-test"],
        baseline: { score: 60 },
      });

      await manager.evaluateExperiment(fs, exp1.experimentId, {
        customScore: 85,
        requiredTestsPassed: true,
      });

      const summary = manager.toMarkdownSummary();
      expect(summary).toContain("| EXPERIMENT_ID | HYPOTHESIS | BASELINE | RESULT | DECISION | REASON |");
      expect(summary).toContain("Add caching layer to database");
      expect(summary).toContain("**ACCEPT**");
    });
  });
});
