#!/usr/bin/env node
import { Command } from "commander";
import { registerLaunchCommand } from "./cli/launch.js";
import { registerStatusCommand } from "./cli/status.js";
import { registerSteerCommand } from "./cli/steer.js";
import { registerHelpCommand } from "./cli/help.js";

const program = new Command();

program
  .name("codex-teams")
  .description("Orchestrate teams of Codex CLI agents for coordinated coding missions")
  .version("3.0.0")
  .addHelpText("after", "\nRun 'codex-teams help --llm' for full LLM-compatible usage guide.");

registerLaunchCommand(program);
registerStatusCommand(program);
registerSteerCommand(program);
registerHelpCommand(program);

program.parse();
