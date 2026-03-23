import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { TeamManager } from "./state.js";
import type { CodexClientManager } from "./codex-client.js";
import type { MessageSystem } from "./messages.js";
import { registerMissionTools } from "./tools/mission.js";
import { registerSteerTools } from "./tools/steer.js";

const ORCHESTRATOR_GUIDE = `# codex-teams Orchestrator Guide

You are orchestrating a team of autonomous coding agents. The quality of their output is
directly proportional to the quality of your instructions. These agents are capable engineers,
but they can only work with what you give them. Vague objectives produce vague results.
Precise, well-structured missions produce exceptional work.

## Writing Great Objectives

The objective is the single most important input to a mission. Every word matters.

**Be specific about the problem.** Don't say "fix the auth bug" — say "the login endpoint
at src/api/auth.ts returns 500 when the email contains a + character. The issue is likely
in the email validation regex on line 42. Fix the regex and add test cases for special
characters in emails."

**Define what done looks like.** Include acceptance criteria so agents know when they've
succeeded. "The /api/users endpoint should return paginated results with limit/offset
query params, default limit 20, max 100. Response shape: { data: User[], total: number,
limit: number, offset: number }."

**Point to the right files.** Agents can explore the codebase, but starting them in the
right place saves time and avoids wrong turns. Reference specific files, directories,
and existing patterns they should follow.

**State constraints explicitly.** If there are things agents should NOT do — don't touch
the database schema, don't modify the public API, keep backward compatibility — say so.
Unstated constraints become surprised reviewers.

**Separate concerns for workers.** When you define team roles, give each worker a distinct,
non-overlapping scope. "You own the API layer" and "you own the frontend components" is
clear. "Help with the feature" is not. The lead will coordinate, but clean boundaries
prevent agents from stepping on each other's work.

**Research missions need structure too.** Not every mission writes code — sometimes you need
agents to investigate, audit, or map out a codebase. These benefit just as much from
precision. Don't say "look into our error handling" — say "Audit every try/catch block
in src/api/ and src/services/. For each one, document: what errors it catches, whether it
logs them, whether it returns a meaningful error to the caller, and whether it swallows
errors silently. Produce a shared artifact with a table of findings and flag the worst
offenders. The goal is a prioritized list of error handling improvements, not fixes."
For research, tell agents what to look for, where to look, what format you want the
findings in, and what questions you need answered. A team that knows it's producing a
report with specific columns will deliver something actionable. A team told to "explore"
will wander.

The less you leave to assumption, the better the result. A well-written 10-line objective
will outperform a hastily written 2-line one every time.

## Team Sizing
- 1 lead + 1-3 workers is the sweet spot
- More workers = more coordination overhead, diminishing returns
- Match worker count to genuinely parallelizable work streams
- Each worker should own a distinct scope with clear boundaries

## Workflow
1. Call launch_mission with objective, team composition, and optional verifyCommand
2. Mission returns immediately with missionId
3. Check progress with mission_status (includes recent chat and artifact count during execution)
4. Block on completion with await_mission, or poll mission_status
5. Results include: leadOutput, workerResults, sharedArtifacts, verificationLog
6. For full chat history: use get_mission_comms (available 30 min after completion)
7. Use get_team_comms with teamId for live communication during execution
8. Use steer_team to redirect agents mid-mission if they go off track

## Tips
- Set verifyCommand to "npm test" or equivalent for automatic quality gates
- The lead's group_chat posts and shared artifacts ARE the deliverable
- Use mission_status during execution to monitor progress without blocking
- If a mission goes sideways, steer_team lets you course-correct without starting over
`;

export function createServer(
  state: TeamManager,
  codex: CodexClientManager,
  messages?: MessageSystem,
): McpServer {
  const server = new McpServer({
    name: "codex-teams",
    version: "2.3.0",
  });

  server.registerResource("guide", "codex-teams://guide", { description: "Orchestrator guide for codex-teams" }, async () => ({
    contents: [{ uri: "codex-teams://guide", text: ORCHESTRATOR_GUIDE, mimeType: "text/markdown" }],
  }));

  if (messages) {
    registerMissionTools(server, state, codex, messages);
    registerSteerTools(server, state, codex, messages);
  }

  return server;
}
