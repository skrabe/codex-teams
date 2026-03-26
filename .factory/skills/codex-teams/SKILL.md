---
name: codex-teams
description: >
  Orchestrate teams of Codex CLI agents for coordinated coding missions.
  Use when the user needs parallel work across multiple files/modules,
  research across a large codebase, or coordinated implementation with
  verification. Invoke with /codex-teams or automatically when multi-agent
  work is beneficial.
---

# codex-teams

You have access to `codex-teams`, a CLI tool that orchestrates teams of Codex CLI agents.
Use it via the Execute tool. It blocks until the mission completes and prints JSON to stdout.

## When to use

- User asks for work that benefits from parallelism (frontend + backend + tests)
- Large codebase research or audit across many files/modules
- Implementation with built-in verification (npm test, lint, typecheck)
- Tasks where a lead + workers model improves quality (plan, then execute)

## Quick reference

```bash
# Basic mission: lead + 2 workers (runs in cwd)
codex-teams launch \
  --objective "Add JWT authentication with login/register endpoints and tests" \
  --lead "Tech Lead" \
  --worker "Backend Engineer" \
  --worker "Test Engineer" \
  --verify "npm test"

# Research mission
codex-teams launch \
  --objective "Audit error handling in src/api/ and src/services/. Document every try/catch: what it catches, whether it logs, whether it returns meaningful errors. Produce a prioritized list of improvements." \
  --lead "Lead Auditor" \
  --worker "API Reviewer" \
  --worker "Service Reviewer"

# Full team control via JSON
codex-teams launch \
  --objective "..." \
  --team-json '[{"role":"Lead","isLead":true,"reasoningEffort":"xhigh"},{"role":"Backend"},{"role":"Frontend","fastMode":true}]'

# Check active missions
codex-teams status

# Redirect a running mission (from another terminal)
codex-teams steer <missionId> --directive "Prioritize the auth bug fix first"
```

## Key options

| Flag | Description |
|---|---|
| `--objective` | What to accomplish (be specific, reference files) |
| `--work-dir` | Project directory (default: wherever you run the command) |
| `--lead` | Lead role name (default: "Lead") |
| `--worker` | Worker role (repeatable) |
| `--verify` | Shell command to run after completion |
| `--max-retries` | Verification retry count (default: 2) |
| `--sandbox` | plan-mode / workspace-write / danger-full-access |
| `--team-json` | Full team config as JSON array |

## Output

- JSON result on stdout (parse it)
- Progress logs on stderr
- Exit code 0 = success, 1 = error

## Writing good objectives

Be specific. Reference files. Define done. State constraints. Separate worker scopes.

Bad: "Fix the auth bug"
Good: "The login endpoint at src/api/auth.ts returns 500 when email contains +. Fix the regex on line 42 and add test cases for special characters."

## Team sizing

1 lead + 1-3 workers. More workers = more coordination overhead.
Match worker count to genuinely parallelizable work streams.
