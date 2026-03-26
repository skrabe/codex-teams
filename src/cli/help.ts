import type { Command } from "commander";

const ORCHESTRATOR_GUIDE = `# codex-teams — CLI for multi-agent coding missions

## What it does
codex-teams orchestrates teams of Codex CLI agents. You describe an objective, it creates
a team (lead + workers), they communicate via group chat and DMs, execute in parallel,
and deliver results. Verification commands (e.g. npm test) run automatically.

## Installation
  npm install -g codex-teams
  # or: npx codex-teams launch ...

## Commands

### launch — Run a mission (blocks until complete)
  codex-teams launch \\
    --objective "Add user auth with JWT, API endpoints, and tests" \\
    --lead "Tech Lead" \\
    --worker "Backend Engineer" \\
    --worker "Frontend Engineer" \\
    --worker "Test Engineer" \\
    --verify "npm test" \\
    --max-retries 2

  Options:
    --objective <text>     Mission objective (required)
    --work-dir <path>      Working directory (default: wherever you run the command)
    --lead <role>          Lead agent role (default: "Lead")
    --worker <roles...>    Worker roles (repeatable, at least one required)
    --verify <command>     Shell command to verify after completion
    --max-retries <n>      Max verification retries (default: 2)
    --sandbox <mode>       plan-mode | workspace-write | danger-full-access (default: workspace-write)
    --reasoning <effort>   xhigh | high | medium | low | minimal
    --fast                 Enable fast output mode
    --team-json <json>     Full team config as JSON (overrides --lead/--worker)

  Output: JSON to stdout with leadOutput, workerResults, sharedArtifacts, verificationLog.
  Progress: Streamed to stderr.
  Exit code: 0 on success, 1 on error.

### status [missionId] — Check mission status
  codex-teams status                  # List all active missions
  codex-teams status <missionId>      # Check specific mission

### steer <missionId> — Redirect agents mid-mission
  codex-teams steer <missionId> --directive "Switch from REST to GraphQL"
  codex-teams steer <missionId> --directive "Fix the auth bug first" --agents agent-id-1 agent-id-2

### help — Show this guide
  codex-teams help          # Human-readable
  codex-teams help --llm    # Full guide for LLM consumption

## Writing Good Objectives

The objective is the most important input. Every word matters.

**Be specific about the problem.** Don't say "fix the auth bug" — say "the login endpoint
at src/api/auth.ts returns 500 when the email contains a + character. Fix the regex and
add test cases."

**Define what done looks like.** Include acceptance criteria. "The /api/users endpoint should
return paginated results with limit/offset, default limit 20, max 100."

**Point to the right files.** Reference specific files, directories, and patterns.

**State constraints explicitly.** Don't touch the database schema. Keep backward compatibility.

**Separate concerns for workers.** Give each worker a distinct, non-overlapping scope.

## Team Sizing
- 1 lead + 1-3 workers is the sweet spot
- More workers = more coordination overhead
- Match worker count to genuinely parallelizable work

## Advanced: --team-json

For full control over team composition:
  codex-teams launch \\
    --objective "..." \\
    --team-json '[
      {"role": "Tech Lead", "isLead": true, "reasoningEffort": "xhigh"},
      {"role": "Backend", "specialization": "API design", "sandbox": "workspace-write"},
      {"role": "Frontend", "specialization": "React components", "fastMode": true}
    ]'

## For LLM Agents

To use codex-teams from an LLM agent (e.g., Claude Code, Droid, Codex):
1. Run: codex-teams help --llm   (to get this guide)
2. Use Execute tool with: codex-teams launch --objective "..." --lead "Lead" --worker "Worker"
3. The command blocks until done. Use fireAndForget for async.
4. Parse JSON output from stdout for results.
5. Use codex-teams steer <id> --directive "..." to redirect mid-mission.
`;

export function registerHelpCommand(program: Command): void {
  program
    .command("help")
    .description("Show usage guide")
    .option("--llm", "Output full guide for LLM consumption")
    .action((opts) => {
      if (opts.llm) {
        console.log(ORCHESTRATOR_GUIDE);
      } else {
        console.log(ORCHESTRATOR_GUIDE);
      }
    });
}

export { ORCHESTRATOR_GUIDE };
