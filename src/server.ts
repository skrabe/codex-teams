import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { TeamManager } from "./state.js";
import type { CodexClientManager } from "./codex-client.js";
import type { MessageSystem } from "./messages.js";
import { registerTeamTools } from "./tools/team.js";
import { registerAgentTools } from "./tools/agent.js";
import { registerCommunicationTools } from "./tools/communication.js";
import { registerTaskTools } from "./tools/task.js";
import { registerResultTools } from "./tools/results.js";
import { registerDispatchTools } from "./tools/dispatch.js";
import { registerMissionTools } from "./tools/mission.js";
import { registerSteerTools } from "./tools/steer.js";

const ORCHESTRATOR_GUIDE = `# codex-teams Orchestrator Guide

## When to Use What

### Mission (launch_mission + await_mission)
Use for: coordinated work requiring communication between agents.
- Best for: feature implementation, refactoring, bug investigation, code review
- Agents communicate via group chat, DMs, and shared artifacts
- Lead coordinates, workers execute autonomously
- Optional verification command (e.g. "npm test") with auto-retry
- Returns: worker outputs, lead output, shared artifacts, chat history

### Dispatch (dispatch_team)
Use for: parallel independent tasks with no inter-agent communication needed.
- Best for: batch operations, independent file processing, parallel searches
- All agents run simultaneously with separate tasks
- No group chat or coordination — each agent works in isolation
- Simpler and faster when tasks don't overlap
- Returns: per-agent results

### Manual (create_team + send_message + assign_task)
Use for: fine-grained control where you direct each step.
- Best for: exploratory work, debugging, iterative refinement
- You manage the conversation flow directly

## Team Sizing
- 1 lead + 1-3 workers is the sweet spot for missions
- More workers = more coordination overhead, diminishing returns
- Match worker count to genuinely parallelizable work streams
- Each worker should own a distinct scope with clear boundaries

## Mission Workflow
1. Call launch_mission with objective, team composition, and optional verifyCommand
2. Mission returns immediately with missionId
3. Check progress with mission_status (includes recent chat and artifact count during execution)
4. Block on completion with await_mission, or poll mission_status
5. Results include: leadOutput, workerResults, sharedArtifacts, verificationLog
6. For full chat history: use get_mission_comms (available 30 min after completion)

## Tips
- Write clear objectives: what to build/fix, acceptance criteria, relevant file paths
- Set verifyCommand to "npm test" or equivalent for automatic quality gates
- The lead's group_chat posts and shared artifacts ARE the deliverable — no separate compilation step
- Use mission_status during execution to monitor progress without blocking
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

  registerTeamTools(server, state, messages);
  registerAgentTools(server, state);
  registerCommunicationTools(server, state, codex);
  registerTaskTools(server, state, codex);
  registerResultTools(server, state);

  if (messages) {
    registerDispatchTools(server, state, codex, messages);
    registerMissionTools(server, state, codex, messages);
    registerSteerTools(server, state, codex, messages);
  }

  return server;
}
