# codex-teams vs Claude Code Agent Teams — Findings

## Scope

This report compares:

1. Current `codex-teams` implementation in this repo.
2. Claude Code agent teams behavior from:
   - provided docs (`agent-teams.md`, hooks docs index + reference points),
   - source snapshot in `~/Downloads/src`.

Goal: identify concrete practices, optimizations, and features worth adopting in `codex-teams`.

---

## A) What `codex-teams` currently does well

### 1) Clear orchestration pipeline
- Mission lifecycle is explicit: `executing -> verifying -> fixing -> completed/error`.
- Lead + workers start concurrently (`runMission()`), which minimizes startup latency.
- Verification retry loop exists, with lead-generated fix assignments (`buildFixPrompt` + JSON parsing).

### 2) Strong communication primitives
- Team chat, DMs, lead-only cross-team chat, and shared artifact board are implemented.
- Read cursor model per agent is solid and prevents duplicate unread consumption.
- `wait_for_messages(timeoutMs)` avoids busy polling and supports dissolve signaling.

### 3) Security and access boundaries
- Comms server binds localhost only.
- Agent-bound MCP sessions + token validation for `agent`/`token`.
- Cross-team DM restriction is sensible (only lead-to-lead across teams).

### 4) Operational controls
- Mid-mission steer exists (`/steer` endpoint + `codex-teams steer` command).
- Abort + resend mechanics are present.
- Mission state persistence supports status and steering from separate commands.

### 5) Prompting quality baseline
- Existing lead/worker instruction design already pushes direct worker-to-worker coordination, low-noise chat, and artifact sharing.

---

## B) Gaps vs Claude Code agent teams

## ~~1) Task coordination is not first-class in runtime~~ DONE (Phase 1-2)

`task_create`, `task_list`, `task_claim`, `task_update`, `task_get` tools in `comms-server.ts`; `TaskStore` file-backed with locking.

## 2) No idle-state workflow

Current behavior waits for initial worker result and lead result, but there is no teammate idle protocol:
- no “I’m idle, assign me next task” mechanism,
- no stale-owner reassignment policy,
- no active/idle visibility signal from workers during long missions.

Claude teams implement explicit idle notifications + assignment loop.

## 3) No graceful shutdown handshake

`codex-teams` dissolves and cleans up at mission end, but there is no structured request/approve/reject shutdown protocol per worker.

Claude teams have explicit shutdown request/approval flow and cleanup safety checks when members are still active.

## 4) No hook/event policy gate layer

`codex-teams` lacks extensible policy interception points equivalent to:
- `TaskCreated`,
- `TaskCompleted`,
- `TeammateIdle`.

Claude teams use these to enforce quality/process gates and prevent premature completion.

## 5) Plan approval mode not implemented end-to-end

`codex-teams` supports `sandbox: plan-mode` in config, but no orchestrated plan review protocol:
- no explicit worker plan submission message contract,
- no lead approval/rejection loop with feedback,
- no gated transition from planning to implementation.

Claude teams implement this flow directly.

## 6) Permission relay model is simpler

`codex-teams` currently leans on each agent’s own approval policy.
Claude teams add worker->lead permission relay behavior to reduce fragmented permission prompts and centralize decisions.

## 7) User direct teammate interaction is limited

You can steer agents globally/subset, but not a direct “message teammate X” CLI path analogous to Claude’s direct teammate messaging.

## 8) Verification pattern can be stronger

`codex-teams` has verify-command retries, but does not include an explicit independent verification-agent role with strict evidence format and adversarial checks.

Claude source includes a dedicated verification agent with:
- no project writes,
- explicit command-output evidence requirements,
- hard verdict contract.

## 9) Team sizing/task sizing heuristics are not encoded in runtime

Your docs mention sweet spot sizing, but runtime currently does not auto-suggest/sanitize:
- teammate count based on independent work units,
- tasks-per-worker ratio,
- anti-overparallelization for same-file/sequential workloads.

---

## C) Notable Claude implementation practices worth copying

## 1) Deterministic, lock-safe shared task list
- File-locking around task claim and updates prevents race claims.
- Dependency unblocking integrated into task state transitions.
- Explicit busy-check claim mode avoids one worker owning too many unresolved tasks.

## 2) Team mailbox protocol surface
- Structured messages for:
  - idle notifications,
  - plan approval requests/responses,
  - shutdown requests/responses,
  - permission requests/responses,
  - task assignment notifications.
- This turns “chat” into an operational protocol, not only free text.

## 3) One-team-per-lead and no-nested-team guardrails
- Prevents hierarchy confusion and hidden ownership bugs.
- Makes cleanup semantics tractable.

## 4) Cleanup safety + orphan mitigation
- Refuses cleanup if active members exist.
- Tracks created team resources and performs best-effort session cleanup for orphaned panes/resources.

## 5) Auto-reassignment behavior on member removal
- Unassigns unresolved tasks when a teammate exits/shuts down and emits a reassignment prompt.

## 6) Plan/permission mode propagation and synchronization
- Worker permission/mode state synchronization back to team state.
- Team-wide permission update broadcast support for approved paths.

## 7) Lightweight but useful anti-noise communication norms
- Discourages empty ACK traffic.
- Encourages sparse high-value updates and direct peer DM over lead bottlenecking.

## 8) Dedicated verification specialist
- Strongly-defined anti-patterns and required evidence structure reduce false PASS outcomes.

---

## D) Recommended improvements for `codex-teams` (prioritized)

## P0 — Core coordination upgrade

### P0.1 Expose task tools through team-comms MCP
Add tools:
- `task_create(subject, description, blockedBy?)`
- `task_list()`
- `task_claim(taskId)` (atomic lock)
- `task_update(taskId, status, owner?, blockedBy?/blocks?)`
- `task_get(taskId)`

Back them with existing `TeamManager.tasks` + locking for claim/update safety.

### P0.2 Convert mission runtime to task-driven execution
- Lead creates initial tasks from objective.
- Workers self-claim next unblocked tasks.
- Lead executes own tasks but can be configured to “wait for teammates” during coordination-heavy missions.

### P0.3 Add idle protocol
Worker emits idle signal containing:
- last completed task,
- optional short summary,
- current blocker (if any).

Lead/orchestrator can auto-assign next task or nudge.

## P1 — Reliability + governance

### P1.1 Add graceful shutdown protocol
Add tools/messages for:
- shutdown request (lead/orchestrator -> worker),
- approve/reject (worker -> lead),
- cleanup hard-block if active workers remain.

### P1.2 Add hook/event interception points
Implement pluggable callbacks/events:
- `onTaskCreated`
- `onTaskCompleted`
- `onWorkerIdle`

Allow blocking completion with feedback (same concept as hook exit-code-2 behavior).

### P1.3 Implement plan approval loop for plan-mode workers
Flow:
1. Worker submits structured plan.
2. Lead approves/rejects with feedback.
3. Worker remains in planning until approved.
4. Approved transition switches worker to implementation.

## P2 — Quality and UX

### P2.1 Add independent verifier agent mode
Introduce optional verifier role post-implementation:
- prohibited from project writes,
- must run commands and provide outputs,
- final strict verdict contract (`PASS|FAIL|PARTIAL`) with reproduction evidence.

### P2.2 Add direct per-agent messaging command
New CLI:
- `codex-teams message <missionId> --agent <id> --text "..."`

Useful for precision steering without global redirects.

### P2.3 Add strategy heuristics in launch path
At mission start:
- detect if workload appears sequential/same-file-heavy and warn against overparallelization,
- suggest worker count and task decomposition target.

### P2.4 Improve mission observability payload
Include in status/output:
- task board snapshot,
- worker idle/active status,
- blocked task counts,
- stale task owner duration.

---

## E) Prompting improvements to apply now

1. Explicitly require lead to create first-pass task board in kickoff (not only prose assignment).
2. In worker prompt, add “after completing a task: update task state, then self-claim next unblocked task”.
3. Add “broadcast sparingly” / anti-noise language for group chat.
4. Add “if blocked > X minutes, raise blocker with concrete dependency and fallback work started”.
5. For verification phase, require concrete command-output evidence format, not narrative summaries.

---

## F) Performance/optimization opportunities

1. **Task-level delta updates** instead of full mission snapshot writes on every phase tick.
2. **Structured fix-assignment parsing hardening**:
   - today it regex-extracts `[...]`; can misparse malformed lead output.
   - move to strict JSON contract with fallback retry prompt.
3. **Adaptive wait interval strategy**:
   - `wait_for_messages` already exists; add mission-level orchestration that prefers event-driven wakeups over periodic poll-style behavior.
4. **Failure-domain isolation**:
   - optional per-worker isolated worktree mode for high-conflict code paths.
5. **Auto-reassign stale tasks**:
   - if task owner is error/aborted and task remains unresolved, return to pending and notify team.

---

## G) Suggested implementation order (pragmatic)

1. Task tools + atomic claim/update + mission task loop.
2. Idle protocol + status surfacing + stale reassignment.
3. Shutdown handshake + cleanup guard.
4. Plan approval mode.
5. Hook/event extension points.
6. Independent verifier role.
7. Direct message CLI + optional worktree isolation.

---

## H) Bottom line

`codex-teams` already has strong communication and orchestration foundations.  
The biggest leverage is to make **tasks** the primary execution substrate (with locking, self-claim, idle handling, and policy gates), then layer shutdown/plan/verification workflows on top. That is the main difference between “parallel prompting” and a robust multi-agent operating model.
