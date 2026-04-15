// Detail pane — shows full info for selected session (fixed height)

import React from "react";
import { Text } from "ink";
import type { TrackedSession, SessionStatus } from "../types.js";

interface DetailPaneProps {
  session: TrackedSession;
  height: number; // exact number of lines to render (including border)
}

const STATUS_COLORS: Record<SessionStatus, string> = {
  "running": "green",
  "interactive-active": "green",
  "interactive-idle": "blue",
  "done": "cyan",
  "failed": "red",
  "killed": "yellow",
  "unknown": "gray",
};

const STATUS_LABELS: Record<SessionStatus, string> = {
  "running": "RUNNING (pi -p)",
  "interactive-active": "INTERACTIVE (active)",
  "interactive-idle": "INTERACTIVE (idle)",
  "done": "DONE",
  "failed": "FAILED",
  "killed": "KILLED",
  "unknown": "UNKNOWN",
};

/**
 * Render the detail pane as exactly `height` lines of Text.
 * We build an array of content lines, pad/truncate to fit,
 * then draw a top border, content, and bottom border.
 */
export function DetailPane({ session, height }: DetailPaneProps) {
  const statusColor = STATUS_COLORS[session.status];
  const statusLabel = STATUS_LABELS[session.status];
  const duration = formatDurationLong(session);
  const cost = session.totalUsage.totalCost > 0
    ? `$${session.totalUsage.totalCost.toFixed(4)}`
    : "—";

  // Build content lines
  const lines: { text: string; color?: string; dim?: boolean }[] = [];

  // Line 1: status
  let statusLine = ` Session #${session.shortId} — ${statusLabel}`;
  if (duration) statusLine += ` (${duration})`;
  if (session.pid) statusLine += ` PID ${session.pid}`;
  lines.push({ text: statusLine });

  // Line 2: CWD
  lines.push({ text: ` CWD: ${session.cwd}`, dim: true });

  // Line 3: Model (if present)
  if (session.model) {
    const modelLine = ` Model: ${session.model}${session.provider ? ` (${session.provider})` : ""}`;
    lines.push({ text: modelLine, dim: true });
  }

  // Line 4: Prompt
  const promptText = (session.prompt || "(empty)").replace(/\n/g, " ").replace(/\s+/g, " ");
  lines.push({ text: ` Prompt: ${promptText}`, dim: true });

  // Line 5: Stats
  lines.push({ text: ` Turns: ${session.turnCount}  Tokens: ${fmtNum(session.totalUsage.inputTokens)} in / ${fmtNum(session.totalUsage.outputTokens)} out  Cost: ${cost}` });

  // Optional: last tool
  if (session.lastToolName) {
    const toolLine = ` Last tool: ${session.lastToolName}${session.lastToolArgs ? ` ${session.lastToolArgs}` : ""}`;
    lines.push({ text: toolLine, color: "yellow" });
  }

  // Optional: last output
  if (session.lastOutput) {
    lines.push({ text: ` Last output: ${session.lastOutput.replace(/\n/g, " ").replace(/\s+/g, " ")}` });
  }

  // Optional: error
  if (session.errorMessage) {
    lines.push({ text: ` Error: ${session.errorMessage.slice(0, 120)}`, color: "red" });
  }

  // Line: file
  lines.push({ text: ` File: ${session.sessionFile}`, dim: true });

  // We have 2 border lines, so content area = height - 2
  const contentHeight = Math.max(0, height - 2);

  // Truncate or pad content to exactly contentHeight lines
  const displayLines = lines.slice(0, contentHeight);
  while (displayLines.length < contentHeight) {
    displayLines.push({ text: "" });
  }

  const result: React.ReactNode[] = [];

  // Top border
  result.push(<Text key="top" dimColor>{"─".repeat(60)}</Text>);

  // Content lines
  for (let i = 0; i < displayLines.length; i++) {
    const line = displayLines[i]!;
    result.push(
      <Text key={i} color={line.color as any} dimColor={line.dim} wrap="truncate">
        {line.text}
      </Text>
    );
  }

  // Bottom border
  result.push(<Text key="bottom" dimColor>{"─".repeat(60)}</Text>);

  return <>{result}</>;
}

function formatDurationLong(session: TrackedSession): string | null {
  const ms = session.pid
    ? Date.now() - session.startedAt.getTime()
    : session.duration;
  if (ms == null) return null;

  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const secs = seconds % 60;
  return `${minutes}m ${secs}s`;
}

function fmtNum(n: number): string {
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(n);
}
