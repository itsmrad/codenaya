import { ImplementationPlan, Subtask } from "../types";

export interface TaskExecutionBatch {
  batchIndex: number;
  mode: "sequential" | "parallel";
  subtasks: Subtask[];
}

/**
 * Determines whether two subtasks have overlapping target or allowed files.
 * Read-only reviewer and exploration tasks do not conflict with each other.
 */
export function hasFileOverlap(taskA: Subtask, taskB: Subtask): boolean {
  const isReadOnlyRole = (role: string) =>
    role.includes("reviewer") || role === "tester" || role === "explorer";

  if (isReadOnlyRole(taskA.role) && isReadOnlyRole(taskB.role)) {
    return false;
  }

  // 1. Direct targetFiles overlap
  if (taskA.targetFiles.length > 0 && taskB.targetFiles.length > 0) {
    const setA = new Set(taskA.targetFiles.map((f) => f.toLowerCase().replace(/\\/g, "/")));
    for (const f of taskB.targetFiles) {
      if (setA.has(f.toLowerCase().replace(/\\/g, "/"))) {
        return true;
      }
    }
  }

  // 2. Direct allowedFiles overlap (for write-capable tasks)
  const allowedA = (taskA.allowedFiles ?? []).filter(Boolean);
  const allowedB = (taskB.allowedFiles ?? []).filter(Boolean);

  if (allowedA.length > 0 && allowedB.length > 0) {
    for (const pathA of allowedA) {
      const normA = pathA.toLowerCase().replace(/\\/g, "/");
      for (const pathB of allowedB) {
        const normB = pathB.toLowerCase().replace(/\\/g, "/");
        if (normA === normB || normA.startsWith(normB) || normB.startsWith(normA)) {
          return true;
        }
      }
    }
  }

  return false;
}

/**
 * Phase 5: Delegate
 * Resolves the dependency graph and groups subtasks into executable batches:
 * - When subtasks are independent AND have no overlapping files, execute them in parallel.
 * - When tasks depend on each other OR modify overlapping files, execute them sequentially.
 */
export function buildExecutionBatches(plan: ImplementationPlan): TaskExecutionBatch[] {
  const batches: TaskExecutionBatch[] = [];
  const completedTaskIds = new Set<string>();
  const remaining = [...plan.subtasks];

  let batchIndex = 0;

  while (remaining.length > 0) {
    // Find all subtasks whose dependencies have all been completed
    const ready = remaining.filter((t) =>
      t.dependencies.every((depId) => completedTaskIds.has(depId))
    );

    if (ready.length === 0) {
      // Cyclic dependency or unsatisfied dependency safety valve
      const fallback = remaining.shift()!;
      batches.push({
        batchIndex: batchIndex++,
        mode: "sequential",
        subtasks: [fallback],
      });
      completedTaskIds.add(fallback.id);
      continue;
    }

    // Check if we have parallel candidates that do NOT overlap with each other
    const parallelCandidates = ready.filter((t) => t.executionMode === "parallel");

    if (parallelCandidates.length > 1) {
      // Filter candidates so no two tasks in the parallel batch modify overlapping files
      const nonConflictingBatch: Subtask[] = [];

      for (const candidate of parallelCandidates) {
        const conflictsWithBatch = nonConflictingBatch.some((selected) =>
          hasFileOverlap(selected, candidate)
        );
        if (!conflictsWithBatch) {
          nonConflictingBatch.push(candidate);
        }
      }

      if (nonConflictingBatch.length > 1) {
        batches.push({
          batchIndex: batchIndex++,
          mode: "parallel",
          subtasks: nonConflictingBatch,
        });

        for (const t of nonConflictingBatch) {
          completedTaskIds.add(t.id);
          const idx = remaining.findIndex((r) => r.id === t.id);
          if (idx !== -1) remaining.splice(idx, 1);
        }
        continue;
      }
    }

    // Otherwise, execute next task sequentially
    const nextTask = ready[0];
    batches.push({
      batchIndex: batchIndex++,
      mode: "sequential",
      subtasks: [nextTask],
    });

    completedTaskIds.add(nextTask.id);
    const idx = remaining.findIndex((r) => r.id === nextTask.id);
    if (idx !== -1) remaining.splice(idx, 1);
  }

  return batches;
}
