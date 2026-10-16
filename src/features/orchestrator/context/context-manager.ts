import {
  AcceptanceCriterion,
  CodebaseInspection,
  Subtask,
  ValidationCheck,
  ValidationResult,
} from "../types";
import { UnderstoodTask } from "../pipeline/1-understand";
import { TrackedRequirement } from "../requirements/types";
import {
  BestResultSnapshot,
  EpistemicEntry,
  EpistemicType,
  TaskContextSnapshot,
  TechStackContext,
} from "./types";
import { GitSafetyState } from "../safety/types";

export class TaskContextManager {
  private projectContext = "";
  private techStack: TechStackContext = {
    framework: "unknown",
    styling: "unknown",
    language: "unknown",
    keyDependencies: {},
  };
  private architecture = "";
  private importantFiles = new Set<string>();
  private existingPatterns = new Set<string>();
  private conventions = new Set<string>();
  private currentTask = {
    prompt: "",
    goal: "",
    domain: "",
    estimatedComplexity: "",
  };
  private requirements: string[] = [];
  private trackedRequirements: TrackedRequirement[] = [];
  private acceptanceCriteria: AcceptanceCriterion[] = [];
  private decisions: string[] = [];
  private knownIssues: string[] = [];
  private activeSubtasks = new Set<string>();
  private completedSubtasks = new Set<string>();
  private testResults: ValidationCheck[] = [];
  private currentImplementation = {
    filesCreated: new Set<string>(),
    filesModified: new Set<string>(),
    filesDeleted: new Set<string>(),
    lastModifiedTimestamp: 0,
  };
  private bestResult?: BestResultSnapshot;
  private gitSafety?: GitSafetyState;
  private epistemicLog: Map<string, EpistemicEntry> = new Map();
  private entryCounter = 0;

  /**
   * Initialize context from initial understood task.
   */
  public initializeFromTask(understood: UnderstoodTask): void {
    this.currentTask = {
      prompt: understood.rawPrompt,
      goal: understood.normalizedGoal,
      domain: understood.domain,
      estimatedComplexity: understood.estimatedComplexity,
    };

    this.projectContext = `Task Goal: "${understood.normalizedGoal}". Domain: ${understood.domain}. Scope: In-scope includes minimal targeted changes, out-of-scope includes unrelated redesigns.`;

    this.addAssumption(
      `Initial task complexity estimated at ${understood.estimatedComplexity}`,
      "understand-phase"
    );
  }

  /**
   * Incorporate codebase inspection.
   * Prevents repeated rediscovery if already established.
   */
  public recordCodebaseInspection(inspection: CodebaseInspection): void {
    const isNew = this.techStack.framework === "unknown";
    const hasAppRouter =
      inspection.existingFiles.some((f) => f.includes("src/app/") || f.includes("app/")) ||
      inspection.patterns.some((p) => p.includes("App Router"));

    const frameworkName =
      inspection.framework === "nextjs"
        ? (hasAppRouter ? "Next.js (App Router)" : "nextjs")
        : inspection.framework;

    this.techStack = {
      framework: frameworkName,
      styling: inspection.styling,
      language: inspection.hasTypeScript ? "TypeScript" : "JavaScript",
      keyDependencies: inspection.packageDependencies,
    };

    this.architecture = `Project Framework: ${inspection.framework}. Styling: ${inspection.styling}. Identified ${inspection.existingFiles.length} files across ${inspection.keyDirectories.join(", ") || "root"}.`;

    inspection.entryPoints.forEach((f) => this.importantFiles.add(f));
    inspection.patterns.forEach((p) => this.existingPatterns.add(p));

    if (isNew) {
      this.addFact(
        `Repository uses ${hasAppRouter ? "Next.js (App Router)" : inspection.framework} with ${inspection.styling} and ${inspection.hasTypeScript ? "TypeScript" : "JavaScript"}`,
        `Detected from package.json and configuration files: ${inspection.entryPoints.join(", ")}`,
        "inspect-phase"
      );
    }
  }

  /**
   * Has this section already been established to avoid redundant rediscovery?
   */
  public hasEstablished(section: "techStack" | "architecture" | "patterns" | "importantFiles"): boolean {
    switch (section) {
      case "techStack":
        return this.techStack.framework !== "unknown";
      case "architecture":
        return this.architecture.length > 0;
      case "patterns":
        return this.existingPatterns.size > 0;
      case "importantFiles":
        return this.importantFiles.size > 0;
      default:
        return false;
    }
  }

  // ─────────────────────────────────────────────────────────────
  // EPISTEMIC CLASSIFICATION
  // Strict rule: Assumptions can NEVER silently become facts!
  // ─────────────────────────────────────────────────────────────

  public addFact(statement: string, evidence: string, source = "orchestrator"): EpistemicEntry {
    if (!evidence || evidence.trim().length === 0) {
      throw new Error(`Cannot record FACT without verifiable ground-truth evidence: "${statement}"`);
    }

    const id = `fact-${++this.entryCounter}`;
    const entry: EpistemicEntry = {
      id,
      type: "FACT",
      statement,
      evidence,
      source,
      createdAt: Date.now(),
      verifiedAt: Date.now(),
    };
    this.epistemicLog.set(id, entry);
    return entry;
  }

  public addAssumption(statement: string, source = "orchestrator"): EpistemicEntry {
    const id = `assumption-${++this.entryCounter}`;
    const entry: EpistemicEntry = {
      id,
      type: "ASSUMPTION",
      statement,
      source,
      createdAt: Date.now(),
    };
    this.epistemicLog.set(id, entry);
    return entry;
  }

  /**
   * Explicitly verify an assumption with evidence, converting it to a FACT.
   * Throws if evidence is missing to prevent silent promotion.
   */
  public verifyAssumption(assumptionId: string, evidence: string): EpistemicEntry {
    const existing = this.epistemicLog.get(assumptionId);
    if (!existing) {
      throw new Error(`Assumption with id '${assumptionId}' not found.`);
    }

    if (existing.type !== "ASSUMPTION") {
      throw new Error(`Entry '${assumptionId}' is not an ASSUMPTION (current type: ${existing.type}).`);
    }

    if (!evidence || evidence.trim().length === 0) {
      throw new Error(`Cannot verify assumption '${assumptionId}' into a FACT without empirical evidence.`);
    }

    const promoted: EpistemicEntry = {
      ...existing,
      type: "FACT",
      evidence,
      verifiedAt: Date.now(),
    };

    this.epistemicLog.set(assumptionId, promoted);
    return promoted;
  }

  public addDecision(statement: string, rationale?: string, source = "orchestrator-lead"): EpistemicEntry {
    const id = `decision-${++this.entryCounter}`;
    const entry: EpistemicEntry = {
      id,
      type: "DECISION",
      statement: rationale ? `${statement} (Rationale: ${rationale})` : statement,
      source,
      createdAt: Date.now(),
    };
    this.epistemicLog.set(id, entry);
    this.decisions.push(entry.statement);
    return entry;
  }

  public addOpenQuestion(question: string, source = "orchestrator"): EpistemicEntry {
    const id = `question-${++this.entryCounter}`;
    const entry: EpistemicEntry = {
      id,
      type: "OPEN_QUESTION",
      statement: question,
      source,
      createdAt: Date.now(),
    };
    this.epistemicLog.set(id, entry);
    this.knownIssues.push(`[OPEN QUESTION] ${question}`);
    return entry;
  }

  public resolveOpenQuestion(questionId: string, answer: string, evidence?: string): EpistemicEntry {
    const existing = this.epistemicLog.get(questionId);
    if (!existing || existing.type !== "OPEN_QUESTION") {
      throw new Error(`Question '${questionId}' not found or not an OPEN_QUESTION.`);
    }

    const resolved: EpistemicEntry = {
      ...existing,
      type: evidence ? "FACT" : "DECISION",
      statement: `Resolved Question: "${existing.statement}" -> Answer: "${answer}"`,
      evidence,
      verifiedAt: evidence ? Date.now() : undefined,
    };

    this.epistemicLog.set(questionId, resolved);
    return resolved;
  }

  public addVerifiedResult(statement: string, evidence: string, source = "tester"): EpistemicEntry {
    const id = `result-${++this.entryCounter}`;
    const entry: EpistemicEntry = {
      id,
      type: "VERIFIED_RESULT",
      statement,
      evidence,
      source,
      createdAt: Date.now(),
      verifiedAt: Date.now(),
    };
    this.epistemicLog.set(id, entry);
    return entry;
  }

  // ─────────────────────────────────────────────────────────────
  // SUBTASK & IMPLEMENTATION TRACKING
  // ─────────────────────────────────────────────────────────────

  public recordPlan(
    requirements: string[],
    criteria: AcceptanceCriterion[],
    subtasks: Subtask[],
    trackedRequirements?: TrackedRequirement[]
  ): void {
    this.requirements = [...requirements];
    this.acceptanceCriteria = [...criteria];
    if (trackedRequirements && trackedRequirements.length > 0) {
      this.trackedRequirements = trackedRequirements.map((r) => ({ ...r }));
    }
    this.activeSubtasks.clear();
    this.completedSubtasks.clear();

    subtasks.forEach((s) => {
      if (s.status === "COMPLETED" || s.status === "ACCEPTED") {
        this.completedSubtasks.add(s.id);
      } else {
        this.activeSubtasks.add(s.id);
      }
    });

    this.addDecision(
      `Approved implementation plan comprising ${subtasks.length} subtasks and ${criteria.length} acceptance criteria.`,
      "Decomposed based on dependency tree and allowed file boundaries."
    );
  }

  public recordTrackedRequirements(tracked: TrackedRequirement[]): void {
    this.trackedRequirements = tracked.map((r) => ({ ...r }));
  }

  public getTrackedRequirements(): TrackedRequirement[] {
    return this.trackedRequirements.map((r) => ({ ...r }));
  }

  public updateSubtaskState(subtaskId: string, status: Subtask["status"]): void {
    if (status === "ACCEPTED" || status === "COMPLETED") {
      this.activeSubtasks.delete(subtaskId);
      this.completedSubtasks.add(subtaskId);
    } else if (status === "RUNNING" || status === "PENDING" || status === "BLOCKED") {
      this.activeSubtasks.add(subtaskId);
      this.completedSubtasks.delete(subtaskId);
    } else {
      this.activeSubtasks.delete(subtaskId);
    }
  }

  public recordImplementationChanges(changes: {
    filesCreated?: string[];
    filesModified?: string[];
    filesDeleted?: string[];
  }): void {
    changes.filesCreated?.forEach((f) => {
      this.currentImplementation.filesCreated.add(f);
      this.importantFiles.add(f);
    });
    changes.filesModified?.forEach((f) => {
      this.currentImplementation.filesModified.add(f);
      this.importantFiles.add(f);
    });
    changes.filesDeleted?.forEach((f) => {
      this.currentImplementation.filesDeleted.add(f);
      this.importantFiles.delete(f);
    });
    this.currentImplementation.lastModifiedTimestamp = Date.now();
  }

  public recordValidationResults(result: ValidationResult): void {
    this.testResults = result.checks;
    if (!result.passed) {
      result.errors.forEach((err) => {
        if (!this.knownIssues.includes(err)) {
          this.knownIssues.push(`[VALIDATION ERROR] ${err}`);
        }
      });
    } else {
      this.addVerifiedResult(
        `All ${result.checks.length} validation checks passed.`,
        "Automated static analysis, brace checking, and JSON parsing."
      );
    }
  }

  public recordBestResult(score: number, summary: string): void {
    const filesTouched = [
      ...Array.from(this.currentImplementation.filesCreated),
      ...Array.from(this.currentImplementation.filesModified),
    ];

    if (!this.bestResult || score > this.bestResult.score) {
      this.bestResult = {
        score,
        summary,
        timestamp: Date.now(),
        filesTouched,
      };

      this.addVerifiedResult(
        `New best implementation state recorded with score ${score}/100: ${summary}`,
        `Validated against ${this.acceptanceCriteria.length} acceptance criteria.`
      );
    }
  }

  public recordGitSafety(state: GitSafetyState): void {
    this.gitSafety = { ...state };
    if (state.protectedFiles && state.protectedFiles.length > 0) {
      this.addFact(
        `Git safety system registered ${state.protectedFiles.length} protected pre-existing user files.`,
        `Git status inspection: ${state.protectedFiles.slice(0, 3).join(", ")}`,
        "git-safety"
      );
    }
  }

  public recordDiscovery(discovery: {
    statement: string;
    type?: EpistemicType;
    evidence?: string;
    source?: string;
    category?: "pattern" | "convention" | "file" | "issue" | "architecture";
  }): EpistemicEntry {
    const type = discovery.type ?? (discovery.evidence ? "FACT" : "ASSUMPTION");
    const source = discovery.source ?? "discovery";

    let entry: EpistemicEntry;
    if (type === "FACT") {
      entry = this.addFact(discovery.statement, discovery.evidence ?? "Empirical codebase discovery", source);
    } else if (type === "ASSUMPTION") {
      entry = this.addAssumption(discovery.statement, source);
    } else if (type === "DECISION") {
      entry = this.addDecision(discovery.statement, undefined, source);
    } else if (type === "OPEN_QUESTION") {
      entry = this.addOpenQuestion(discovery.statement, source);
    } else {
      entry = this.addVerifiedResult(discovery.statement, discovery.evidence ?? "Empirical test confirmation", source);
    }

    if (discovery.category === "pattern") {
      this.existingPatterns.add(discovery.statement);
    } else if (discovery.category === "convention") {
      this.conventions.add(discovery.statement);
    } else if (discovery.category === "file") {
      this.importantFiles.add(discovery.statement);
    } else if (discovery.category === "issue") {
      this.knownIssues.push(discovery.statement);
    }

    return entry;
  }

  public recordImportantFiles(files: string[]): void {
    files.forEach((f) => this.importantFiles.add(f));
  }

  public recordExistingPatterns(patterns: string[]): void {
    patterns.forEach((p) => this.existingPatterns.add(p));
  }

  public recordConventions(conventions: string[]): void {
    conventions.forEach((c) => this.conventions.add(c));
  }

  public recordKnownIssues(issues: string[]): void {
    issues.forEach((issue) => {
      if (!this.knownIssues.includes(issue)) {
        this.knownIssues.push(issue);
      }
    });
  }

  // ─────────────────────────────────────────────────────────────
  // SCOPED CONTEXT DELEGATION (TOKEN CONSERVING)
  // When delegating work, provide each sub-agent only the context relevant to its task.
  // ─────────────────────────────────────────────────────────────

  public getScopedContextForSubagent(subtask: Subtask): string {
    const role = subtask.role;
    const parts: string[] = [];

    parts.push(`## SCOPED SUBTASK CONTEXT: [${role.toUpperCase()}]`);
    parts.push(`Objective: ${subtask.objective ?? subtask.description}`);
    parts.push(`Allowed Files: ${(subtask.allowedFiles ?? []).join(", ") || "General project space"}`);

    // Constraints
    if (subtask.constraints && subtask.constraints.length > 0) {
      parts.push(`Constraints:\n${subtask.constraints.map((c) => `- ${c}`).join("\n")}`);
    }

    // Role-specific tailored facts
    if (role === "frontend-engineer" || role === "ux-reviewer") {
      parts.push(`Tech Stack: Framework=${this.techStack.framework}, Styling=${this.techStack.styling}`);
      const uiPatterns = Array.from(this.existingPatterns).filter(
        (p) => p.includes("shadcn") || p.includes("Tailwind") || p.includes("React") || p.includes("UI")
      );
      if (uiPatterns.length > 0) {
        parts.push(`UI Patterns: ${uiPatterns.join("; ")}`);
      }
    } else if (role === "backend-engineer" || role === "database-engineer") {
      parts.push(`Tech Stack: Framework=${this.techStack.framework}, Language=${this.techStack.language}`);
      const beFiles = Array.from(this.importantFiles).filter(
        (f) => f.includes("schema") || f.includes("api") || f.includes("convex")
      );
      if (beFiles.length > 0) {
        parts.push(`Relevant Backend/Data Files: ${beFiles.join(", ")}`);
      }
    } else if (role === "debugger") {
      parts.push(`Known Issues & Defects:\n${this.knownIssues.slice(-5).map((i) => `- ${i}`).join("\n") || "No known issues recorded"}`);
    } else if (role === "security-reviewer") {
      const securityDecisions = this.decisions.filter((d) => d.toLowerCase().includes("security") || d.toLowerCase().includes("auth"));
      if (securityDecisions.length > 0) {
        parts.push(`Security Decisions: ${securityDecisions.join("; ")}`);
      }
    } else if (role === "performance-reviewer") {
      parts.push(`Performance Context: Framework=${this.techStack.framework}`);
      const perfPatterns = Array.from(this.existingPatterns).filter((p) => p.toLowerCase().includes("perf") || p.toLowerCase().includes("bundle"));
      if (perfPatterns.length > 0) {
        parts.push(`Performance Patterns: ${perfPatterns.join("; ")}`);
      }
    } else if (role === "tester") {
      parts.push(`Acceptance Criteria to Verify:\n${this.acceptanceCriteria.map((c) => `- [${c.id}] ${c.description}`).join("\n")}`);
    } else if (role === "explorer") {
      parts.push(`Project Overview: ${this.projectContext}`);
      parts.push(`Entry Points: ${Array.from(this.importantFiles).slice(0, 5).join(", ")}`);
    } else if (role === "architect") {
      parts.push(`Architecture: ${this.architecture}`);
      parts.push(`Tech Stack: Framework=${this.techStack.framework}, Language=${this.techStack.language}`);
    }

    // Relevant Recent Decisions
    if (this.decisions.length > 0) {
      parts.push(`Relevant Architectural Decisions: ${this.decisions.slice(-3).join("; ")}`);
    }

    return parts.join("\n\n");
  }

  // ─────────────────────────────────────────────────────────────
  // COMPACT PERSISTENT EXPORT (ALL 16 SECTIONS)
  // ─────────────────────────────────────────────────────────────

  public toCompactString(): string {
    const lines: string[] = ["# PERSISTENT TASK & PROJECT CONTEXT"];

    // 1. PROJECT_CONTEXT
    lines.push(`## PROJECT_CONTEXT\n${this.projectContext || "None"}`);

    // 2. TECH_STACK
    lines.push(
      `## TECH_STACK\nFramework: ${this.techStack.framework} | Styling: ${this.techStack.styling} | Language: ${this.techStack.language}`
    );

    // 3. ARCHITECTURE
    lines.push(`## ARCHITECTURE\n${this.architecture || "None established yet"}`);

    // 4. IMPORTANT_FILES
    lines.push(
      `## IMPORTANT_FILES\n${this.importantFiles.size > 0 ? Array.from(this.importantFiles).join(", ") : "None"}`
    );

    // 5. EXISTING_PATTERNS
    lines.push(
      `## EXISTING_PATTERNS\n${this.existingPatterns.size > 0 ? Array.from(this.existingPatterns).join("; ") : "None"}`
    );

    // 6. CONVENTIONS
    lines.push(
      `## CONVENTIONS\n${this.conventions.size > 0 ? Array.from(this.conventions).join("; ") : "None"}`
    );

    // 7. CURRENT_TASK
    lines.push(
      `## CURRENT_TASK\nGoal: "${this.currentTask.goal}" (Complexity: ${this.currentTask.estimatedComplexity}, Domain: ${this.currentTask.domain})`
    );

    // 8. REQUIREMENTS
    if (this.trackedRequirements.length > 0) {
      const table = [
        "| REQUIREMENT_ID | DESCRIPTION | STATUS | IMPLEMENTATION | VERIFICATION | EVIDENCE |",
        "| --- | --- | --- | --- | --- | --- |",
        ...this.trackedRequirements.map(
          (r) =>
            `| ${r.id} | ${r.description.replace(/\|/g, "\\|")} | ${r.status} | ${(r.implementation || "Pending").slice(0, 40)} | ${(r.verification || "Pending").slice(0, 40)} | ${(r.evidence || "None").slice(0, 40)} |`
        ),
      ].join("\n");
      lines.push(`## REQUIREMENTS\n${table}`);
    } else if (this.requirements.length > 0) {
      lines.push(`## REQUIREMENTS\n${this.requirements.map((r) => `- ${r}`).join("\n")}`);
    } else {
      lines.push("## REQUIREMENTS\nNone");
    }

    // 9. ACCEPTANCE_CRITERIA
    lines.push(
      `## ACCEPTANCE_CRITERIA\n${this.acceptanceCriteria.length > 0 ? this.acceptanceCriteria.map((c) => `- [${c.status.toUpperCase()}] ${c.id}: ${c.description}`).join("\n") : "None"}`
    );

    // 10. DECISIONS
    lines.push(
      `## DECISIONS\n${this.decisions.length > 0 ? this.decisions.map((d) => `- ${d}`).join("\n") : "None"}`
    );

    // 11. KNOWN_ISSUES
    lines.push(
      `## KNOWN_ISSUES\n${this.knownIssues.length > 0 ? this.knownIssues.map((i) => `- ${i}`).join("\n") : "None"}`
    );

    // 12. ACTIVE_SUBTASKS
    lines.push(
      `## ACTIVE_SUBTASKS\n${Array.from(this.activeSubtasks).join(", ") || "None"}`
    );

    // 13. COMPLETED_SUBTASKS
    lines.push(
      `## COMPLETED_SUBTASKS\n${Array.from(this.completedSubtasks).join(", ") || "None"}`
    );

    // 14. TEST_RESULTS
    if (this.testResults.length > 0) {
      const passedCount = this.testResults.filter((c) => c.status === "passed").length;
      lines.push(
        `## TEST_RESULTS\n${passedCount}/${this.testResults.length} checks passed.`
      );
    } else {
      lines.push("## TEST_RESULTS\nNo test results recorded");
    }

    // 15. CURRENT_IMPLEMENTATION
    lines.push(
      `## CURRENT_IMPLEMENTATION\nCreated: ${this.currentImplementation.filesCreated.size} | Modified: ${this.currentImplementation.filesModified.size} | Deleted: ${this.currentImplementation.filesDeleted.size}`
    );

    // 16. BEST_RESULT
    if (this.bestResult) {
      lines.push(
        `## BEST_RESULT\nScore: ${this.bestResult.score}/100. ${this.bestResult.summary}`
      );
    } else {
      lines.push("## BEST_RESULT\nNone recorded yet");
    }

    // Git Safety Summary
    if (this.gitSafety) {
      lines.push(
        `## GIT_SAFETY\nBaseline: ${this.gitSafety.baseline ? "Established" : "None"} | Current: ${this.gitSafety.currentVersion?.name || "None"} | Best: ${this.gitSafety.bestVersion?.name || "None"} | Protected Files: ${this.gitSafety.protectedFiles.length} | Experiments: ${this.gitSafety.experiments.length} | Rollbacks: ${this.gitSafety.rollbacks.length}`
      );
    }

    // Epistemic Log Summary
    const factsCount = Array.from(this.epistemicLog.values()).filter((e) => e.type === "FACT").length;
    const assumptionsCount = Array.from(this.epistemicLog.values()).filter((e) => e.type === "ASSUMPTION").length;
    lines.push(`## EPISTEMIC_SUMMARY\nFacts: ${factsCount} | Unverified Assumptions: ${assumptionsCount}`);

    return lines.join("\n\n");
  }

  public getSnapshot(): TaskContextSnapshot {
    return {
      projectContext: this.projectContext,
      techStack: { ...this.techStack },
      architecture: this.architecture,
      importantFiles: Array.from(this.importantFiles),
      existingPatterns: Array.from(this.existingPatterns),
      conventions: Array.from(this.conventions),
      currentTask: { ...this.currentTask },
      requirements: [...this.requirements],
      trackedRequirements: this.trackedRequirements.map((r) => ({ ...r })),
      acceptanceCriteria: [...this.acceptanceCriteria],
      decisions: [...this.decisions],
      knownIssues: [...this.knownIssues],
      activeSubtasks: Array.from(this.activeSubtasks),
      completedSubtasks: Array.from(this.completedSubtasks),
      testResults: [...this.testResults],
      currentImplementation: {
        filesCreated: Array.from(this.currentImplementation.filesCreated),
        filesModified: Array.from(this.currentImplementation.filesModified),
        filesDeleted: Array.from(this.currentImplementation.filesDeleted),
        lastModifiedTimestamp: this.currentImplementation.lastModifiedTimestamp,
      },
      bestResult: this.bestResult ? { ...this.bestResult } : undefined,
      gitSafety: this.gitSafety ? { ...this.gitSafety } : undefined,
      epistemicLog: Array.from(this.epistemicLog.values()),
    };
  }

  public getEpistemicEntries(type?: EpistemicType): EpistemicEntry[] {
    const all = Array.from(this.epistemicLog.values());
    return type ? all.filter((e) => e.type === type) : all;
  }
}
