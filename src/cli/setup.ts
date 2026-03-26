import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import type { Command } from "commander";

interface ToolTarget {
  name: string;
  globalDir: string;
  detectPaths: string[];
  detectCommands: string[];
}

const TOOLS: ToolTarget[] = [
  {
    name: "Factory Droid",
    globalDir: path.join(os.homedir(), ".factory", "skills"),
    detectPaths: [
      path.join(os.homedir(), ".factory"),
    ],
    detectCommands: ["droid"],
  },
  {
    name: "Claude Code",
    globalDir: path.join(os.homedir(), ".claude", "skills"),
    detectPaths: [
      path.join(os.homedir(), ".claude"),
    ],
    detectCommands: ["claude"],
  },
  {
    name: "Codex CLI",
    globalDir: path.join(os.homedir(), ".codex", "skills"),
    detectPaths: [
      path.join(os.homedir(), ".codex"),
    ],
    detectCommands: ["codex"],
  },
  {
    name: "OpenCode",
    globalDir: path.join(os.homedir(), ".config", "opencode", "skills"),
    detectPaths: [
      path.join(os.homedir(), ".config", "opencode"),
    ],
    detectCommands: ["opencode"],
  },
  {
    name: "Universal (.agents)",
    globalDir: path.join(os.homedir(), ".agents", "skills"),
    detectPaths: [
      path.join(os.homedir(), ".agents"),
    ],
    detectCommands: [],
  },
];

function commandExists(cmd: string): boolean {
  const { execSync } = require("node:child_process");
  try {
    execSync(`which ${cmd} 2>/dev/null || where ${cmd} 2>nul`, { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

function isDetected(tool: ToolTarget): boolean {
  for (const p of tool.detectPaths) {
    if (fs.existsSync(p)) return true;
  }
  for (const cmd of tool.detectCommands) {
    if (commandExists(cmd)) return true;
  }
  return false;
}

// Imported as a string at build time by esbuild (--loader:.md=text)
// At dev time via tsx, this resolves to the raw file content
import SKILL_CONTENT from "../../.factory/skills/codex-teams/SKILL.md";

function getSkillContent(): string {
  return SKILL_CONTENT;
}

function installSkill(tool: ToolTarget, content: string): { installed: boolean; path: string; error?: string } {
  const skillDir = path.join(tool.globalDir, "codex-teams");
  const skillPath = path.join(skillDir, "SKILL.md");

  try {
    fs.mkdirSync(skillDir, { recursive: true });
    fs.writeFileSync(skillPath, content);
    return { installed: true, path: skillPath };
  } catch (err) {
    return { installed: false, path: skillPath, error: err instanceof Error ? err.message : String(err) };
  }
}

export function registerSetupCommand(program: Command): void {
  program
    .command("setup")
    .description("Install codex-teams skill for all detected AI coding tools")
    .option("--all", "Install for all supported tools, not just detected ones")
    .option("--factory", "Install for Factory Droid only")
    .option("--claude", "Install for Claude Code only")
    .option("--codex", "Install for Codex CLI only")
    .option("--opencode", "Install for OpenCode only")
    .option("--universal", "Install to ~/.agents/skills/ (universal)")
    .action((opts) => {
      const content = getSkillContent();
      const specificTool = opts.factory || opts.claude || opts.codex || opts.opencode || opts.universal;
      const results: Array<{ tool: string; status: string; path: string }> = [];

      for (const tool of TOOLS) {
        if (specificTool) {
          const match =
            (opts.factory && tool.name === "Factory Droid") ||
            (opts.claude && tool.name === "Claude Code") ||
            (opts.codex && tool.name === "Codex CLI") ||
            (opts.opencode && tool.name === "OpenCode") ||
            (opts.universal && tool.name === "Universal (.agents)");
          if (!match) continue;
        }

        const detected = isDetected(tool);

        if (!opts.all && !specificTool && !detected) {
          results.push({ tool: tool.name, status: "skipped (not detected)", path: "" });
          continue;
        }

        const result = installSkill(tool, content);
        if (result.installed) {
          results.push({ tool: tool.name, status: "installed", path: result.path });
        } else {
          results.push({ tool: tool.name, status: `failed: ${result.error}`, path: result.path });
        }
      }

      console.log("\ncodex-teams setup\n");

      let installed = 0;
      let skipped = 0;

      for (const r of results) {
        if (r.status === "installed") {
          console.log(`  ✓ ${r.tool}`);
          console.log(`    ${r.path}`);
          installed++;
        } else if (r.status.startsWith("skipped")) {
          console.log(`  - ${r.tool} (not detected)`);
          skipped++;
        } else {
          console.log(`  ✗ ${r.tool}: ${r.status}`);
        }
      }

      console.log("");

      if (installed > 0) {
        console.log(`Installed skill for ${installed} tool${installed > 1 ? "s" : ""}.`);
        if (skipped > 0) {
          console.log(`Skipped ${skipped} tool${skipped > 1 ? "s" : ""} (not detected). Use --all to install for all.`);
        }
        console.log("\nYour AI coding tools will now discover codex-teams automatically.");
      } else if (skipped === results.length) {
        console.log("No supported AI coding tools detected.");
        console.log("Use --all to install for all tools, or specify one: --claude, --codex, --opencode, --factory, --universal");
      }

      console.log("");
    });
}
