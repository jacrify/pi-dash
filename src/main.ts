#!/usr/bin/env node
// pi-dash — Terminal dashboard for pi coding agent sessions

import React from "react";
import { render } from "ink";
import { spawnSync } from "node:child_process";
import { App } from "./tui/app.js";
import { SessionTracker } from "./session-tracker.js";

// Parse CLI args
const args = process.argv.slice(2);
let cwdFilter: string | undefined;
let sessionDir: string | undefined;
let filterMode: string | undefined;
let pollInterval: number | undefined;
let jsonMode = false;
let listMode = false;

for (let i = 0; i < args.length; i++) {
  switch (args[i]) {
    case "--cwd":
      cwdFilter = args[++i];
      break;
    case "--session-dir":
      sessionDir = args[++i];
      break;
    case "--filter":
      filterMode = args[++i];
      break;
    case "--poll-interval":
      pollInterval = parseInt(args[++i] ?? "2000", 10);
      break;
    case "--json":
      jsonMode = true;
      break;
    case "--list":
      listMode = true;
      break;
    case "--help":
    case "-h":
      console.log(`pi-dash — Terminal dashboard for pi coding agent sessions

Usage:
  pi-dash [options]

Options:
  --cwd <path>           Filter to sessions from this working directory
  --session-dir <path>   Session storage root (default: ~/.pi/agent/sessions)
  --filter <status>      Filter: all, interactive, running, finished (default: all)
  --poll-interval <ms>   Process polling interval (default: 2000)
  --json                 Output session list as JSON and exit
  --list                 Output session list as table and exit
  --help, -h             Show this help

Keybindings:
  ↑/k ↓/j   Navigate        Enter/p  Peek session
  /          Search           Esc      Cancel search
  K          Kill (SIGTERM)   !        Force kill (SIGKILL)
  f          Cycle filter     s        Cycle sort
  r          Refresh          ?        Help
  q          Quit`);
      process.exit(0);
  }
}

const tracker = new SessionTracker({
  sessionDir,
  cwdFilter,
  pollIntervalMs: pollInterval,
});

// Non-interactive modes
if (jsonMode || listMode) {
  tracker.start(() => {});
  // Give a moment for initial scan + process correlation
  setTimeout(() => {
    const sessions = tracker.getFilteredSessions(
      (filterMode as any) ?? "all",
      "newest",
      ""
    );
    tracker.stop();

    if (jsonMode) {
      console.log(JSON.stringify(sessions, null, 2));
    } else {
      // Table output
      console.log(
        "STATUS              ID     DURATION  CWD                   PROMPT"
      );
      console.log("─".repeat(90));
      for (const s of sessions) {
        const dur = s.duration ? `${Math.round(s.duration / 1000)}s` : "—";
        const home = process.env.HOME ?? "";
        const cwd = home && s.cwd.startsWith(home) ? "~" + s.cwd.slice(home.length) : s.cwd;
        const prompt = (s.name ?? s.prompt ?? "").slice(0, 40);
        const isLive = s.status === "running" || s.status === "interactive-active" || s.status === "interactive-idle";
        const mode = isLive ? "" : s.interactive === false ? " (-p)" : s.interactive === true ? " (i)" : "";
        console.log(
          `${(s.status + mode).padEnd(20)} #${s.shortId}  ${dur.padEnd(9)} ${cwd.padEnd(21)} ${prompt}`
        );
        if (s.lastOutput) {
          console.log(
            `${"".padEnd(20)} ${"".padEnd(6)} ${"".padEnd(10)} → ${s.lastOutput.slice(0, 80)}`
          );
        }
      }
    }
    process.exit(0);
  }, 500);
} else {
  // Interactive TUI mode — use alternate screen buffer to avoid scroll issues
  const enterAltScreen = "\x1b[?1049h";
  const leaveAltScreen = "\x1b[?1049l";

  process.stdout.write(enterAltScreen);

  const cleanup = () => {
    process.stdout.write(leaveAltScreen);
  };

  // Ensure we leave alt screen on exit
  process.on("exit", cleanup);
  process.on("SIGINT", () => { cleanup(); process.exit(0); });
  process.on("SIGTERM", () => { cleanup(); process.exit(0); });

  let inkInstance: ReturnType<typeof render>;

  const startTui = () => {
    process.stdout.write(enterAltScreen);
    inkInstance = render(React.createElement(App, { tracker, onResume: handleResume }));
    inkInstance.waitUntilExit().then(() => {
      cleanup();
      process.exit(0);
    });
  };

  const handleResume = (sessionFile: string) => {
    // Suspend TUI
    inkInstance.unmount();
    process.stdout.write(leaveAltScreen);

    // Spawn pi with the session file, inheriting stdio
    spawnSync("pi", ["--session", sessionFile], {
      stdio: "inherit",
      env: process.env,
    });

    // Restore TUI
    tracker.refresh();
    startTui();
  };

  startTui();
}
