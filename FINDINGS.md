# codex-teams vs Claude Code Agent Teams - Findings Snapshot

Date: 2026-04-01

## 1) Current codex-teams behavior (as implemented now)

### Runtime model
- `codex-teams` is a single-run mission orchestrator, not a persistent interactive team session.
- Core flow:
  - create team + agents
  - start local comms MCP server
  - send one prompt to lead and one prompt to each worker in parallel
  - wait for workers, then wait for lead
  - optional verify command + retry loop
  - collect comm logs, dissolve team, cleanup agents, exit
- Key files:
  - `/Users/batricperovic/dev/codex-teams/src/mission.ts`
  - `/Users/batricperovic/dev/codex-teams/src/codex-client.ts`
  - `/Users/batricperovic/dev/codex-teams/src/comms-server.ts`
  - `/Users/batricperovic/dev/codex-teams/src/cli/launch.ts`

### Communication model
- Implemented channels:
  - team group chat
  - DMs
  - cross-team lead chat
  - shared artifacts
  - `wait_for_messages` blocking primitive
- Implemented via in-memory `MessageSystem`; no persistent mailbox files.
- Access control:
  - same-team DMs allowed
  - cross-team DMs allowed only lead<->lead
- Key files:
  - `/Users/batricperovic/dev/codex-teams/src/messages.ts`
  - `/Users/batricperovic/dev/codex-teams/src/comms-server.ts`

### Task model
- `TeamManager` has task CRUD + dependency unblocking in memory.
- But mission flow does not currently use task claiming/self-assignment/task tools.
- No MCP task tools exposed to agents.
- Key file:
  - `/Users/batricperovic/dev/codex-teams/src/state.ts`

### Prompting model
- Lead prompt tells lead to post kickoff plan in group chat and execute own work immediately.
- Worker prompt tells worker to read kickoff plan or start exploring while waiting.
- Strong collaboration rules in `buildInstructions` (noise control, direct coordination, share artifacts, etc.).
- Key files:
  - `/Users/batricperovic/dev/codex-teams/src/mission.ts`
  - `/Users/batricperovic/dev/codex-teams/src/instructions.ts`

### Verification loop
- `--verify` command runs after mission.
- If verify fails: lead asked to emit JSON worker assignments; workers run fixes; re-verify.
- Key file:
  - `/Users/batricperovic/dev/codex-teams/src/mission.ts`

### Persistence
- Mission state persisted minimally to `~/.codex-teams/missions/<id>.json` (for status/steer).
- Team/chat/task state itself is runtime-memory only and dissolved at end.
- Key file:
  - `/Users/batricperovic/dev/codex-teams/src/cli/state-file.ts`

## 2) Claude Code agent-team mechanisms observed (source + docs)

## Shared task list system (file-backed)
- Task list stored per team under `~/.claude/tasks/<taskListId>/`.
- Task files are JSON; status: `pending | in_progress | completed`.
- Dependencies via `blocks` and `blockedBy`.
- Locking:
  - task-level and task-list-level lockfiles to avoid claim/write races.
  - high-water-mark file prevents ID reuse after deletion/reset.
- Claim logic supports:
  - already claimed checks
  - blocked checks
  - optional atomic "agent busy" checks.
- Key files:
  - `/Users/batricperovic/Downloads/src/utils/tasks.ts`
  - `/Users/batricperovic/Downloads/src/tools/TaskCreateTool/TaskCreateTool.ts`
  - `/Users/batricperovic/Downloads/src/tools/TaskUpdateTool/TaskUpdateTool.ts`
  - `/Users/batricperovic/Downloads/src/tools/TaskListTool/TaskListTool.ts`
  - `/Users/batricperovic/Downloads/src/tools/TaskGetTool/TaskGetTool.ts`

## Mailbox protocol (file-backed)
- Per-agent inbox files: `~/.claude/teams/<team>/inboxes/<agent>.json`.
- Message records include `from`, `text`, `timestamp`, `read`, plus color/summary metadata.
- Structured protocol messages include:
  - idle notifications
  - permission requests/responses
  - sandbox permission requests/responses
  - plan approval requests/responses
  - shutdown request/approved/rejected
  - task assignment notifications
  - team permission updates
  - mode set requests
- Locks protect mailbox writes and mark-read operations.
- Key file:
  - `/Users/batricperovic/Downloads/src/utils/teammateMailbox.ts`

## Teammate/team config persistence
- Team config persisted under `~/.claude/teams/<team>/config.json`.
- Tracks members, backend type, pane IDs, mode, active status, etc.
- Cleanup path kills panes first, then removes team + task directories.
- Session-created team tracking exists for orphan cleanup.
- Key file:
  - `/Users/batricperovic/Downloads/src/utils/swarm/teamHelpers.ts`

## Spawn backends + mode handling
- Supports:
  - in-process teammates
  - tmux panes
  - iTerm2 native panes
- Auto-detection and fallback:
  - inside tmux => tmux
  - iTerm2 + it2 => iTerm2
  - fallback to tmux / fallback to in-process in auto mode
- Teammate identity is deterministic and team-scoped.
- Initial instructions delivered via mailbox for pane-based teammates.
- Key files:
  - `/Users/batricperovic/Downloads/src/tools/shared/spawnMultiAgent.ts`
  - `/Users/batricperovic/Downloads/src/utils/swarm/backends/registry.ts`
  - `/Users/batricperovic/Downloads/src/utils/swarm/backends/types.ts`

## SendMessage semantics
- Explicit send tool with:
  - direct teammate routing
  - team broadcast (`to: "*"`)
  - structured protocol handling
  - validation rules (e.g., no structured broadcast)
  - bridge/UDS cross-session support (not core to our use-case)
- Prompt explicitly states plain model text is not inter-agent visible.
- Key files:
  - `/Users/batricperovic/Downloads/src/tools/SendMessageTool/SendMessageTool.ts`
  - `/Users/batricperovic/Downloads/src/tools/SendMessageTool/prompt.ts`
  - `/Users/batricperovic/Downloads/src/utils/swarm/teammatePromptAddendum.ts`

## Hook-based quality gates
- Agent teams expose:
  - `TeammateIdle`
  - `TaskCreated`
  - `TaskCompleted`
- Hooks can block progression and force revisions.
- Sources:
  - `/Users/batricperovic/Downloads/src/entrypoints/sdk/coreSchemas.ts`
  - Claude docs: `https://code.claude.com/docs/en/agent-teams.md`, `https://code.claude.com/docs/en/hooks.md`

## 3) Main gaps in codex-teams vs Claude design

1. No first-class shared task list for workers to self-claim/advance.
2. No file-backed persistence for team/task/message coordination.
3. No structured control protocol (plan-approval/shutdown/idle/task-assignment) in messaging.
4. No graceful teammate shutdown handshake.
5. No teammate plan-approval mode flow.
6. No hookable quality gates tied to teammate idle/task create/task complete.
7. Mission lifecycle is one-shot; team coordination is not long-running / continuously steerable through a shared backlog.
8. No task ownership recovery/unassign behavior when a worker fails/stops mid-mission.

## 4) High-value improvements to port (prioritized)

## P0 (biggest leverage)
1. [substantially done 2026-04-02] Add shared task-list subsystem to codex-teams (file-backed + lock-safe):
   - storage: `~/.codex-teams/tasks/<team-or-mission>/`
   - schema: `id, subject, description, status, owner, blocks, blockedBy`
   - APIs: create/get/list/update/claim/block/delete/reset
   - lock semantics for create + claim + update race safety.
2. [done 2026-04-02] Expose task tools in comms MCP:
   - `task_create`, `task_list`, `task_get`, `task_update`, `task_claim` (or claim via update-owner).
3. Update lead/worker prompts to use task workflow:
   - lead creates initial dependency graph tasks
   - workers self-claim unblocked tasks
   - on completion workers call task update and fetch next.

## P1 (control-plane robustness)
4. [partial 2026-04-02] Introduce structured protocol messages in codex-teams comms:
   - `idle_notification`
   - `plan_approval_request/response`
   - `shutdown_request/approved/rejected`
   - `task_assignment` notice
   - (optionally) permission request/response if needed later.
5. [partial 2026-04-02] Add graceful shutdown path:
   - CLI/lead can request teammate shutdown
   - teammate can approve/reject with reason
   - auto-unassign unresolved owned tasks on teammate termination.
6. [scaffolded 2026-04-02] Add per-worker plan approval mode:
   - worker starts read-only planning
   - current implementation auto-approves via protocol path; manual lead review is not fully implemented.

## P2 (policy + quality)
7. Add hook points (or equivalent callbacks) for:
   - task created
   - task completed
   - worker idle
   - with optional blocking/failure feedback semantics.
8. Add verification-focused policy nudges:
   - when all tasks completed and no verification task exists, require/encourage explicit verify task before final summary.

## 5) Prompting/logic changes worth keeping

1. Explicitly force inter-agent communication channel usage:
   - plain text output does not reach teammates; use team message tools.
2. Keep broadcast expensive and rare:
   - include explicit warning in prompt/tool docs.
3. Encode "when to post" and "when not to post" communication heuristics (already partly present in current instructions).
4. Enforce task-completion honesty:
   - only mark complete when fully done, tests green, no unresolved blockers.
5. Add "after complete -> fetch next task" behavior loop.

## 6) Suggested implementation order for codex-teams

1. Implement `task-store.ts` (file-backed + lock-safe).
2. Add MCP task tools in `comms-server.ts`.
3. Update `buildLeadPrompt` + `buildWorkerPrompt` around task-driven flow.
4. Add structured message helpers in `messages.ts` (or new protocol module).
5. Add shutdown handshake command/tool path.
6. Add plan-approval workflow.
7. Add optional hook runner integration for idle/task events.

## 7) Useful source references already inspected

### codex-teams
- `/Users/batricperovic/dev/codex-teams/src/mission.ts`
- `/Users/batricperovic/dev/codex-teams/src/messages.ts`
- `/Users/batricperovic/dev/codex-teams/src/comms-server.ts`
- `/Users/batricperovic/dev/codex-teams/src/state.ts`
- `/Users/batricperovic/dev/codex-teams/src/instructions.ts`
- `/Users/batricperovic/dev/codex-teams/src/codex-client.ts`
- `/Users/batricperovic/dev/codex-teams/src/cli/launch.ts`
- `/Users/batricperovic/dev/codex-teams/tests/*.test.ts`

### Claude Code source snapshot (`~/Downloads/src`)
- `/Users/batricperovic/Downloads/src/utils/tasks.ts`
- `/Users/batricperovic/Downloads/src/tools/TaskCreateTool/TaskCreateTool.ts`
- `/Users/batricperovic/Downloads/src/tools/TaskUpdateTool/TaskUpdateTool.ts`
- `/Users/batricperovic/Downloads/src/tools/TaskListTool/TaskListTool.ts`
- `/Users/batricperovic/Downloads/src/tools/TaskGetTool/TaskGetTool.ts`
- `/Users/batricperovic/Downloads/src/utils/teammateMailbox.ts`
- `/Users/batricperovic/Downloads/src/tools/SendMessageTool/SendMessageTool.ts`
- `/Users/batricperovic/Downloads/src/tools/shared/spawnMultiAgent.ts`
- `/Users/batricperovic/Downloads/src/utils/swarm/teamHelpers.ts`
- `/Users/batricperovic/Downloads/src/utils/swarm/backends/registry.ts`
- `/Users/batricperovic/Downloads/src/utils/swarm/teammatePromptAddendum.ts`

### Claude docs checked
- https://code.claude.com/docs/llms.txt
- https://code.claude.com/docs/en/agent-teams.md
- https://code.claude.com/docs/en/hooks.md

## 8) Deep-dive addendum (extra pass before compaction)

## Additional codex-teams behavior confirmed

1. Mission completion semantics currently hide failures:
   - lead failure is captured as `leadOutput` text and mission can still finish as `completed`.
   - worker failures are captured per-worker but do not force mission `error`.
   - verification can remain failed at the final attempt and mission still ends `completed`.
2. Orchestration remains one-shot even after steer:
   - `steer` aborts active sends and pushes a new prompt, but there is no shared backlog/task-claim loop to keep re-planning grounded in team state.
3. Runtime control surface is thin:
   - state file stores `missionId/teamId/agentIds/phase/commsPort/pid`, but no persisted ownership/task/message protocol state for robust recovery.
4. Team/task internals are not wired end-to-end:
   - `TeamManager` task APIs exist in-memory, but mission runtime and MCP tool surface still do not use them for first-class claiming/progression.

## Additional Claude mechanisms confirmed in source

1. Deterministic identity and naming:
   - teammate IDs are team-scoped deterministic IDs derived from name + team.
   - duplicate names are auto-suffixed (`name-2`, `name-3`) to avoid collisions.
2. Task store has monotonic IDs:
   - `.highwatermark` prevents task ID reuse after reset/delete.
3. Claiming is race-safe and optionally fairness-safe:
   - task-level lock for basic claim.
   - task-list lock for atomic `agent_busy` check + claim (prevents TOCTOU races).
4. Teammate exit reassigns work:
   - unresolved owned tasks are unassigned and reset to `pending`, with a synthesized leader notification listing affected tasks.
5. Leader/teammate activity state is explicit:
   - members have `isActive` and mode tracked in team config; teammate Stop hook marks idle and sends structured idle notification.
6. Structured protocol routing is explicit:
   - protocol messages are filtered from regular teammate-context attachments and routed to dedicated handlers, avoiding control-plane messages polluting model context.
7. Spawn path includes resilience and context hygiene:
   - auto backend fallback to in-process if pane backends unavailable in auto mode.
   - propagation of key CLI/env settings to spawned teammates (permissions/model/settings/plugins).
   - explicit stripping of parent conversation payload for in-process teammate startup to avoid long-lived memory bloat across clear/compact.
8. Ownership and task UX nudges are built into tools:
   - when teammate sets `in_progress` without owner, owner auto-fills to teammate name.
   - owner change emits `task_assignment` mailbox event.
   - completion result message reminds teammate to call TaskList and take next available work.
9. Task quality gates are enforceable at mutation points:
   - `TaskCreated` and `TaskCompleted` hooks can block create/complete operations.
   - task creation can be rolled back if blocking hooks fail.

## New improvements to port into codex-teams (beyond initial list)

1. Tighten mission success criteria:
   - introduce explicit final status policy (`completed_with_failures` or `error`) when lead/worker/verifier failures remain unresolved.
2. Add monotonic task IDs + lock files:
   - copy high-water mark + lock strategy to avoid ID reuse and claim races across concurrent agents/processes.
3. Add atomic claim modes:
   - standard claim and `checkAgentBusy` claim; prefer `checkAgentBusy` for teammate self-claim loops.
4. Add automatic orphan-task recovery:
   - on teammate abort/shutdown, unassign unresolved tasks, reset to `pending`, and notify lead with exact task list.
5. Separate control-plane from chat payloads:
   - parse/route structured protocol messages before model-visible chat ingestion.
6. Add teammate lifecycle state:
   - maintain `isActive`/`mode`/`backendType` in persisted team state to improve steering, shutdown, and status introspection.
7. Add task-selection heuristics to prompts:
   - prefer lowest unblocked pending task ID first to reduce thrash and keep dependency order stable.
8. Add context hygiene guardrails for in-process agents:
   - avoid passing full parent message history into spawned teammate runtime by default.
9. Add mutation-time hook enforcement:
   - run blocking callbacks/hooks directly on `task_create` and `task_complete`, including rollback on failure.

## Additional source files inspected in deep pass

### codex-teams
- `/Users/batricperovic/dev/codex-teams/src/cli/status.ts`
- `/Users/batricperovic/dev/codex-teams/src/cli/steer.ts`
- `/Users/batricperovic/dev/codex-teams/src/cli/state-file.ts`
- `/Users/batricperovic/dev/codex-teams/src/cli/help.ts`
- `/Users/batricperovic/dev/codex-teams/src/cli/setup.ts`
- `/Users/batricperovic/dev/codex-teams/src/cli/update-check.ts`
- `/Users/batricperovic/dev/codex-teams/src/index.ts`
- `/Users/batricperovic/dev/codex-teams/src/tool-utils.ts`
- `/Users/batricperovic/dev/codex-teams/src/types.ts`
- `/Users/batricperovic/dev/codex-teams/tests/relay.test.ts`
- `/Users/batricperovic/dev/codex-teams/tests/coding-relay.test.ts`
- `/Users/batricperovic/dev/codex-teams/tests/wait.test.ts`

### Claude Code source snapshot (`~/Downloads/src`)
- `/Users/batricperovic/Downloads/src/utils/tasks.ts`
- `/Users/batricperovic/Downloads/src/utils/teammateMailbox.ts`
- `/Users/batricperovic/Downloads/src/utils/swarm/reconnection.ts`
- `/Users/batricperovic/Downloads/src/utils/swarm/teammateInit.ts`
- `/Users/batricperovic/Downloads/src/utils/swarm/permissionSync.ts`
- `/Users/batricperovic/Downloads/src/utils/swarm/teamHelpers.ts`
- `/Users/batricperovic/Downloads/src/tools/shared/spawnMultiAgent.ts`
- `/Users/batricperovic/Downloads/src/tools/SendMessageTool/SendMessageTool.ts`
- `/Users/batricperovic/Downloads/src/tools/TaskCreateTool/prompt.ts`
- `/Users/batricperovic/Downloads/src/tools/TaskUpdateTool/prompt.ts`
- `/Users/batricperovic/Downloads/src/tools/TaskListTool/prompt.ts`

## 9) Deep-dive addendum (compaction checkpoint #2)

### Additional Claude mechanics verified in code (noted after deeper source sweep)

1. Inbox poller is a control-plane router, not just message polling:
   - `useInboxPoller` classifies unread mailbox entries into protocol buckets (`permission_request/response`, `sandbox_permission_*`, `team_permission_update`, `mode_set_request`, `plan_approval_*`, `shutdown_*`) before normal chat delivery.
   - Only non-protocol messages are formatted into model-visible `<teammate-message>` payloads.
   - Message read marking happens after successful submit/queue to reduce loss on busy sessions/crashes.

2. Plan approval lifecycle is wired in two places:
   - Teammate side: accepts `plan_approval_response` only from `team-lead`, then exits plan mode.
   - Leader side: auto-approves `plan_approval_request` in inbox poller, writes response, and updates in-process teammate task state (`awaitingPlanApproval`).

3. Shutdown flow includes leader-side teardown and task recovery:
   - Teammate `shutdown_approved` messages trigger pane kill (when pane metadata exists), teammate removal from team context, and unresolved-task unassignment with explicit notification.
   - On unassign, unresolved owned tasks are reset to `pending` and ownership cleared.

4. Permission delegation is fully dual-path:
   - In-process path: worker permission requests route into leader `ToolUseConfirmQueue` with worker badge and standard tool-specific UI.
   - Fallback path: mailbox request/response loop with callback registry.
   - Also implemented for sandbox network permission requests/responses.

5. Stop-hook enforcement extends to teammate workflow gates:
   - After regular Stop hooks, teammate sessions run `TaskCompleted` hooks for owned `in_progress` tasks, then `TeammateIdle` hooks.
   - Either hook can block continuation (`preventContinuation`) and emit hook-stopped attachments.

6. Backend/mode behavior is snapshot-and-fallback based:
   - `teammateMode` is captured at startup (session snapshot), with explicit CLI override handling.
   - In `auto` mode, pane backend detection can silently fall back to in-process if tmux/iTerm2 backend is unavailable; fallback is sticky for the session.

7. Spawn path preserves environment/config invariants:
   - Teammate spawn forwards key CLI flags (permission mode/model/settings/plugins/chrome) and explicit env vars (provider/proxy/config/session markers).
   - Deterministic teammate IDs + duplicate-name suffixing are enforced before spawn.

8. Team persistence includes lifecycle metadata used by orchestration:
   - Team config tracks `backendType`, `isActive`, and `mode` per member (plus pane IDs, cwd, etc.).
   - Session cleanup path kills orphaned panes first, then removes team/task directories.

### Additional codex-teams gaps confirmed against this deeper pass

1. No protocol demux layer:
   - Current comms messages are all model-visible chat/artifact payloads; no first-class structured control message routing.

2. No reliability semantics for message consumption:
   - No equivalent to "mark read only after successful delivery/queue" to avoid loss during busy states.

3. No permission delegation architecture:
   - No worker->lead permission request bridge (tool/sandbox) and no centralized leader decision queue.

4. No persisted teammate lifecycle metadata:
   - Mission state file has phase/ids/port/pid only; no persisted active/idle/member mode/backend metadata.

5. No teammate-side hook gates on idle/task completion:
   - Verification exists, but there is no hook-driven policy gate tied to teammate idle/completion transitions.

6. No shutdown/termination reconciliation to task ownership in runtime protocol:
   - Prior findings noted unassign need; deeper Claude pass confirms this is central and integrated with user-visible notifications.

### New high-value ideas to port (incremental over previous roadmap)

1. Add inbox/control demultiplexer in codex-teams runtime:
   - Route structured protocol events separately from model chat context; avoid polluting model context with control JSON.

2. Add message-delivery acknowledgement semantics:
   - Mark protocol/chat messages consumed only after successful ingest/queue by recipient loop.

3. Add centralized permission delegation:
   - Worker permission requests (tool and sandbox/network) should surface to lead for decision; response should resume worker flow.

4. Add teammate lifecycle fields to persisted mission/team state:
   - Persist `isActive`, `mode`, backend type, and last-seen timestamps for robust status/steer/recovery.

5. Integrate hookable gates at teammate lifecycle points:
   - Enforce policy at `task_complete` and `teammate_idle` transitions (block/revise semantics).

6. Expand shutdown protocol to include deterministic cleanup behavior:
   - On graceful/forced worker exit: unassign unresolved tasks, notify lead with concrete task IDs/subjects, and update persisted state atomically.

7. Add startup mode snapshot + fallback policy:
   - Resolve teammate execution mode once per mission/session; support explicit fallback when preferred backend is unavailable without half-configured states.

### Additional Claude source files inspected in this pass

- `/Users/batricperovic/Downloads/src/hooks/useInboxPoller.ts`
- `/Users/batricperovic/Downloads/src/hooks/useSwarmPermissionPoller.ts`
- `/Users/batricperovic/Downloads/src/hooks/useSwarmInitialization.ts`
- `/Users/batricperovic/Downloads/src/query/stopHooks.ts`
- `/Users/batricperovic/Downloads/src/utils/inProcessTeammateHelpers.ts`
- `/Users/batricperovic/Downloads/src/utils/swarm/inProcessRunner.ts`
- `/Users/batricperovic/Downloads/src/utils/swarm/backends/registry.ts`
- `/Users/batricperovic/Downloads/src/utils/swarm/backends/detection.ts`
- `/Users/batricperovic/Downloads/src/utils/swarm/backends/types.ts`
- `/Users/batricperovic/Downloads/src/utils/swarm/backends/teammateModeSnapshot.ts`
- `/Users/batricperovic/Downloads/src/utils/swarm/teamHelpers.ts`
- `/Users/batricperovic/Downloads/src/utils/swarm/permissionSync.ts`
- `/Users/batricperovic/Downloads/src/utils/swarm/spawnUtils.ts`
- `/Users/batricperovic/Downloads/src/tools/shared/spawnMultiAgent.ts`
- `/Users/batricperovic/Downloads/src/tools/SendMessageTool/SendMessageTool.ts`
- `/Users/batricperovic/Downloads/src/tools/SendMessageTool/prompt.ts`
- `/Users/batricperovic/Downloads/src/tools/TaskCreateTool/TaskCreateTool.ts`
- `/Users/batricperovic/Downloads/src/tools/TaskCreateTool/prompt.ts`
- `/Users/batricperovic/Downloads/src/tools/TaskUpdateTool/TaskUpdateTool.ts`
- `/Users/batricperovic/Downloads/src/tools/TaskUpdateTool/prompt.ts`
- `/Users/batricperovic/Downloads/src/tools/TaskListTool/TaskListTool.ts`
- `/Users/batricperovic/Downloads/src/tools/TaskListTool/prompt.ts`
- `/Users/batricperovic/Downloads/src/tools/TaskGetTool/TaskGetTool.ts`
- `/Users/batricperovic/Downloads/src/tools/TaskGetTool/prompt.ts`
- `/Users/batricperovic/Downloads/src/utils/tasks.ts`
- `/Users/batricperovic/Downloads/src/utils/teammateMailbox.ts`

## 10) Deep-dive addendum (compaction checkpoint #3)

### Additional Claude mechanics confirmed in this pass

1. Task runtime has a hybrid freshness model, not just file reads:
   - In-process change signal (`notifyTasksUpdated`) for same-process updates.
   - `fs.watch` + debounce for external updates.
   - Fallback poll timer for missed watcher events.
   - Singleton task store to avoid watch/unwatch churn and racey UI behavior.

2. Task list UX has explicit scheduling heuristics:
   - Prompts/tool copy nudge teammates to pick lowest-ID available tasks first.
   - On task completion, `TaskUpdate` appends a direct instruction to call `TaskList` and take next work.
   - Auto-owner assignment when marking `in_progress` without owner (in swarm mode).

3. Task mutation path includes quality and rollback gates:
   - `TaskCreated` hooks can block creation; blocked creates are rolled back (`deleteTask`).
   - `TaskCompleted` hooks can block completion.
   - Blocking hook failures return tool-level failure with explicit feedback.

4. Teammate inbox is treated as a reliability layer:
   - Protocol messages are demuxed first (permission/sandbox/shutdown/mode/team-permission/plan-approval).
   - Messages are marked read only after successful submit/queue to avoid loss during busy/crash windows.
   - Busy sessions queue inbound messages and drain when idle, then remove processed entries.

5. In-process teammate loop is long-lived and priority-aware:
   - Distinguishes lifecycle abort (kill teammate) vs turn abort (interrupt current turn, keep teammate alive).
   - Wait loop prioritizes: shutdown requests -> leader messages -> peer messages -> task claims.
   - Auto-compacts teammate history at token threshold and resets compact/replacement state safely.
   - Sends idle notifications on transition-to-idle (dedupes repeat-idle).

6. Spawn/backends are session-snapshotted with explicit fallback policy:
   - `teammateMode` captured at startup (with CLI override precedence).
   - Auto mode can fallback to in-process if pane backend unavailable; fallback is recorded so UI/behavior stay consistent.
   - Explicit `tmux` mode does not silently fallback (surfaces install/setup errors).

7. Spawn inheritance is explicit and broad:
   - Propagates CLI mode/permissions/model/settings/plugins/chrome flags.
   - Propagates provider/proxy/config env vars needed for teammate correctness in pane shells.
   - Uses deterministic teammate IDs and duplicate-name suffixing.

8. Shutdown and cleanup are integrated with team/task state:
   - Session-level orphan cleanup tracks created teams, kills orphan panes first, then removes team/task dirs.
   - On teammate shutdown approval, leader removes teammate, marks task state terminal, and unassigns unresolved tasks with a synthesized notification payload.

9. SendMessage is constrained as a protocol surface:
   - Structured messages cannot be broadcast.
   - Summary required for plain teammate messages (UI preview discipline).
   - Cross-session bridge/UDS paths have strict validation and reduced message forms.
   - Can route to local in-process agents and auto-resume stopped agents when possible.

10. Teammate hook chain is stronger than basic stop hooks:
    - After Stop hooks, teammate sessions run `TaskCompleted` hooks for owned `in_progress` tasks, then `TeammateIdle` hooks.
    - Either stage can block continuation and emit structured hook-stop attachments.

### Additional codex-teams gaps/risks confirmed in this pass

1. Message reliability semantics are simpler:
   - No persisted read-state acknowledgements; no queued-delivery state that survives process failure.

2. No long-lived teammate loop model:
   - Current mission sends one main prompt per agent (+optional fix prompts) rather than maintaining an idle/claim/respond loop.

3. No first-class control-plane demux:
   - Control intents and regular chat share the same visible channel; no protocol router.

4. No integrated hook gates at task lifecycle points:
   - Verification exists as a post-mission command, but no mutation-time task create/complete gate hooks.

5. No backend mode policy subsystem:
   - No mode snapshot/auto fallback matrix because codex-teams is one-shot and headless, but this also means fewer recovery knobs.

6. Team/task persistence remains minimal:
   - Mission state file does not track teammate active/idle/mode/backend metadata or ownership lineage.

7. DM read-cursor edge case in current implementation:
   - `dm_read(fromAgentId=...)` filters by sender but does not advance read cursor, so repeated filtered reads can re-surface same messages.

### New concrete improvements to port (incremental)

1. Add a robust teammate event loop mode to codex-teams:
   - Idle -> wait_for_messages/task-claim -> execute -> report -> idle; keep workers alive across multiple turns.

2. [partial 2026-04-02] Add durable control inbox with ack semantics:
   - Structured control messages are disk-backed.
   - Current implementation marks messages read on `protocol_read()`, not after confirmed processing/queueing.

3. Add task freshness architecture:
   - File-backed task store + lock-safe mutations + watcher + fallback poll.
   - Internal signal for same-process updates.

4. Add lifecycle gates on task mutations:
   - Hook/callback points on `task_create` and `task_complete` with rollback on blocking failure.

5. Add explicit task scheduling heuristics in prompts/tools:
   - Lowest-ID-first suggestion.
   - Mandatory next-step nudge (`TaskList` after complete).
   - Auto-owner behavior when moving to `in_progress`.

6. Add teammate lifecycle metadata to persisted state:
   - `isActive`, `mode`, last-seen, backend/mode lineage, and terminal reason.

7. Add session cleanup registry:
   - Track mission-created team resources and run deterministic cleanup on abnormal exits (process signal/crash path).

8. Add shutdown protocol parity:
   - Shutdown request/approve/reject flow tied to teammate removal + orphan-task unassignment + clear lead notification.

9. Tighten SendMessage contract in codex-teams comms tools:
   - Distinguish plain vs structured payloads.
   - Disallow protocol broadcast.
   - Require concise summary metadata for better message previews and routing.

10. Fix DM filtered-read cursor behavior:
    - Advance cursor consistently when reading by sender filter, or explicitly track per-peer cursors.

### Additional Claude source files inspected in this pass

- `/Users/batricperovic/Downloads/src/hooks/useTaskListWatcher.ts`
- `/Users/batricperovic/Downloads/src/hooks/useTasksV2.ts`
- `/Users/batricperovic/Downloads/src/hooks/useInboxPoller.ts`
- `/Users/batricperovic/Downloads/src/hooks/useSwarmPermissionPoller.ts`
- `/Users/batricperovic/Downloads/src/hooks/toolPermission/handlers/swarmWorkerHandler.ts`
- `/Users/batricperovic/Downloads/src/hooks/toolPermission/handlers/coordinatorHandler.ts`
- `/Users/batricperovic/Downloads/src/tools/shared/spawnMultiAgent.ts`
- `/Users/batricperovic/Downloads/src/tools/SendMessageTool/SendMessageTool.ts`
- `/Users/batricperovic/Downloads/src/tools/SendMessageTool/prompt.ts`
- `/Users/batricperovic/Downloads/src/tools/TaskCreateTool/TaskCreateTool.ts`
- `/Users/batricperovic/Downloads/src/tools/TaskCreateTool/prompt.ts`
- `/Users/batricperovic/Downloads/src/tools/TaskUpdateTool/TaskUpdateTool.ts`
- `/Users/batricperovic/Downloads/src/tools/TaskUpdateTool/prompt.ts`
- `/Users/batricperovic/Downloads/src/tools/TaskListTool/TaskListTool.ts`
- `/Users/batricperovic/Downloads/src/tools/TaskListTool/prompt.ts`
- `/Users/batricperovic/Downloads/src/tools/TaskGetTool/TaskGetTool.ts`
- `/Users/batricperovic/Downloads/src/query/stopHooks.ts`
- `/Users/batricperovic/Downloads/src/utils/tasks.ts`
- `/Users/batricperovic/Downloads/src/utils/teammateMailbox.ts`
- `/Users/batricperovic/Downloads/src/utils/swarm/permissionSync.ts`
- `/Users/batricperovic/Downloads/src/utils/swarm/inProcessRunner.ts`
- `/Users/batricperovic/Downloads/src/utils/swarm/spawnInProcess.ts`
- `/Users/batricperovic/Downloads/src/utils/swarm/spawnUtils.ts`
- `/Users/batricperovic/Downloads/src/utils/swarm/teamHelpers.ts`
- `/Users/batricperovic/Downloads/src/utils/swarm/reconnection.ts`
- `/Users/batricperovic/Downloads/src/utils/swarm/teammateInit.ts`
- `/Users/batricperovic/Downloads/src/utils/swarm/backends/registry.ts`
- `/Users/batricperovic/Downloads/src/utils/swarm/backends/detection.ts`
- `/Users/batricperovic/Downloads/src/utils/swarm/backends/teammateModeSnapshot.ts`
- `/Users/batricperovic/Downloads/src/utils/swarm/leaderPermissionBridge.ts`

## 11) Deep-dive addendum (compaction checkpoint #4)

### Additional codex-teams behavior confirmed in this pass

1. Mission runtime is fundamentally one-shot orchestration, not an always-on team loop:
   - `runMission()` sends one kickoff prompt to lead and one prompt per worker concurrently, then waits.
   - Post-verification retries are also one-shot task pings (lead emits JSON assignments; workers receive one fix prompt each).
   - There is no persistent teammate idle/claim/respond lifecycle in current codex-teams runtime.

2. Team/task APIs exist but are not integrated into mission orchestration:
   - `TeamManager` has task graph methods (`createTask`, `completeTask`, deps unblocking), but `runMission()` does not use this task graph as a scheduler/control plane.

3. Comms and state durability are minimal and process-local:
   - Message channels are in-memory (`MessageSystem`) with per-channel read cursors; no disk durability/replay if process dies.
   - Mission state file (`~/.codex-teams/missions/*.json`) stores only mission/team IDs, phase, port, pid.
   - No persisted teammate lifecycle fields (`isActive`, mode, backend type, etc.).

4. DM filtered-read behavior is intentionally non-consuming:
   - `dmRead(agentId, fromAgentId)` returns filtered messages without advancing cursor.
   - Tests explicitly assert this behavior; repeated filtered reads can re-surface already seen messages.

5. Steer flow is hard-interrupt + re-prompt:
   - `steerTeam()` aborts target agents, clears locks, posts orchestrator direction-change in group chat, then sends the same steer prompt to each target.

6. Verification/fix loop is loosely typed:
   - Lead is asked for JSON array assignments, parsed with regex + JSON parse and filtered by known worker IDs.
   - No schema-level validation or stronger contract for assignment payload.

7. Existing strengths to keep:
   - Per-agent serialization lock in `CodexClientManager` (`agentLocks`) prevents concurrent prompt interleaving.
   - `wait_for_messages` includes event-driven wake-up and dissolve signaling.

### Additional Claude mechanics confirmed in this pass

1. Identity/context model is explicit and layered:
   - Teammate identity resolution priority: AsyncLocalStorage context (in-process) -> dynamic runtime teammate context -> session/team context fallback.
   - In-process teammate execution uses dedicated `TeammateContext` with its own abort controller and parent session linkage.

2. In-process teammate lifecycle is first-class and long-lived:
   - Separate lifecycle abort vs per-turn abort (`abortController` vs `currentWorkAbortController`).
   - Supports injected user messages while viewing teammate transcript (`pendingUserMessages` queue).
   - Idle callbacks unblock leader waiters (`onIdleCallbacks`) without polling.

3. Teammate wait-loop prioritization is explicit:
   - On each idle cycle: prioritize shutdown requests > leader messages > peer messages > task claiming.
   - Task claiming includes “available task” checks (pending, unowned, unblocked).

4. Teammate memory/perf controls are deliberate:
   - Auto-compact in teammate loop on token threshold, rebuild post-compact context, reset microcompact/replacement state.
   - UI transcript mirror is capped (`TEAMMATE_MESSAGES_UI_CAP=50`) to limit RSS growth.

5. Spawn behavior has robust policy + fallback:
   - Session-snapshotted teammate mode, backend detection, and auto fallback from pane mode to in-process when pane backend unavailable (auto mode only).
   - Explicit mode behavior is preserved (non-auto modes surface hard errors instead of silent fallback).

6. Spawn inheritance is broad and practical:
   - Propagates CLI permission mode, model override, settings path, plugin dirs, chrome flag, and key env vars.
   - Supports deterministic IDs and duplicate-name suffixing (`name`, `name-2`, ...).

7. Team config persistence is richer than docs imply:
   - Member entries include runtime/lifecycle metadata (`backendType`, `isActive`, `mode`, pane IDs, optional worktree/session IDs).
   - Helpers sync active/idle and mode transitions into `config.json`.

8. Session-cleanup reliability is stronger:
   - Session cleanup registry tracks created teams.
   - Cleanup path kills orphan panes first, then removes team/task dirs and worktrees.

9. Mailbox layer acts as protocol transport (not just chat):
   - File-locking on read/write and selective mark-read helpers.
   - Structured protocol message detection to route control-plane payloads away from model context.

10. Inbox poller has reliability semantics:
   - Marks messages read only after successful submit or reliable queueing in app-state inbox.
   - If submit fails due busy/reject, message remains queued and is retried when idle.

11. Permission sync is multi-lane:
   - Primary leader ToolUseConfirm queue path for worker permission requests.
   - Mailbox fallback path for approval/denial and sandbox host-permission requests.

12. SendMessage contract is tightly constrained:
   - `to` must be bare teammate name or `*` (team-only), with stricter cross-session address rules.
   - Plain string messages require `summary` (except specific cross-session paths).
   - Structured messages cannot be broadcast and cannot be sent cross-session.
   - Shutdown response constraints enforced (`to` lead, reject requires reason).
   - Can route to local background agents and auto-resume stopped agents.

13. Task tools include policy gates and behavioral nudges:
   - `TaskCreate`: runs `TaskCreated` hooks; blocked creations are rolled back (`deleteTask`).
   - `TaskUpdate`: runs `TaskCompleted` hooks before completion; blocked completion fails update.
   - Completion result nudges teammates to call `TaskList` for next work.
   - In swarm mode, `in_progress` can auto-assign owner when unset.

14. Teammate stop-chain integration:
   - Stop path runs teammate-specific lifecycle hooks (`TaskCompleted`, `TeammateIdle`) and can block continuation.

### New concrete deltas to port into codex-teams (incremental over prior checkpoints)

1. [scaffolded 2026-04-02] Add a true long-lived teammate loop mode:
   - Prompting now instructs workers to stay alive, wait, re-claim, and continue.
   - Runtime orchestration still remains mission-scoped and one-shot rather than a real event-loop-driven teammate runtime.

2. Add protocol-grade mailbox + demux:
   - Separate structured control traffic (shutdown, mode, approvals, permissions) from regular model-visible chat.
   - Mark-read only after successful delivery/queue.

3. [substantially done 2026-04-03] Add leader-mediated permission bridge:
   - Worker tool/sandbox permission requests routed to leader queue with response callbacks.

4. Add richer persisted team state:
   - Store per-agent `isActive`, `mode`, backend lineage, last-seen, and terminal reason for observability/recovery.

5. [substantially done 2026-04-03] Add task lifecycle hooks and rollback behavior:
   - Blockable hooks at task-create/task-complete.
   - Roll back create on policy failure.
   - TeammateIdle stop-chain hook now blocks continuation on policy failure.

6. Add scheduling heuristics from Claude:
   - Lowest-ID-first default guidance.
   - Completion nudge to immediately fetch next task.
   - Auto-owner assignment when entering `in_progress` without explicit owner.

7. Add cleanup registry + deterministic abnormal-exit cleanup:
   - Track mission-created resources and enforce pane/process kill before deleting metadata/state.

8. Tighten send-message interface contract:
   - Require short summaries for plain teammate messages.
   - Disallow structured broadcast.
   - Validate target identity format strictly.

9. Keep/decide DM filtered-read semantics explicitly:
   - Either keep non-consuming filtered reads as a deliberate feature or add per-peer cursors to avoid accidental reprocessing.

### Additional source files inspected in this pass

- `/Users/batricperovic/dev/codex-teams/src/mission.ts`
- `/Users/batricperovic/dev/codex-teams/src/comms-server.ts`
- `/Users/batricperovic/dev/codex-teams/src/messages.ts`
- `/Users/batricperovic/dev/codex-teams/src/state.ts`
- `/Users/batricperovic/dev/codex-teams/src/codex-client.ts`
- `/Users/batricperovic/dev/codex-teams/src/instructions.ts`
- `/Users/batricperovic/dev/codex-teams/src/cli/launch.ts`
- `/Users/batricperovic/dev/codex-teams/src/cli/state-file.ts`
- `/Users/batricperovic/dev/codex-teams/src/cli/status.ts`
- `/Users/batricperovic/dev/codex-teams/src/cli/steer.ts`
- `/Users/batricperovic/dev/codex-teams/src/cli/help.ts`
- `/Users/batricperovic/dev/codex-teams/src/cli/setup.ts`
- `/Users/batricperovic/dev/codex-teams/src/cli/update-check.ts`
- `/Users/batricperovic/dev/codex-teams/tests/*.test.ts` (full suite re-read)

- `/Users/batricperovic/Downloads/src/utils/teammate.ts`
- `/Users/batricperovic/Downloads/src/utils/teammateContext.ts`
- `/Users/batricperovic/Downloads/src/utils/swarm/constants.ts`
- `/Users/batricperovic/Downloads/src/utils/swarm/teammatePromptAddendum.ts`
- `/Users/batricperovic/Downloads/src/utils/swarm/teamHelpers.ts`
- `/Users/batricperovic/Downloads/src/tools/shared/spawnMultiAgent.ts`
- `/Users/batricperovic/Downloads/src/utils/swarm/inProcessRunner.ts`
- `/Users/batricperovic/Downloads/src/utils/swarm/spawnInProcess.ts`
- `/Users/batricperovic/Downloads/src/tasks/InProcessTeammateTask/InProcessTeammateTask.tsx`
- `/Users/batricperovic/Downloads/src/tasks/InProcessTeammateTask/types.ts`
- `/Users/batricperovic/Downloads/src/hooks/useInboxPoller.ts`
- `/Users/batricperovic/Downloads/src/hooks/useSwarmInitialization.ts`
- `/Users/batricperovic/Downloads/src/utils/swarm/teammateInit.ts`
- `/Users/batricperovic/Downloads/src/utils/swarm/permissionSync.ts`
- `/Users/batricperovic/Downloads/src/hooks/useSwarmPermissionPoller.ts`
- `/Users/batricperovic/Downloads/src/utils/teammateMailbox.ts`
- `/Users/batricperovic/Downloads/src/tools/SendMessageTool/SendMessageTool.ts`
- `/Users/batricperovic/Downloads/src/tools/SendMessageTool/prompt.ts`
- `/Users/batricperovic/Downloads/src/tools/SendMessageTool/UI.tsx`
- `/Users/batricperovic/Downloads/src/tools/TaskCreateTool/TaskCreateTool.ts`
- `/Users/batricperovic/Downloads/src/tools/TaskUpdateTool/TaskUpdateTool.ts`
- `/Users/batricperovic/Downloads/src/tools/TaskListTool/TaskListTool.ts`
- `/Users/batricperovic/Downloads/src/tools/TaskGetTool/TaskGetTool.ts`
- `/Users/batricperovic/Downloads/src/tools/TaskCreateTool/prompt.ts`
- `/Users/batricperovic/Downloads/src/tools/TaskUpdateTool/prompt.ts`
- `/Users/batricperovic/Downloads/src/tools/TaskListTool/prompt.ts`
- `/Users/batricperovic/Downloads/src/tools/TaskGetTool/prompt.ts`

## 12) Deep-dive addendum (compaction checkpoint #5)

### Additional codex-teams behavior confirmed in this pass

1. Team/task model is still mission-scoped, not session-scoped:
   - Our `runMission()` flow remains a bounded kickoff/wait/finalize cycle.
   - No always-on agent lifecycle loop (idle wakeups, persistent claiming cadence, protocol-state transitions).

2. Comms delivery contracts are still chat-first, not protocol-first:
   - We rely on in-memory channels (`messages.ts` / `comms-server.ts`) and prompt-level conventions.
   - No native typed control-plane queueing equivalent to Claude’s permission/sandbox/plan/shutdown lanes.

3. Mission-state persistence still carries minimal execution metadata:
   - `src/cli/state-file.ts` stores mission identifiers and status, but not per-agent runtime mode/backend/liveness fields for robust resume or control.

4. Verification/fix orchestration still depends on weak JSON extraction:
   - `buildFixPrompt` + regex + JSON parse in `runMission()` remains brittle versus schema-constrained contracts.

### Additional Claude mechanisms confirmed in source/docs (new this pass)

1. Backend capability model is explicit and polymorphic (`utils/swarm/backends/types.ts`):
   - Backends declare `supportsHideShow`, pane lifecycle ops, rebalance ops, and availability probes.
   - Execution path can branch by capability, not only backend name.

2. Pane spawn reliability is hardened beyond earlier notes:
   - `TmuxBackend` and `ITermBackend` both serialize pane creation via explicit locks to avoid concurrent split races.
   - `TmuxBackend` adds shell-init delay before command injection so first command is not dropped during shell startup.
   - `ITermBackend` performs dead-session pruning and retry when split target pane no longer exists.

3. Teammate executor abstraction is stronger than “spawn backend” only (`PaneBackendExecutor`, `InProcessBackend`):
   - Unified interface for spawn/send/terminate/kill/isActive.
   - Pane backend termination is mailbox shutdown-request first, hard kill second.
   - Cleanup registry ensures spawned panes are killed on leader exit.

4. Task-list substrate has stronger concurrency semantics than prior checkpoints (`utils/tasks.ts`):
   - Monotonic IDs via high-water-mark file prevent ID reuse after deletes/resets.
   - Optional atomic busy-check claim path (`claimTask(..., { checkAgentBusy: true })`) prevents one teammate from over-claiming.
   - Task-list-level lockfile is explicit and reused across multi-step mutations.

5. Team lifecycle controls are richer (`TeamCreateTool`, `TeamDeleteTool`, `teamHelpers.ts`):
   - One-team-per-leader guard is enforced at create time.
   - Team creation resets/initializes shared task list and binds leader task-list ID to team name.
   - Team delete blocks while active members exist.
   - Session cleanup registry tears down orphan teams on abnormal exit and attempts pane kill before metadata deletion.

6. Team operations UX/control-plane is broader than “message teammates” (`components/teams/TeamsDialog.tsx` + helpers):
   - Lead can kill, request graceful shutdown, prune idle teammates, and batch-cycle teammate permission modes.
   - Mode changes are dual-applied: persisted in team config + sent via mailbox control message.

7. Mailbox protocol is significantly richer than plain DM (`utils/teammateMailbox.ts`):
   - Supports typed messages for permission request/response, sandbox permission request/response, shutdown, plan approvals, mode-set, task-assignment, team permission update.
   - Includes selective mark-read by predicate and structured-protocol detection for demux.
   - Supports short summaries and last-peer-DM summary extraction for concise leader visibility.

8. Inbox delivery reliability pattern is explicit (`hooks/useInboxPoller.ts`):
   - Structured control messages are routed to dedicated handlers/queues.
   - Regular messages: submit immediately if idle, else queue in app-state inbox.
   - Mark-as-read occurs only after successful submit or durable queueing, avoiding loss on busy sessions/crashes.

9. Hook-based governance is deeper than “block completion” (docs + runtime usage):
   - `TaskCreated`, `TaskCompleted`, `TeammateIdle` hooks can reject with exit code 2 (feedback + retry loop) or stop teammate with `{"continue": false, "stopReason": ...}`.
   - `TaskCompleted` fires both on explicit completion and when teammate ends a turn with in-progress tasks.

10. Cost/perf guidance contains concrete operational levers (docs):
   - Agent-team costs scale with active teammates and teammate runtime; idle teammates still consume tokens.
   - Spawn prompts should be minimized because each teammate loads full base context + prompt payload.
   - Plan-mode teammates are documented at ~7x token usage vs standard sessions.

11. Shared task list persistence across sessions is explicitly supported (docs + code):
   - `interactive-mode.md`: task lists persist across compactions and can be shared via `CLAUDE_CODE_TASK_LIST_ID`.
   - Runtime code uses on-disk task directories with lockfile-based mutation discipline.

12. Team-memory subsystem is advanced and security-hardened (new domain but relevant for team coordination):
   - Dual scope memory model (private + team shared).
   - Team memory path validation defends against traversal, encoding tricks, and symlink escape.
   - Sync uses ETag + per-entry checksums, delta upload, conflict retry (412), body-size batching, debounce watcher, and permanent-failure suppression.
   - Client-side secret scanner prevents syncing known credential patterns to shared team memory.

### New deltas to port into codex-teams (incremental over checkpoint #4)

1. Introduce a typed control-plane mailbox contract:
   - Separate chat from protocol messages (permissions, shutdown, plan approvals, mode changes, task assignment events).
   - Add demux and dedicated handlers instead of exposing protocol payloads to model context.

2. Add robust message durability semantics:
   - Persist per-recipient inbox on disk.
   - Mark messages read only after accepted-for-processing (submitted or durably queued), not upon fetch.

3. Add monotonic task IDs + list-level lock discipline:
   - Prevent ID reuse after delete/reset.
   - Add atomic claim path with optional “agent busy” constraint.

4. Add explicit backend capability abstraction for runner modes:
   - Capability flags (`supportsHideShow`, etc.) let control flow adapt safely to mode/backend.
   - Normalize spawn/send/terminate/kill/isActive across backends.

5. Add lead-side teammate lifecycle controls:
   - Kill, graceful shutdown request/approval/rejection flow, idle pruning, and mode cycling per teammate/all teammates.

6. Add session cleanup registry for abnormal exits:
   - Track resources created by mission/session.
   - Kill external workers first, then remove metadata/state/work directories.

7. Add hook integration points for quality gates:
   - Task create/complete and teammate idle gates that can block/retry with structured feedback.

8. Add token-governance heuristics to prompting/orchestration:
   - Keep spawn prompts short and task-scoped.
   - Prefer smaller teammate model defaults where possible.
   - Explicitly retire idle teammates when no further work remains.

9. Consider a scoped shared-memory subsystem (future):
   - Team-shared memory artifacts with secret scanning + conflict-safe sync can reduce repeated rediscovery in long-running teams.

### Additional source files inspected in this pass

- `/Users/batricperovic/dev/codex-teams/src/messages.ts`
- `/Users/batricperovic/dev/codex-teams/src/comms-server.ts`
- `/Users/batricperovic/dev/codex-teams/src/mission.ts`
- `/Users/batricperovic/dev/codex-teams/src/state.ts`
- `/Users/batricperovic/dev/codex-teams/src/cli/state-file.ts`
- `/Users/batricperovic/dev/codex-teams/src/cli/launch.ts`

- `/Users/batricperovic/Downloads/src/utils/swarm/backends/types.ts`
- `/Users/batricperovic/Downloads/src/utils/swarm/backends/PaneBackendExecutor.ts`
- `/Users/batricperovic/Downloads/src/utils/swarm/backends/InProcessBackend.ts`
- `/Users/batricperovic/Downloads/src/utils/swarm/backends/TmuxBackend.ts`
- `/Users/batricperovic/Downloads/src/utils/swarm/backends/ITermBackend.ts`
- `/Users/batricperovic/Downloads/src/utils/swarm/teammateLayoutManager.ts`
- `/Users/batricperovic/Downloads/src/utils/swarm/teammateModel.ts`
- `/Users/batricperovic/Downloads/src/tools/TeamCreateTool/TeamCreateTool.ts`
- `/Users/batricperovic/Downloads/src/tools/TeamCreateTool/prompt.ts`
- `/Users/batricperovic/Downloads/src/tools/TeamDeleteTool/TeamDeleteTool.ts`
- `/Users/batricperovic/Downloads/src/tools/TeamDeleteTool/prompt.ts`
- `/Users/batricperovic/Downloads/src/tools/TaskStopTool/TaskStopTool.ts`
- `/Users/batricperovic/Downloads/src/tools/TaskStopTool/prompt.ts`
- `/Users/batricperovic/Downloads/src/tools/TaskOutputTool/TaskOutputTool.tsx`
- `/Users/batricperovic/Downloads/src/tasks/stopTask.ts`
- `/Users/batricperovic/Downloads/src/utils/tasks.ts`
- `/Users/batricperovic/Downloads/src/utils/teammateMailbox.ts`
- `/Users/batricperovic/Downloads/src/hooks/useInboxPoller.ts`
- `/Users/batricperovic/Downloads/src/context/mailbox.tsx`
- `/Users/batricperovic/Downloads/src/utils/mailbox.ts`
- `/Users/batricperovic/Downloads/src/coordinator/coordinatorMode.ts`
- `/Users/batricperovic/Downloads/src/components/TaskListV2.tsx`
- `/Users/batricperovic/Downloads/src/components/messages/TaskAssignmentMessage.tsx`
- `/Users/batricperovic/Downloads/src/components/teams/TeamStatus.tsx`
- `/Users/batricperovic/Downloads/src/components/teams/TeamsDialog.tsx`
- `/Users/batricperovic/Downloads/src/state/teammateViewHelpers.ts`
- `/Users/batricperovic/Downloads/src/memdir/teamMemPaths.ts`
- `/Users/batricperovic/Downloads/src/memdir/teamMemPrompts.ts`
- `/Users/batricperovic/Downloads/src/utils/teamMemoryOps.ts`
- `/Users/batricperovic/Downloads/src/utils/teamDiscovery.ts`
- `/Users/batricperovic/Downloads/src/services/teamMemorySync/index.ts`
- `/Users/batricperovic/Downloads/src/services/teamMemorySync/watcher.ts`
- `/Users/batricperovic/Downloads/src/services/teamMemorySync/teamMemSecretGuard.ts`
- `/Users/batricperovic/Downloads/src/services/teamMemorySync/secretScanner.ts`
- `/Users/batricperovic/Downloads/src/services/teamMemorySync/types.ts`

### Additional docs inspected in this pass

- `https://code.claude.com/docs/llms.txt`
- `https://code.claude.com/docs/en/agent-teams.md`
- `https://code.claude.com/docs/en/hooks.md`
- `https://code.claude.com/docs/en/costs.md`
- `https://code.claude.com/docs/en/interactive-mode.md`
- `https://code.claude.com/docs/en/how-claude-code-works.md`
- `https://code.claude.com/docs/en/channels.md`


## 13) Deep-dive addendum (compaction checkpoint #6)

This section captures net-new findings from the most recent deep pass that were not yet written into this file before compaction.

### New mechanisms confirmed in Claude source (net-new)

1. Permission routing is a dedicated control plane, not generic chat:
   - `utils/swarm/permissionSync.ts` supports both mailbox-driven permission exchange and legacy file bridges.
   - `hooks/useSwarmPermissionPoller.ts` maintains callback registries for permission and sandbox requests and validates payload shape defensively.
   - `hooks/useInboxPoller.ts` converts teammate permission requests into leader-side approval UX (`ToolUseConfirm`) instead of surfacing raw protocol text.

2. In-process teammate runtime is persistent and event-loop based:
   - `utils/swarm/inProcessRunner.ts` runs a long-lived loop (process prompt -> idle notify -> wait for next action).
   - Wait priority is explicit: shutdown requests, leader messages, peer messages, then optional self-claim from tasks.
   - Compaction summaries are mirrored into task outputs to limit context drift.

3. Task coordination has stronger race-control than basic file locks:
   - `utils/tasks.ts` uses high-water-mark IDs to avoid task ID reuse.
   - `claimTask(..., { checkAgentBusy: true })` supports atomic busy-aware claiming.
   - Team exit paths can unassign tasks and notify the lead so work is re-routable.

4. Team lifecycle protections are explicit:
   - `TeamCreateTool` enforces one-team-per-lead per session context.
   - `TeamDeleteTool` refuses cleanup when non-lead members are still active.
   - `teamHelpers.ts` cleanup attempts runtime/pane teardown before metadata deletion.

5. Mailbox protocol is strongly typed:
   - `utils/teammateMailbox.ts` defines structured messages for permission/sandbox approvals, plan approvals, shutdown, mode changes, task assignment, and idle events.
   - `isStructuredProtocolMessage` prevents control payloads from being treated as normal chat.

6. Hooks are wired directly into team/task lifecycle:
   - `utils/hooks.ts` has dedicated execution points for `TaskCreated`, `TaskCompleted`, and `TeammateIdle`.
   - Exit code `2` blocks progression with feedback; `continue:false` can stop continuation.

7. Prompt-level operational nudges are intentional:
   - Team/task prompts emphasize task-ID order, automatic delivery assumptions, and using task tools for state rather than free-form status chatter.
   - `TaskUpdateTool` nudges teammates to call `TaskList` after completion.

8. Backend abstraction is capability-oriented:
   - `TeammateExecutor` interface (`spawn/send/terminate/kill/isActive`) unifies in-process and pane backends.
   - Detection/registry path supports sticky fallback behavior in auto mode.

### Direct deltas recommended for codex-teams from this pass

1. Add typed protocol lanes separate from chat (permissions/shutdown/plan/mode/task events).
2. Mark mailbox entries read only after successful enqueue/submit.
3. Add monotonic task IDs + optional busy-aware claim.
4. Add explicit teammate lifecycle controls (graceful shutdown, force kill, prune idle, mode broadcast).
5. Add abnormal-exit cleanup registry to tear down workers before deleting state.
6. Add lifecycle hook points for task create/complete and teammate-idle quality gates.
7. Add lightweight prompt nudges (post-completion `TaskList` call, avoid status spam).

### Files covered in that pass

- `/Users/batricperovic/Downloads/src/utils/swarm/permissionSync.ts`
- `/Users/batricperovic/Downloads/src/utils/swarm/leaderPermissionBridge.ts`
- `/Users/batricperovic/Downloads/src/utils/swarm/reconnection.ts`
- `/Users/batricperovic/Downloads/src/utils/swarm/teammateInit.ts`
- `/Users/batricperovic/Downloads/src/utils/swarm/inProcessRunner.ts`
- `/Users/batricperovic/Downloads/src/utils/swarm/spawnInProcess.ts`
- `/Users/batricperovic/Downloads/src/utils/swarm/spawnUtils.ts`
- `/Users/batricperovic/Downloads/src/utils/swarm/teamHelpers.ts`
- `/Users/batricperovic/Downloads/src/utils/swarm/teammateLayoutManager.ts`
- `/Users/batricperovic/Downloads/src/utils/swarm/teammateModel.ts`
- `/Users/batricperovic/Downloads/src/utils/swarm/backends/registry.ts`
- `/Users/batricperovic/Downloads/src/utils/swarm/backends/detection.ts`
- `/Users/batricperovic/Downloads/src/utils/swarm/backends/teammateModeSnapshot.ts`
- `/Users/batricperovic/Downloads/src/utils/swarm/backends/PaneBackendExecutor.ts`
- `/Users/batricperovic/Downloads/src/utils/swarm/backends/InProcessBackend.ts`
- `/Users/batricperovic/Downloads/src/utils/swarm/backends/TmuxBackend.ts`
- `/Users/batricperovic/Downloads/src/utils/swarm/backends/ITermBackend.ts`
- `/Users/batricperovic/Downloads/src/utils/swarm/backends/types.ts`
- `/Users/batricperovic/Downloads/src/utils/swarm/constants.ts`
- `/Users/batricperovic/Downloads/src/utils/teamDiscovery.ts`
- `/Users/batricperovic/Downloads/src/utils/teammateMailbox.ts`
- `/Users/batricperovic/Downloads/src/hooks/useInboxPoller.ts`
- `/Users/batricperovic/Downloads/src/hooks/useSwarmPermissionPoller.ts`
- `/Users/batricperovic/Downloads/src/utils/mailbox.ts`
- `/Users/batricperovic/Downloads/src/context/mailbox.tsx`
- `/Users/batricperovic/Downloads/src/hooks/useMailboxBridge.ts`
- `/Users/batricperovic/Downloads/src/utils/tasks.ts`
- `/Users/batricperovic/Downloads/src/hooks/useTaskListWatcher.ts`
- `/Users/batricperovic/Downloads/src/hooks/useTasksV2.ts`
- `/Users/batricperovic/Downloads/src/tools/TaskCreateTool/TaskCreateTool.ts`
- `/Users/batricperovic/Downloads/src/tools/TaskUpdateTool/TaskUpdateTool.ts`
- `/Users/batricperovic/Downloads/src/tools/TaskListTool/TaskListTool.ts`
- `/Users/batricperovic/Downloads/src/tools/TaskGetTool/TaskGetTool.ts`
- `/Users/batricperovic/Downloads/src/tools/TaskStopTool/TaskStopTool.ts`
- `/Users/batricperovic/Downloads/src/tasks/stopTask.ts`
- `/Users/batricperovic/Downloads/src/tools/TaskOutputTool/TaskOutputTool.tsx`
- `/Users/batricperovic/Downloads/src/utils/task/diskOutput.ts`
- `/Users/batricperovic/Downloads/src/tools/TeamCreateTool/TeamCreateTool.ts`
- `/Users/batricperovic/Downloads/src/tools/TeamDeleteTool/TeamDeleteTool.ts`
- `/Users/batricperovic/Downloads/src/tools/shared/spawnMultiAgent.ts`
- `/Users/batricperovic/Downloads/src/tools/SendMessageTool/SendMessageTool.ts`
- `/Users/batricperovic/Downloads/src/tools/SendMessageTool/prompt.ts`
- `/Users/batricperovic/Downloads/src/utils/swarm/teammatePromptAddendum.ts`
- `/Users/batricperovic/Downloads/src/utils/hooks.ts`
- `/Users/batricperovic/Downloads/src/utils/hooks/hookEvents.ts`
- `/Users/batricperovic/Downloads/src/types/hooks.ts`
- `/Users/batricperovic/Downloads/src/utils/hooks/postSamplingHooks.ts`
- `/Users/batricperovic/Downloads/src/hooks/toolPermission/handlers/swarmWorkerHandler.ts`
- `/Users/batricperovic/Downloads/src/hooks/toolPermission/handlers/coordinatorHandler.ts`
- `/Users/batricperovic/Downloads/src/hooks/toolPermission/handlers/interactiveHandler.ts`
- `/Users/batricperovic/Downloads/src/hooks/toolPermission/PermissionContext.ts`
- `/Users/batricperovic/Downloads/src/components/teams/TeamStatus.tsx`
- `/Users/batricperovic/Downloads/src/components/teams/TeamsDialog.tsx`
- `/Users/batricperovic/Downloads/src/components/TaskListV2.tsx`
- `/Users/batricperovic/Downloads/src/components/messages/TaskAssignmentMessage.tsx`
- `/Users/batricperovic/Downloads/src/hooks/notifs/useTeammateShutdownNotification.ts`
- `/Users/batricperovic/Downloads/src/hooks/useSwarmInitialization.ts`
- `/Users/batricperovic/Downloads/src/hooks/useTeammateViewAutoExit.ts`

## 14) Deep-dive addendum (compaction checkpoint #7)

This section captures net-new findings from a full pass over remaining orchestration code (spawn backends, task locking/watchers, permission/mailbox glue). It is focused on concrete deltas we can apply to codex-teams.

### A) Spawn pipeline has robust inheritance and fallback semantics

1. `spawnMultiAgent` + `spawnUtils` carry forward a lot more runtime state than we currently do:
   - Permission mode inheritance (`--dangerously-skip-permissions`, `--permission-mode acceptEdits|auto`) with plan-mode override safety.
   - CLI model/settings/plugin/chrome flags propagated to teammates.
   - Explicit env forwarding for provider/proxy/remote context (`CLAUDE_CODE_USE_*`, proxy vars, CA cert vars, etc.).
2. `resolveTeammateModel()` handles `"inherit"` correctly (avoids passing literal `inherit` to `--model`).
3. Auto-mode backend fallback is intentionally narrow:
   - If pane backend detection fails and mode is `auto`, fallback to in-process and set sticky `inProcessFallbackActive`.
   - If mode is explicitly `tmux`, errors are surfaced instead of silently falling back.
4. Teammate naming is race-safe-ish and UX-safe:
   - Team-local dedupe with `name-2`, `name-3`, ...
   - Sanitization to remove `@` ambiguity in `agentName@teamName`.

### B) Team lifecycle constraints are explicit and enforceable

1. One-team-per-leader is enforced in `TeamCreateTool` (hard block if already leading a team).
2. Team name collisions are handled by generating a unique slug instead of hard failing.
3. Session cleanup registry prevents orphaned resources:
   - `registerTeamForSessionCleanup` on create.
   - `unregisterTeamForSessionCleanup` on explicit delete.
   - `cleanupSessionTeams` kills panes first, then removes team/tasks/worktrees.
4. `TeamDeleteTool` blocks cleanup while active non-lead members remain.

### C) Task system is stronger than it looks (ID monotonicity + atomic claims)

1. Task IDs are monotonic across resets/deletes via `.highwatermark`:
   - IDs are never reused after reset/cleanup windows.
2. Claiming supports atomic busy checks:
   - `claimTask(..., { checkAgentBusy: true })` uses task-list-level lock to avoid TOCTOU.
3. Blocking semantics are explicit:
   - unresolved `blockedBy` task IDs prevent claim.
4. Ownership/exit handling:
   - `unassignTeammateTasks` resets owner and status to `pending`, then generates a structured reassignment hint.

### D) Task UX/flow control includes anti-race and anti-churn patterns

1. `useTaskListWatcher` avoids Bun fs watcher deadlock patterns:
   - Stabilizes `isLoading`/callback via refs.
   - Avoids per-turn watch/unwatch churn.
2. `useTasksV2` uses a singleton external store:
   - One watcher for all consumers.
   - Debounced updates + fallback poll.
   - Auto-hide completed lists after delay, with safe reset guards.

### E) Permission and mailbox control-plane details

1. `permissionSync` still includes both disk-backed and mailbox-backed flows:
   - Legacy `pending/` + `resolved/` with lock files.
   - New mailbox request/response path for tool permissions and sandbox host approvals.
2. `useSwarmPermissionPoller` has callback registries for both tool permissions and sandbox requests, with validation of incoming `permissionUpdates` before callback dispatch.
3. `useInboxPoller` enforces security/authority checks:
   - Plan approval responses accepted only from `team-lead`.
   - Mode-set requests accepted only from `team-lead`.

### F) SendMessage has stronger routing policy than generic chat

1. Cross-session routing supports `bridge:` and `uds:` (text-only for cross-session).
2. Validation rules prevent protocol misuse:
   - No `@` in `to` (single team/session assumption).
   - Structured messages cannot broadcast.
   - `summary` required for normal string teammate messages.
3. Background-agent path auto-resumes stopped/evicted local agents from transcript when possible.

### G) Backend adapters include practical production guards

1. `PaneBackendExecutor` registers cleanup callbacks to kill spawned panes on leader exit.
2. `TmuxBackend`:
   - Serializes pane creation with lock.
   - Waits for shell init (`200ms`) before command injection.
   - Supports hide/show pane semantics (hidden session).
3. `ITermBackend`:
   - Serializes pane creation.
   - Handles dead targeted sessions by pruning and retrying.
   - Uses forced close (`it2 session close -f`) to avoid confirmation blockers.

### H) Highest-value direct deltas for codex-teams from this addendum

1. Add a strict spawn inheritance layer:
   - permission mode, model, settings, plugin dirs, and key env passthrough.
2. Add monotonic task ID generation with a high-water mark file.
3. Add list-level claim lock with optional agent-busy atomic check.
4. Add session-level cleanup registry to ensure teammate teardown on abnormal exit.
5. Add explicit backend fallback policy:
   - fallback only in auto mode; preserve strict errors in explicit modes.
6. Add watcher/store architecture similar to singleton `useTasksV2` patterns to reduce UI churn and stale state races.
7. Keep protocol messages as typed control-plane events (not plain chat), with source-authority checks (`team-lead` only for privileged transitions).

## 15) Decision Clarifications (for fresh LLM handoff)

1. Is Claude "better" on communication architecture?
   - If durability/correctness under crashes matters more than latency: **yes** (their mailbox/protocol queue approach is stronger).
   - If ultra-low-latency in one live process matters more than durability: in-memory event bus can feel better.
2. For codex-teams specifically:
   - Keep current event-driven wake-up (`wait_for_messages` + listeners) for responsiveness.
   - Add durable persisted message/control storage as source of truth.
   - Treat events as wake-up optimization, not state truth.
3. Net recommendation:
   - Adopt **hybrid** comms architecture:
     - Durable control/data plane (typed protocol + ack/read semantics).
     - Event notifications as fast-path.
   - Do **not** replace multi-team support with Claude’s one-team-per-session constraint.
## 16) Phase 5 implementation record (2026-04-03)

### Scope
Robustness, observability, and success criteria improvements. Pre-audit found that items originally scoped as gaps (signal handlers, auto-owner on in_progress, DM cursor fix, per-agent message CLI) were already implemented in prior phases. Remaining work:

### Changes implemented

1. **Cleanup task recovery on abnormal exit** (`src/cli/runtime-cleanup.ts`):
   - `cleanupMissionRuntime()` now calls `state.unassignTasksForAgent()` for every agent before dissolving team state.
   - Ensures file-backed task store does not retain orphaned in-progress tasks when the process is killed (SIGINT/SIGTERM/crash).
   - Wrapped in try/catch so partial teardown doesn't block remaining cleanup.

2. **`completed_with_failures` mission phase** (`src/mission.ts`, `src/cli/launch.ts`):
   - Added `completed_with_failures` to `MissionPhase` union type.
   - Worker failures no longer throw to the catch block as hard errors. Instead, the mission continues through verification (if configured) and finishes with `completed_with_failures`, preserving all worker results.
   - Verifier PARTIAL verdict now sets `completed_with_failures` instead of throwing, so partial verification is a degraded success, not a fatal error.
   - Launch exit codes: 0 = clean success, 2 = completed with failures, 1 = hard error.
   - Lead failure remains a hard error (phase = `error`).

3. **Task board snapshot in mission state and output** (`src/mission.ts`, `src/cli/launch.ts`):
   - Added `TaskBoardSnapshot` and `TaskBoardEntry` interfaces.
   - `buildTaskBoardSnapshot(taskListId)` reads the file-backed task store and returns all tasks plus summary stats: `{ total, pending, inProgress, completed, blocked }`.
   - `serializeMissionState()` now includes `taskBoard` in the persisted state file, making it available to `codex-teams status`.
   - Launch result JSON includes `taskBoard` for immediate post-mission inspection.

4. **`codex-teams tasks` CLI command** (`src/cli/tasks.ts`):
   - New command: `codex-teams tasks <missionId>` reads the task board from the file-backed store.
   - Supports `--status <pending|in-progress|completed>` and `--owner <agentId>` filters.
   - Outputs JSON with filtered tasks plus full stats.
   - Registered in `src/index.ts` and documented in `src/cli/help.ts`.

### Files modified
- `src/mission.ts` -- new types, `buildTaskBoardSnapshot()`, `completed_with_failures` flow
- `src/cli/runtime-cleanup.ts` -- task unassignment before dissolve
- `src/cli/launch.ts` -- taskBoard in result, exit code 2
- `src/cli/tasks.ts` -- new file
- `src/cli/help.ts` -- tasks command docs, exit code docs
- `src/index.ts` -- register tasks command
- `tests/mission.test.ts` -- updated assertions for new phase semantics

### What was already done (pre-existing)
- Signal handlers (SIGINT/SIGTERM/uncaughtException/unhandledRejection) -- `src/cli/runtime-cleanup.ts`
- Auto-owner on `task_update(status="in-progress")` without explicit owner -- `src/comms-server.ts`
- DM filtered-read cursor advancement -- `src/messages.ts` (readBy.add on filtered reads)
- Direct per-agent messaging CLI -- `src/cli/message.ts` (`codex-teams message`)
- Graceful teammate shutdown CLI -- `src/cli/shutdown.ts` (`codex-teams shutdown`)

### Completed in Phase 5 (2026-04-03)
- TeammateIdle hook fires in `wait_for_messages` timeout path -- `src/comms-server.ts`
- task_update completion nudge ("Call task_list() now...") -- `src/comms-server.ts`
- Auto-shutdown workers when all tasks completed -- `src/comms-server.ts`
- Plan approval routes through lead for review (no more auto-approve) -- `src/comms-server.ts`
- One-team-per-leader guard -- `src/state.ts`
- dissolveTeam blocks while active members exist (force option for cleanup) -- `src/state.ts`
- Updated mission.ts and runtime-cleanup.ts to force-dissolve
- Status CLI task board confirmed working via serializeMissionState()

### Completed in Phase 6 (2026-04-04)
- ~~**Blocked timeout prompt nudge**~~ DONE: Added BLOCKERS section to `src/instructions.ts`.
- ~~**Token-governance heuristics in prompts**~~ DONE: Added to lead section in `src/instructions.ts`.
- ~~**Verification nudge on all-tasks-complete**~~ DONE: `verificationNudge` in `src/comms-server.ts` when 3+ tasks complete without verification task.
- ~~**Stale task owner duration in status output**~~ DONE: `staleDurationMs` on `TaskBoardEntry` in `src/mission.ts`.

### Completed in Phase 7 (2026-04-04)
- ~~**Auto-reassign stale tasks**~~ DONE: `StaleTaskMonitor` in `src/stale-task-monitor.ts`, `--stale-threshold` CLI option. 7 tests.

### Completed in Phase 8 (2026-04-04)
- ~~**Task-level delta updates**~~ DONE: Debounced persistence (`touchMission`/`touchMissionImmediate`), task board cache with 5s TTL in `src/mission.ts`.

### Completed in Phase 9 (2026-04-04)
- ~~**Strategy heuristics in launch path**~~ DONE: `emitLaunchWarnings()` in `src/cli/launch-heuristics.ts`, `--no-hints` flag. 10 tests.

### Completed in Phase 10 (2026-04-04)
- ~~**Orphan cleanup / session cleanup registry**~~ DONE: `purgeOrphanedMissions()` in `src/cli/state-file.ts`, `codex-teams cleanup` CLI, PID liveness check, auto-purge on launch. 6 tests.

### Completed in Phase 11 (2026-04-04)
- ~~**Disk-backed chat channels**~~ DONE: `ChatStore` in `src/chat-store.ts`, JSONL append-only storage, full `MessageSystem` refactor from in-memory to disk-backed.

### Completed in Phase 12 (2026-04-04)
- ~~**Per-worker isolated worktree mode**~~ DONE: `src/worktree.ts` with `createWorktree`, `hasWorktreeChanges`, `removeWorktree`, `mergeWorktreeBranches`. `--isolation worktree` CLI option. Integration-branch merge for `--verify`. Worktree cleanup in finally block and runtime-cleanup. 16 tests.

### Completed in Phase 13 (2026-04-04)
- ~~**Structured fix-assignment parsing hardening**~~ DONE: `extractJsonArray()` in `src/mission.ts` with markdown fence extraction, bracket-match fallback, and `parseFixAssignmentsWithRetry()` that re-prompts lead once on parse failure. 7 tests.
- ~~**Adaptive wait interval strategy**~~ DONE (already implemented): `wait_for_messages` is event-driven via `messages.onMessage()` listener, resolves immediately on relevant messages, timeout is a ceiling not a polling interval.

### Remaining items (future work)
- **Team shared memory subsystem with secret scanning** (Hard, ~2-3 days) -- Persistent dual-scope memory (private + team shared), path traversal defense, ETag sync, delta upload, conflict retry, body-size batching, debounce watcher, and secret scanner preventing credential sync. Currently `share()`/`get_shared()` is in-memory and mission-scoped. Claude implements this as a file-backed key-value store with `readMemory`/`writeMemory` tools, namespace isolation per agent + team-shared scope, body-size limits, and a regex-based secret scanner that blocks writes containing API keys/tokens/passwords.
- **Long-lived agent loop** (Hard, ~2-3 days) -- Claude's agents run in a persistent loop: idle -> claim task -> execute -> report -> idle. codex-teams currently sends one prompt per agent and waits for completion. The long-lived mode (already partially implemented -- workers stay alive and cycle through tasks via `wait_for_messages` + `task_list` + `task_claim`) could be strengthened with explicit orchestrator-side re-prompting when workers go idle, heartbeat monitoring, and automatic recovery when an agent's underlying process dies mid-task.
