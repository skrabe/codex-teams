# TODO — Remaining Claude Alignment Work

**STATUS: ALL PHASES COMPLETE (2026-04-07)**

The major Claude alignment buckets have been implemented:
- runtime sophistication (worker event loop with priority ordering, interruption model)
- sync-depth features (repo-scoped local memory with watcher/debounce, conflict detection)

This file is now historical documentation. New work should be tracked separately.

---

## Implementation History

### Completed 2026-04-07

1. **runtime sophistication** - Worker loop now has:
   - explicit runtime phase tracking (running_turn, idle_waiting, shutdown_requested, recovering, terminated)
   - event priority ordering (shutdown > lead message > peer message > task claiming)
   - turn-level interruption (turnInterruptSignal separate from lifecycle abort)
   - idle transition notifications with task state summary
   - continuation prompts for lead_message, peer_message, interrupted, recovery, tasks_available

2. **sync-depth features** - Team memory now has:
   - local repo-scoped sync model (not remote/server-backed)
   - watcher/debounce infrastructure (fs.watch with 2s debounce)
   - checksum + revision per entry (sha256 content hash, monotonic revision)
   - conflict detection via MemoryConflictError with expectedRevision/expectedChecksum guards
   - sync index persistence (.sync-index.json) for quick delta detection
   - failure suppression (repeated identical sync failures suppressed after 3 occurrences)

### Previously Completed

- reliability polish (recovery classification, structured task recovery, cleanup guarantees)
- richer state / delivery semantics (protocol inboxes with leased/delivered/read states, control-plane metadata)

### Current repo state

- file-backed shared task list
- task tools in MCP
- task-driven prompts
- protocol messages
- graceful shutdown tooling
- plan approval flow
- permission relay
- verifier agent
- heuristics
- stale task reassignment
- cleanup/orphan handling
- team memory store with secret scanning + sync-depth (watcher, checksums, conflicts)
- orchestrator-side long-lived worker loop with event priority
- worker turn interruption model
- idle transition semantics with control-plane notifications

---

## Original Claude Alignment Sections (Historical)

The following sections document what was analyzed from Claude sources and implemented in codex-teams. They are kept for reference but all marked COMPLETE.

### 1) Runtime sophistication [COMPLETE 2026-04-07]

**Implemented:**
- Worker runtime phases: `running_turn`, `idle_waiting`, `shutdown_requested`, `recovering`, `terminated`
- Event priority: shutdown > lead message > peer message > task claiming
- Turn-level interruption via `turnInterruptSignal` separate from lifecycle `signal`
- Idle transition notifications with active/last-completed task context
- Priority-aware continuation prompts (lead_message, peer_message, interrupted)

**Files:**
- `src/worker-loop.ts` - Main worker event loop with priority selection
- `src/mission.ts` - `buildContinuationPrompt()` with new reentry reasons
- `tests/worker-loop.test.ts` - Priority and interruption tests

### 2) Reliability polish [COMPLETE]

**Previously implemented:**
- Recovery classification (heartbeat_timeout, thread_invalid, aborted, permission_wait_abort)
- Structured task recovery with cause metadata
- Cleanup guarantees (idempotent, deterministic order)
- Graceful vs forced termination tracking

### 3) Richer state / delivery semantics [COMPLETE]

**Previously implemented:**
- Protocol inboxes with leased/delivered/read states
- Control-plane state in mission agent snapshots
- Busy-recipient queue semantics (messages stay leased until ack)
- Rich lifecycle metadata (recoveryAttempts, lastRecoveryReason, lastRecoveryAt, terminalReason)

### 4) Sync-depth features [COMPLETE 2026-04-07]

**Product decision:** Local repo-scoped sync model (not remote/server-backed)

**Implemented:**
- `TeamMemorySyncModel` type with `local_machine` | `local_repo_scoped`
- Watcher-based sync: `fs.watch()` on memory directories with recursive option
- Debounced reindexing: 2s debounce, batched updates
- Checksums: `sha256:<hex>` per entry content
- Revisions: monotonic integer per entry (increments on content change)
- Conflict detection: `MemoryConflictError` with `expectedRevision` / `expectedChecksum` guards
- Sync index: `.sync-index.json` with entry checksums/revisions for fast delta detection
- Failure suppression: identical errors suppressed after 3 occurrences

**Files:**
- `src/team-memory.ts` - Store with sync infrastructure
- `src/comms-server.ts` - MCP tools expose checksum/revision in responses
- `src/instructions.ts` - Updated guidance for conflict-aware memory usage
- `src/cli/launch.ts` - Repo-scoped memory initialization
- `tests/team-memory.test.ts` - Conflict and sync tests

---

## Definition of done (achieved)

- [x] Each section revisited against current Claude source
- [x] Implementation matches intended product model (local-first, repo-scoped)
- [x] Tests exist for new semantics (worker priority, interruption, memory conflicts)
- [x] Build passes
- [x] Full test suite passes for modified modules
- [x] Status/runtime output remains understandable to operators

## Tradeoffs documented

**Sync model:** Chose local repo-scoped over Claude's remote server-backed model. Reason: codex-teams is a headless CLI tool; remote sync would require auth infrastructure, org management, and server APIs that don't exist in this context. The local model still provides conflict detection and sync semantics appropriate for single-machine, multi-session usage within the same repo.

**Worker runtime:** Kept orchestrator-mediated loop rather than full in-process runtime. Reason: Codex CLI spawns external processes; we cannot maintain persistent in-process runtime like Claude's teammate tasks. The priority-ordered event loop provides similar behavioral alignment within architectural constraints.

---

## Ground rules for the next agent

Before implementing anything in this file:

1. Re-read current codex-teams sources:
   - `src/worker-loop.ts`
   - `src/mission.ts`
   - `src/messages.ts`
   - `src/protocol-inbox-store.ts`
   - `src/codex-client.ts`
   - `src/state.ts`
   - `src/team-memory.ts`
   - `src/cli/state-file.ts`
   - `src/cli/runtime-cleanup.ts`

2. Re-read Claude sources relevant to the section you are touching.

3. Do not assume this document is still current if the code has changed.

4. Prefer behavioral alignment over literal API cloning.

5. Preserve current strengths:
   - task store correctness
   - verification flow
   - permission relay
   - clear CLI surface
   - machine-readable JSON output

---

# 1) Runtime sophistication

## Why this remains

We now have `src/worker-loop.ts`, but it is still an **orchestrator-side re-prompt loop**.

That means:

- worker finishes a Codex turn
- orchestrator checks for remaining work
- orchestrator sends another prompt

Claude’s runtime is deeper:

- the teammate process/runtime itself stays alive
- it transitions idle/working internally
- it prioritizes incoming events
- it supports interruption semantics more cleanly
- it keeps its own loop-local context and waiting state

General alignment exists, but runtime sophistication is still behind.

## Claude trail to inspect yourself

Primary:

- `/Users/batricperovic/Downloads/src/utils/swarm/inProcessRunner.ts`
- `/Users/batricperovic/Downloads/src/utils/swarm/spawnInProcess.ts`
- `/Users/batricperovic/Downloads/src/utils/swarm/teammateInit.ts`
- `/Users/batricperovic/Downloads/src/hooks/useInboxPoller.ts`
- `/Users/batricperovic/Downloads/src/utils/swarm/reconnection.ts`

Secondary:

- `/Users/batricperovic/Downloads/src/utils/teammateContext.ts`
- `/Users/batricperovic/Downloads/src/utils/teammate.ts`
- `/Users/batricperovic/Downloads/src/tasks/InProcessTeammateTask/types.ts`

## Current codex-teams files to inspect

- `src/worker-loop.ts`
- `src/mission.ts`
- `src/codex-client.ts`
- `src/messages.ts`
- `src/protocol-inbox-store.ts`

## What to implement

### 1.1 Introduce a real worker event loop abstraction

Today:

- `runWorkerLoop()` sends prompts repeatedly from orchestrator logic

Target:

- move from “re-prompt after each turn” toward “worker runtime waits for next actionable event”
- centralize loop state and decision logic in one place

At minimum, the loop should explicitly support:

- current turn running
- idle waiting
- shutdown requested
- recovering
- terminated

### 1.2 Add event priority instead of plain “do work if tasks remain”

Claude prioritizes roughly:

1. shutdown request
2. lead message
3. peer message
4. task claiming

Our current loop mostly checks:

- shutdown present?
- tasks remain?

What to add:

- priority ordering for next action
- avoid claiming new work if a lead directive or shutdown is waiting
- do not let background task discovery outrank control-plane events

### 1.3 Improve interruption model

Claude distinguishes:

- stop current turn
- stop entire teammate lifecycle

We currently mostly have:

- abort agent
- recover / restart loop

Desired improvement:

- separate “interrupt current Codex call” from “kill the whole worker lifecycle”
- avoid turning every interruption into a recovery path

### 1.4 Improve continuation context handling

Current continuation prompts are better than before, but still simplistic.

Look at Claude’s re-entry behavior and tighten:

- what exact context is replayed
- what should be fetched live
- what should not be repeated to avoid token bloat

### 1.5 Add cleaner idle transition semantics

The worker should not just “finish and get re-prompted”.
It should have an explicit idle state transition with:

- last completed task
- summary
- whether it is blocked, available, or interrupted

This may remain orchestrator-mediated, but the semantics should be explicit.

## Acceptance criteria

- workers react to control-plane events before opportunistic new task work
- shutdown request always outranks task claiming
- lead-directed changes are handled before new autonomous claims
- current-turn interruption does not necessarily force full worker recovery
- continuation prompts remain compact and scoped
- tests cover priority ordering and interruption behavior

---

# 2) Reliability polish (completed 2026-04-07)

## Why this remains

We now have the major pieces, but Claude is still stronger in failure handling and operational resilience.

Examples:

- better cleanup guarantees
- better retry / recovery semantics
- better separation of lifecycle states
- more careful handling of partially delivered control events

This bucket is about making the system less fragile under:

- process death
- partial failure
- timing races
- operator interruptions
- protocol backlog

## Claude trail to inspect yourself

Primary:

- `/Users/batricperovic/Downloads/src/utils/swarm/teamHelpers.ts`
- `/Users/batricperovic/Downloads/src/utils/swarm/reconnection.ts`
- `/Users/batricperovic/Downloads/src/utils/swarm/permissionSync.ts`
- `/Users/batricperovic/Downloads/src/hooks/useInboxPoller.ts`
- `/Users/batricperovic/Downloads/src/hooks/useSwarmPermissionPoller.ts`

Secondary:

- `/Users/batricperovic/Downloads/src/utils/swarm/backends/PaneBackendExecutor.ts`
- `/Users/batricperovic/Downloads/src/utils/swarm/backends/InProcessBackend.ts`
- `/Users/batricperovic/Downloads/src/tools/TeamDeleteTool/TeamDeleteTool.ts`

## Current codex-teams files to inspect

- `src/worker-loop.ts`
- `src/codex-client.ts`
- `src/cli/runtime-cleanup.ts`
- `src/cli/state-file.ts`
- `src/stale-task-monitor.ts`
- `src/state.ts`
- `src/mission.ts`

## What to implement

### 2.1 Tighten worker recovery behavior

Current recovery is heartbeat-based and useful, but minimal.

Improve:

- distinguish transient timeout vs dead thread vs invalid thread vs explicit abort
- record recovery reason more precisely
- avoid unnecessary thread resets
- surface recovery attempts more clearly in mission state

### 2.2 Make task recovery notifications more structured

Today task recovery exists, but the notification model is still lightweight.

Add:

- exact recovered task IDs
- previous owner
- cause (`shutdown`, `timeout`, `runtime_cleanup`, `manual_unassign`)
- lead-facing summary in a consistent format

### 2.3 Strengthen abnormal-exit cleanup guarantees

Re-check:

- mission crash
- SIGINT
- SIGTERM
- uncaught rejection
- partial teardown

Ensure:

- tasks are always unassigned before team dissolve
- protocol/chat/task artifacts are cleaned in deterministic order
- cleanup is idempotent

### 2.4 Improve shutdown path semantics

We have shutdown, but Claude is richer around graceful vs forced transitions.

Add explicit distinction between:

- graceful retirement
- forced termination
- timeout while waiting for graceful exit

Track terminal reason consistently.

### 2.5 Improve lifecycle consistency

Audit all agent lifecycle updates in:

- `codex-client.ts`
- `mission.ts`
- `worker-loop.ts`
- `state.ts`

There should be no ambiguous or stale combinations like:

- `status=idle` but `isActive=true` longer than intended
- `lifecycle=terminated` while still eligible for new prompt

## Acceptance criteria

- cleanup is idempotent and deterministic
- recovery events are precise and observable
- recovered tasks carry structured cause metadata
- graceful vs forced termination is visible in state/output
- lifecycle transitions are consistent across modules

---

# 3) Richer state / delivery semantics (completed 2026-04-07)

## Why this remains

This is one of the biggest remaining Claude deltas.

We have:

- disk-backed protocol inboxes
- chat persistence
- delivery + ack for protocol

But Claude is still stronger in:

- control-plane demux
- read-after-accepted-for-processing semantics
- queued delivery when recipient is busy
- richer persisted teammate lifecycle metadata

This category is less about new user-facing features and more about **truthfulness of runtime state**.

## Claude trail to inspect yourself

Primary:

- `/Users/batricperovic/Downloads/src/utils/teammateMailbox.ts`
- `/Users/batricperovic/Downloads/src/hooks/useInboxPoller.ts`
- `/Users/batricperovic/Downloads/src/hooks/useSwarmPermissionPoller.ts`
- `/Users/batricperovic/Downloads/src/utils/swarm/teamHelpers.ts`

Secondary:

- `/Users/batricperovic/Downloads/src/context/mailbox.tsx`
- `/Users/batricperovic/Downloads/src/utils/mailbox.ts`
- `/Users/batricperovic/Downloads/src/state/teammateViewHelpers.ts`

## Current codex-teams files to inspect

- `src/messages.ts`
- `src/protocol-inbox-store.ts`
- `src/chat-store.ts`
- `src/mission.ts`
- `src/cli/state-file.ts`
- `src/cli/status.ts`
- `src/types.ts`

## What to implement

### 3.1 Add a real control-plane demux model

Today protocol exists, but it is still mostly a read/ack tool surface.

Improve the runtime so structured protocol events are treated as first-class routed events:

- shutdown
- permission request / response
- sandbox permission request / response
- plan approval request / response
- task assignment
- idle notification

Do not rely only on the model noticing them by reading protocol payloads.

### 3.2 Change delivery semantics from “read” to “accepted for processing”

Claude’s important reliability property:

- messages are not considered consumed just because they were fetched
- they are marked read only after they are actually accepted into the next processing step

Audit our current semantics in:

- `src/protocol-inbox-store.ts`
- `src/messages.ts`

Improve toward:

- fetched
- delivered
- accepted / queued
- read

Exact naming can differ; behavior matters more than naming.

### 3.3 Add busy-recipient queue semantics

If a recipient is busy:

- don’t lose or prematurely clear control messages
- keep them queued for next idle transition

This is especially important for:

- shutdown
- permission response
- plan approval response

### 3.4 Persist richer teammate lifecycle metadata

Current mission state is useful, but still thinner than Claude’s team config.

Add or enrich persisted fields such as:

- `isActive`
- `lifecycle`
- `lastSeenAt`
- `terminalReason`
- recovery attempts
- last delivery / last processed protocol time

Only add what actually improves status, steer, and recovery.

Do not add fake metadata with no operational value.

### 3.5 Audit DM and chat delivery semantics

Protocol got attention first, but normal DM/group delivery should also be reviewed:

- when does a message become “read”?
- do we need accepted/queued semantics for non-protocol channels?
- where is current behavior good enough vs overkill?

This does not need to become a full Claude mailbox clone.
But review it explicitly rather than assuming it is fine.

## Acceptance criteria

- protocol events are routed as control-plane, not just raw messages
- protocol items are not considered consumed before actual acceptance/queueing
- busy recipients do not lose control events
- persisted mission state becomes more operationally truthful
- status output reflects real lifecycle and recent activity meaningfully

---

# 4) Sync-depth features

## Why this remains

This is mainly about **team memory depth**.

We now have:

- dual-scope memory
- path validation
- secret scanning
- local storage
- CRUD/search tools

Claude goes much further:

- watcher/debounce sync pipeline
- checksums / ETags
- conflict retry
- batching
- failure suppression
- stronger notion of project-shared memory as a synced system

If we want only local mission/team memory, current implementation may be enough.
If we want Claude-level “shared team memory” behavior, this is the remaining gap.

## Claude trail to inspect yourself

Primary:

- `/Users/batricperovic/Downloads/src/services/teamMemorySync/index.ts`
- `/Users/batricperovic/Downloads/src/services/teamMemorySync/watcher.ts`
- `/Users/batricperovic/Downloads/src/services/teamMemorySync/types.ts`
- `/Users/batricperovic/Downloads/src/services/teamMemorySync/teamMemSecretGuard.ts`
- `/Users/batricperovic/Downloads/src/services/teamMemorySync/secretScanner.ts`

Secondary:

- `/Users/batricperovic/Downloads/src/memdir/teamMemPaths.ts`
- `/Users/batricperovic/Downloads/src/memdir/teamMemPrompts.ts`
- `/Users/batricperovic/Downloads/src/utils/teamMemoryOps.ts`
- `/Users/batricperovic/Downloads/src/utils/teamDiscovery.ts`

## Current codex-teams files to inspect

- `src/team-memory.ts`
- `src/secret-scanner.ts`
- `src/comms-server.ts`
- `src/instructions.ts`
- `src/cli/launch.ts`

## What to implement

### 4.1 Decide the intended sync model explicitly

Before coding, answer:

- Is team memory only local to this machine/repo execution environment?
- Or should it synchronize across sessions/users in a more Claude-like way?

Do not implement deep sync without a clear target model.

This is the one section where you must decide product intent before porting mechanics.

### 4.2 If sync is desired, add watcher/debounce infrastructure

Claude has a watcher-driven sync pipeline.

If we choose to deepen this feature:

- watch memory directories
- debounce updates
- prepare sync payloads
- avoid repeated full rescans on every write

### 4.3 Add change identity / conflict semantics

If multiple writers or sessions are possible, add:

- revision / checksum markers
- conflict detection
- retry behavior

Do not blindly copy Claude’s exact remote sync scheme if the backend model differs.

### 4.4 Add robust failure handling for sync path

If sync exists:

- avoid permanent noisy retries
- suppress repeated identical failures after threshold
- surface enough diagnostics for operator debugging

### 4.5 Revisit memory prompt / usage guidance

After any sync-depth changes, revisit:

- `src/instructions.ts`

Make sure the instructions still describe reality:

- what is private
- what is team-shared
- what is durable
- what should never be saved

## Acceptance criteria

- sync model is explicitly chosen, not accidental
- if sync is implemented, it has watcher/debounce/conflict behavior appropriate to the chosen model
- failures in the memory sync path are bounded and observable
- memory instructions match actual behavior

---

# Suggested implementation order

Updated order from current state:

1. runtime sophistication
2. sync-depth features

Reason:

- delivery semantics and reliability baseline are already in place
- runtime sophistication is now the highest remaining execution gap
- memory sync depth remains the most product-dependent and can wait

---

# Definition of done for this file

You can consider this TODO complete only when:

- each section above has been revisited against current Claude source
- the implementation matches the intended product model, not cargo-culted Claude internals
- tests exist for the new semantics
- build and full test suite pass
- status / runtime output remain understandable to operators

If you make tradeoffs, write them down clearly in `FINDINGS.md` or a follow-up internal note so the next agent does not have to rediscover them.
