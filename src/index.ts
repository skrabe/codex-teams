#!/usr/bin/env node
import { Command } from "commander";
import { registerLaunchCommand } from "./cli/launch.js";
import { registerStatusCommand } from "./cli/status.js";
import { registerSteerCommand } from "./cli/steer.js";
import { registerHelpCommand } from "./cli/help.js";
import { registerSetupCommand } from "./cli/setup.js";
import { checkForUpdate } from "./cli/update-check.js";

const VERSION = "3.2.1";

const program = new Command();

program
  .name("codex-teams")
  .description("Orchestrate teams of Codex CLI agents for coordinated coding missions")
  .version(VERSION)
  .addHelpText("after", "\nRun 'codex-teams setup' to install the skill for your AI coding tools.\nRun 'codex-teams help --llm' for full LLM-compatible usage guide.");

registerLaunchCommand(program);
registerStatusCommand(program);
registerSteerCommand(program);
registerSetupCommand(program);
registerHelpCommand(program);

checkForUpdate(VERSION);

program.parse();
