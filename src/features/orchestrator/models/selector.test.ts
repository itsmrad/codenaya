import { describe, it, expect } from "vitest";
import { ModelSelector } from "./selector";
import { WorkClassifier } from "./classifier";
import { ModelComparator } from "./comparator";
import { EvaluatedModel } from "./types";

describe("Intelligent Model Selection Layer", () => {
  const allProviders = new Set(["openai", "anthropic", "google", "vertex"]);
  const selector = new ModelSelector(allProviders);

  describe("Work Classification (8 Dimensions)", () => {
    const classifier = new WorkClassifier();

    it("correctly classifies heavy architectural tasks", () => {
      const classification = classifier.classify({
        taskTitle: "Design system architecture",
        taskDescription: "Architectural blueprint and framework decoupling across entire project",
        role: "architect",
      });

      expect(classification.category).toBe("architecture");
      expect(classification.complexity).toBe("critical");
      expect(classification.reasoningRequirements).toBe("intensive");
      expect(classification.requiredAccuracy).toBe("critical");
      expect(classification.speedRequirements).toBe("low");
      expect(classification.expectedImpact).toBe("system-wide");
      expect(classification.costSensitivity).toBe("quality-first");
    });

    it("correctly classifies security analysis tasks", () => {
      const classification = classifier.classify({
        taskTitle: "Audit token encryption and SSRF vulnerability",
        taskDescription: "Inspect crypto boundaries, auth tokens, and credential storage",
      });

      expect(classification.category).toBe("security-analysis");
      expect(classification.complexity).toBe("critical");
      expect(classification.reasoningRequirements).toBe("intensive");
      expect(classification.requiredAccuracy).toBe("critical");
      expect(classification.expectedImpact).toBe("system-wide");
    });

    it("correctly classifies complex debugging tasks", () => {
      const classification = classifier.classify({
        taskTitle: "Fix intermittent memory leak",
        taskDescription: "Root cause diagnosis for race condition and deadlock in event stream",
      });

      expect(classification.category).toBe("complex-debugging");
      expect(classification.complexity).toBe("high");
      expect(classification.reasoningRequirements).toBe("intensive");
      expect(classification.codingDifficulty).toBe("challenging");
    });

    it("correctly classifies simple edit and formatting tasks", () => {
      const simpleEdit = classifier.classify({
        taskTitle: "Fix typo in button label",
        taskDescription: "Change 'Submt' to 'Submit' in header",
      });
      expect(simpleEdit.category).toBe("simple-edit");
      expect(simpleEdit.complexity).toBe("low");
      expect(simpleEdit.reasoningRequirements).toBe("minimal");
      expect(simpleEdit.speedRequirements).toBe("immediate");
      expect(simpleEdit.costSensitivity).toBe("budget-conscious");

      const formatting = classifier.classify({
        taskTitle: "Format files with prettier",
        taskDescription: "Fix whitespace and eslint formatting in components",
      });
      expect(formatting.category).toBe("formatting");
      expect(formatting.reasoningRequirements).toBe("minimal");
      expect(formatting.speedRequirements).toBe("high");
    });

    it("correctly classifies repository exploration and file searching", () => {
      const exploration = classifier.classify({
        taskTitle: "Explore repository structure",
        taskDescription: "Discover directory layout and package dependencies",
      });
      expect(exploration.category).toBe("repository-exploration");
      expect(exploration.speedRequirements).toBe("immediate");
      expect(exploration.contextSize).toBe("massive");

      const fileSearch = classifier.classify({
        taskTitle: "Search symbol references",
        taskDescription: "Find all usages of createConvexApprovalGate",
      });
      expect(fileSearch.category).toBe("file-searching");
      expect(fileSearch.speedRequirements).toBe("immediate");
      expect(fileSearch.expectedImpact).toBe("isolated");
    });
  });

  describe("Stronger Reasoning Models for High-Impact Tasks", () => {
    it("selects reasoning or advanced tier model for Architecture", () => {
      const decision = selector.selectModelForTask({
        taskTitle: "System architecture overhaul",
        taskDescription: "Define module boundaries and event pipeline",
        role: "architect",
      });

      expect(["reasoning", "advanced"]).toContain(decision.model.tier);
      expect(decision.classification.category).toBe("architecture");
      expect(decision.reason).toContain(decision.model.id);
      expect(decision.expectedOutput).toContain("Architectural blueprint");
      expect(decision.confidence).toBeGreaterThanOrEqual(0.8);
    });

    it("selects reasoning or advanced tier model for Security Analysis", () => {
      const decision = selector.selectModelForTask({
        taskTitle: "Security audit",
        taskDescription: "Audit auth token encryption and SSRF vulnerability in integration proxy",
      });

      expect(["reasoning", "advanced"]).toContain(decision.model.tier);
      expect(decision.classification.category).toBe("security-analysis");
      expect(decision.expectedOutput).toContain("Vulnerability assessment");
    });

    it("selects reasoning or advanced tier model for Final Code Review", () => {
      const decision = selector.selectModelForTask({
        taskTitle: "Final code review",
        taskDescription: "Senior lead evaluation against acceptance criteria",
        role: "reviewer",
      });

      expect(["reasoning", "advanced"]).toContain(decision.model.tier);
      expect(decision.expectedOutput).toContain("Senior engineering review verdict");
    });

    it("selects reasoning or advanced tier model for Large Refactor", () => {
      const decision = selector.selectModelForTask({
        taskTitle: "Migrate state management to Zustand",
        taskDescription: "Large refactor across 12 files preserving type safety",
      });

      expect(["reasoning", "advanced"]).toContain(decision.model.tier);
      expect(decision.expectedOutput).toContain("Non-breaking modular refactoring");
    });
  });

  describe("Faster Models for Lightweight Tasks", () => {
    it("selects fast tier model for Simple Edits", () => {
      const decision = selector.selectModelForTask({
        taskTitle: "Fix typo",
        taskDescription: "Rename button title in navbar",
      });

      expect(decision.model.tier).toBe("fast");
      expect(decision.expectedOutput).toContain("Targeted surgical single-file modification");
      expect(decision.confidence).toBeGreaterThan(0.75);
    });

    it("selects fast tier model for Repository Exploration", () => {
      const decision = selector.selectModelForTask({
        taskTitle: "Explore repository files",
        taskDescription: "Scan directory tree and locate config files",
      });

      expect(decision.model.tier).toBe("fast");
      expect(decision.expectedOutput).toContain("Structured catalog of repository files");
    });

    it("selects fast tier model for Straightforward Fixes", () => {
      const decision = selector.selectModelForTask({
        taskTitle: "One-line syntax fix",
        taskDescription: "Add missing semicolon in index.ts",
      });

      expect(decision.model.tier).toBe("fast");
      expect(decision.expectedOutput).toContain("Direct, concise correction");
    });

    it("selects fast tier model for Formatting", () => {
      const decision = selector.selectModelForTask({
        taskTitle: "Run code formatter",
        taskDescription: "Format indentations and whitespace",
      });

      expect(decision.model.tier).toBe("fast");
      expect(decision.expectedOutput).toContain("Formatted source code");
    });
  });

  describe("Decision Contract: MODEL, REASON, EXPECTED OUTPUT, CONFIDENCE", () => {
    it("produces all four required properties on every decision", () => {
      const decision = selector.selectModelForTask({
        taskTitle: "Implement user authentication hook",
        taskDescription: "Custom React hook with Clerk auth",
        role: "implementer",
      });

      // 1. MODEL
      expect(decision.model).toBeDefined();
      expect(decision.model.id).toBeTruthy();
      expect(decision.model.provider).toBeTruthy();
      expect(decision.model.tier).toBeTruthy();

      // 2. REASON
      expect(decision.reason).toBeDefined();
      expect(decision.reason.length).toBeGreaterThan(10);
      expect(decision.reason).toContain(decision.model.id);

      // 3. EXPECTED OUTPUT
      expect(decision.expectedOutput).toBeDefined();
      expect(decision.expectedOutput.length).toBeGreaterThan(10);

      // 4. CONFIDENCE
      expect(typeof decision.confidence).toBe("number");
      expect(decision.confidence).toBeGreaterThanOrEqual(0.0);
      expect(decision.confidence).toBeLessThanOrEqual(1.0);
    });
  });

  describe("Model Capability Comparison", () => {
    it("ranks candidates and identifies winner when multiple models are available", () => {
      const customCandidates: EvaluatedModel[] = [
        {
          id: "fast-model",
          provider: "google",
          tier: "fast",
          capabilities: { reasoning: 7.0, coding: 7.0, speed: 9.8, costEfficiency: 9.8, contextWindow: 1_000_000 },
          strengths: ["speed"],
        },
        {
          id: "heavy-reasoning-model",
          provider: "anthropic",
          tier: "reasoning",
          capabilities: { reasoning: 9.9, coding: 9.8, speed: 5.0, costEfficiency: 5.0, contextWindow: 200_000 },
          strengths: ["reasoning"],
        },
      ];

      const comparator = new ModelComparator();

      // For intensive reasoning task, heavy model wins
      const reasoningComparison = comparator.compareModels(customCandidates, {
        complexity: "critical",
        reasoningRequirements: "intensive",
        codingDifficulty: "expert",
        contextSize: "medium",
        requiredAccuracy: "critical",
        speedRequirements: "low",
        expectedImpact: "system-wide",
        costSensitivity: "quality-first",
        category: "architecture",
      });

      expect(reasoningComparison.winner.id).toBe("heavy-reasoning-model");
      expect(reasoningComparison.rankedCandidates[0].isWinner).toBe(true);
      expect(reasoningComparison.rankedCandidates[0].suitabilityScore).toBeGreaterThan(
        reasoningComparison.rankedCandidates[1].suitabilityScore
      );

      // For speed-critical trivial edit, fast model wins
      const fastComparison = comparator.compareModels(customCandidates, {
        complexity: "low",
        reasoningRequirements: "minimal",
        codingDifficulty: "trivial",
        contextSize: "small",
        requiredAccuracy: "tolerant",
        speedRequirements: "immediate",
        expectedImpact: "isolated",
        costSensitivity: "budget-conscious",
        category: "simple-edit",
      });

      expect(fastComparison.winner.id).toBe("fast-model");
    });
  });

  describe("Graceful Fallback Mechanism", () => {
    it("falls back gracefully when the preferred provider is missing", () => {
      // Only google is available
      const googleOnlySelector = new ModelSelector(new Set(["google"]));

      const decision = googleOnlySelector.selectModelForTask({
        taskTitle: "Design security layer",
        taskDescription: "Security analysis",
      });

      expect(decision.model.provider).toBe("google");
      expect(decision.fallbackChain.length).toBeGreaterThan(0);
    });

    it("falls back to local mock model when zero external providers are configured", () => {
      const offlineSelector = new ModelSelector(new Set());

      const decision = offlineSelector.selectModelForTask({
        taskTitle: "Any task in offline mode",
        taskDescription: "No API keys configured",
      });

      expect(decision.model.provider).toBe("mock");
      expect(decision.model.id).toBe("mock-orchestrator-model");
      expect(decision.confidence).toBeGreaterThan(0);
    });
  });
});
