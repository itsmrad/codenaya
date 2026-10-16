import { ImplementationPlan, ModelSelection } from "../types";
import { ModelSelector } from "../models/selector";

/**
 * Phase 4: Select Models
 * Intelligently classifies work and assigns optimal models for each subtask.
 */
export function assignModelsToPlan(
  plan: ImplementationPlan,
  selector: ModelSelector
): { plan: ImplementationPlan; modelAssignments: Map<string, ModelSelection> } {
  const modelAssignments = new Map<string, ModelSelection>();

  const updatedSubtasks = plan.subtasks.map((subtask) => {
    const decision = selector.selectModelForTask({
      taskTitle: subtask.title,
      taskDescription: subtask.description,
      role: subtask.role,
      targetFiles: subtask.targetFiles,
      explicitClassification: {
        complexity: subtask.complexity,
      },
    });

    const selection: ModelSelection = {
      provider: decision.model.provider,
      modelId: decision.model.id,
      tier: decision.model.tier,
      reason: decision.reason,
      expectedOutput: decision.expectedOutput,
      confidence: decision.confidence,
    };

    modelAssignments.set(subtask.id, selection);

    return {
      ...subtask,
      selectedModel: `${selection.provider}:${selection.modelId}`,
    };
  });

  return {
    plan: {
      ...plan,
      subtasks: updatedSubtasks,
    },
    modelAssignments,
  };
}
