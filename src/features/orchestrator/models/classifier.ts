import { TaskComplexity } from "../types";
import { ModelSelectionInput, TaskCategory, WorkClassification } from "./types";

export class WorkClassifier {
  /**
   * Classify work across all 8 dimensions based on task title, description, role, and context.
   */
  public classify(input: ModelSelectionInput): WorkClassification {
    const text = `${input.taskTitle} ${input.taskDescription}`.toLowerCase();
    const role = input.role;

    // 1. Detect Category
    const category = input.category ?? this.detectCategory(text, role);

    // 2. Derive Complexity
    let complexity: TaskComplexity = "medium";
    if (
      category === "architecture" ||
      category === "large-refactor" ||
      category === "security-analysis" ||
      category === "difficult-reasoning"
    ) {
      complexity = "critical";
    } else if (
      category === "complex-debugging" ||
      category === "difficult-implementation" ||
      category === "final-code-review"
    ) {
      complexity = "high";
    } else if (
      category === "simple-edit" ||
      category === "formatting" ||
      category === "file-searching" ||
      category === "straightforward-fix"
    ) {
      complexity = "low";
    } else if (
      category === "repository-exploration" ||
      category === "repetitive-implementation"
    ) {
      complexity = "low";
    }

    // 3. Derive Reasoning Requirements
    let reasoningRequirements: WorkClassification["reasoningRequirements"] = "moderate";
    if (
      category === "architecture" ||
      category === "difficult-reasoning" ||
      category === "complex-debugging" ||
      category === "security-analysis"
    ) {
      reasoningRequirements = "intensive";
    } else if (
      category === "large-refactor" ||
      category === "difficult-implementation" ||
      category === "final-code-review"
    ) {
      reasoningRequirements = "deep";
    } else if (
      category === "simple-edit" ||
      category === "formatting" ||
      category === "file-searching" ||
      category === "straightforward-fix"
    ) {
      reasoningRequirements = "minimal";
    }

    // 4. Derive Coding Difficulty
    let codingDifficulty: WorkClassification["codingDifficulty"] = "standard";
    if (category === "difficult-implementation" || category === "large-refactor") {
      codingDifficulty = "expert";
    } else if (
      category === "complex-debugging" ||
      category === "security-analysis" ||
      category === "architecture"
    ) {
      codingDifficulty = "challenging";
    } else if (
      category === "simple-edit" ||
      category === "formatting" ||
      category === "file-searching"
    ) {
      codingDifficulty = "trivial";
    }

    // 5. Derive Context Size
    let contextSize: WorkClassification["contextSize"] = "small";
    const fileCount = input.targetFiles?.length ?? 0;
    if (
      category === "repository-exploration" ||
      category === "large-refactor" ||
      fileCount > 15 ||
      text.includes("entire project") ||
      text.includes("whole codebase")
    ) {
      contextSize = "massive";
    } else if (
      category === "architecture" ||
      category === "final-code-review" ||
      fileCount > 5
    ) {
      contextSize = "large";
    } else if (fileCount > 1 || category === "complex-debugging") {
      contextSize = "medium";
    }

    // 6. Derive Required Accuracy
    let requiredAccuracy: WorkClassification["requiredAccuracy"] = "high";
    if (
      category === "security-analysis" ||
      category === "architecture" ||
      category === "large-refactor"
    ) {
      requiredAccuracy = "critical";
    } else if (
      category === "repository-exploration" ||
      category === "file-searching" ||
      category === "formatting"
    ) {
      requiredAccuracy = "tolerant";
    }

    // 7. Derive Speed Requirements
    let speedRequirements: WorkClassification["speedRequirements"] = "normal";
    if (
      category === "file-searching" ||
      category === "repository-exploration" ||
      category === "simple-edit" ||
      category === "straightforward-fix"
    ) {
      speedRequirements = "immediate";
    } else if (category === "formatting" || category === "repetitive-implementation") {
      speedRequirements = "high";
    } else if (
      category === "architecture" ||
      category === "security-analysis" ||
      category === "difficult-reasoning"
    ) {
      speedRequirements = "low"; // Thorough deliberate reasoning is preferred
    }

    // 8. Derive Expected Impact
    let expectedImpact: WorkClassification["expectedImpact"] = "component";
    if (
      category === "architecture" ||
      category === "large-refactor" ||
      category === "security-analysis"
    ) {
      expectedImpact = "system-wide";
    } else if (
      category === "simple-edit" ||
      category === "formatting" ||
      category === "straightforward-fix" ||
      category === "file-searching"
    ) {
      expectedImpact = "isolated";
    }

    // 9. Derive Cost Sensitivity
    let costSensitivity: WorkClassification["costSensitivity"] = "balanced";
    if (
      category === "simple-edit" ||
      category === "formatting" ||
      category === "file-searching" ||
      category === "repository-exploration" ||
      category === "repetitive-implementation"
    ) {
      costSensitivity = "budget-conscious";
    } else if (
      category === "architecture" ||
      category === "security-analysis" ||
      category === "large-refactor" ||
      category === "final-code-review"
    ) {
      costSensitivity = "quality-first";
    }

    // Apply explicit overrides if provided
    return {
      complexity: input.explicitClassification?.complexity ?? complexity,
      reasoningRequirements:
        input.explicitClassification?.reasoningRequirements ?? reasoningRequirements,
      codingDifficulty:
        input.explicitClassification?.codingDifficulty ?? codingDifficulty,
      contextSize: input.explicitClassification?.contextSize ?? contextSize,
      requiredAccuracy:
        input.explicitClassification?.requiredAccuracy ?? requiredAccuracy,
      speedRequirements:
        input.explicitClassification?.speedRequirements ?? speedRequirements,
      expectedImpact:
        input.explicitClassification?.expectedImpact ?? expectedImpact,
      costSensitivity:
        input.explicitClassification?.costSensitivity ?? costSensitivity,
      category,
    };
  }

  /**
   * Intelligently infer the task category from task description and role.
   */
  private detectCategory(text: string, role?: string): TaskCategory {
    // 1. Role-specific indicators
    if (role === "reviewer" || text.includes("final code review") || text.includes("review implementation")) {
      return "final-code-review";
    }

    if (role === "architect" || text.includes("architectural alignment") || text.includes("system architecture")) {
      return "architecture";
    }

    // 2. High-reasoning categories
    if (
      /\b(security|vulnerability|audit|auth|ssrf|credential|injection|permission|privilege)\b/i.test(text)
    ) {
      return "security-analysis";
    }

    if (
      /\b(refactor|overhaul|restructure|redesign architecture|migrate|migration)\b/i.test(text)
    ) {
      return "large-refactor";
    }

    if (
      /\b(debug|root cause|race condition|deadlock|leak|intermittent|flaky|troubleshoot)\b/i.test(text)
    ) {
      return "complex-debugging";
    }

    if (
      /\b(algorithm|concurrency|distributed|formal verification|complex logic|graph|planner)\b/i.test(text)
    ) {
      return "difficult-reasoning";
    }

    if (
      /\b(complex implementation|multi-component|full-stack feature|workflow orchestration)\b/i.test(text)
    ) {
      return "difficult-implementation";
    }

    // 3. Fast / lightweight categories
    if (
      /\b(format|formatting|prettier|eslint|whitespace|indent|lint fix)\b/i.test(text)
    ) {
      return "formatting";
    }

    if (
      /\b(typo|rename|spelling|title change|button label|color change)\b/i.test(text)
    ) {
      return "simple-edit";
    }

    if (
      /\b(fix syntax|1-line fix|missing import|quick fix|one-line|straightforward fix)\b/i.test(text)
    ) {
      return "straightforward-fix";
    }

    if (
      /\b(find file|search|grep|locate symbol|check file existence)\b/i.test(text)
    ) {
      return "file-searching";
    }

    if (
      /\b(explore|inspect directory|list files|scan repository|discover files)\b/i.test(text)
    ) {
      return "repository-exploration";
    }

    if (
      /\b(boilerplate|scaffold|crud template|boilerplate generation|mirror schema)\b/i.test(text)
    ) {
      return "repetitive-implementation";
    }

    return "general";
  }
}
