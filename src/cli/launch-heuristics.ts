export interface TeamMemberConfig {
  role: string;
  specialization?: string;
  isLead?: boolean;
  reasoningEffort?: string;
  isolation?: string;
}

export interface LaunchHeuristicsInput {
  team: TeamMemberConfig[];
  verify?: string;
  verifier?: string;
}

export function emitLaunchWarnings(input: LaunchHeuristicsInput): string[] {
  const warnings: string[] = [];
  const workers = input.team.filter((m) => !m.isLead);

  if (workers.length > 5) {
    warnings.push(
      `${workers.length} workers: coordination overhead grows superlinearly beyond 5. Consider splitting into multiple missions or narrowing scope per worker.`,
    );
  }

  if (workers.length === 1) {
    warnings.push(
      "Single worker + lead may not justify coordination overhead. Consider running Codex CLI directly for simple tasks.",
    );
  }

  const roleCounts = new Map<string, number>();
  for (const worker of workers) {
    if (worker.specialization) continue;
    const key = worker.role.toLowerCase().trim();
    roleCounts.set(key, (roleCounts.get(key) ?? 0) + 1);
  }
  for (const [role, count] of roleCounts) {
    if (count > 1) {
      warnings.push(
        `${count} workers share role "${role}" with no specialization. They risk overlapping work. Add specialization to differentiate scope.`,
      );
    }
  }

  if (!input.verify && !input.verifier && workers.length >= 2) {
    warnings.push(
      "No --verify or --verifier set with multiple workers. Consider adding verification to catch integration issues.",
    );
  }

  const xhighWorkers = workers.filter((w) => w.reasoningEffort === "xhigh");
  if (xhighWorkers.length >= 4) {
    warnings.push(
      `${xhighWorkers.length} workers at xhigh reasoning multiplies cost significantly. Consider --reasoning high or medium for workers.`,
    );
  }

  const worktreeWorkers = workers.filter((w) => w.isolation === "worktree");
  if (worktreeWorkers.length > 0 && !input.verify && !input.verifier) {
    warnings.push(
      "Worktree isolation without --verify or --verifier: worker changes stay in separate branches. Consider adding verification to catch integration issues.",
    );
  }

  return warnings;
}
