// Session list — scrollable list with status indicators

import React, { useRef } from "react";
import { Box, Text, useStdout } from "ink";
import { statSync } from "node:fs";
import type { TrackedSession, SessionStatus } from "../types.js";
import { isAlive } from "../types.js";

interface SessionListProps {
  sessions: TrackedSession[];
  selectedIndex: number;
  maxHeight?: number;
}

const STATUS_DISPLAY: Record<SessionStatus, { icon: string; color: string; label: string }> = {
  "running":            { icon: "▶", color: "green",   label: "pi -p" },
  "interactive-active": { icon: "●", color: "green",   label: "active" },
  "interactive-idle":   { icon: "◉", color: "blue",    label: "waiting" },
  "done":               { icon: "✓", color: "cyan",    label: "done" },
  "failed":             { icon: "✗", color: "red",     label: "failed" },
  "killed":             { icon: "◼", color: "yellow",  label: "killed" },
  "unknown":            { icon: "?", color: "gray",    label: "?" },
};



export function SessionList({ sessions, selectedIndex, maxHeight }: SessionListProps) {
  const { stdout } = useStdout();
  const termHeight = stdout?.rows ?? 24;
  const termWidth = stdout?.columns ?? 120;
  const availableHeight = maxHeight ?? Math.max(3, termHeight - 14);

  // Column widths
  const cwdWidth = Math.min(22, Math.max(10, Math.floor(termWidth * 0.15)));
  const toolColWidth = 24;
  const prefixCols = 2 + 2 + 13 + 6 + 9 + cwdWidth + 1 + toolColWidth + 1;
  const promptCols = Math.max(10, termWidth - prefixCols - 2);

  // Synchronous scroll tracking via ref — no useEffect delay
  const scrollTopRef = useRef(0);
  let scrollTop = scrollTopRef.current;

  // Adjust scrollTop to keep selectedIndex visible
  if (selectedIndex < scrollTop) {
    scrollTop = selectedIndex;
  } else if (selectedIndex >= scrollTop + availableHeight) {
    scrollTop = selectedIndex - availableHeight + 1;
  }
  // Clamp
  scrollTop = Math.max(0, Math.min(scrollTop, Math.max(0, sessions.length - availableHeight)));
  scrollTopRef.current = scrollTop;

  if (sessions.length === 0) {
    return (
      <Box paddingX={1} paddingY={1}>
        <Text dimColor>No sessions found. Start a pi session to see it here.</Text>
      </Box>
    );
  }

  // Calculate visible window, reserving lines for header + scroll indicators
  const hasMoreAbove = scrollTop > 0;
  const hasMoreBelow = (scrollTop + availableHeight) < sessions.length;
  const indicatorLines = 1 + (hasMoreAbove ? 1 : 0) + (hasMoreBelow ? 1 : 0); // +1 for header
  const sessionSlots = Math.max(1, availableHeight - indicatorLines);
  const visibleEnd = Math.min(scrollTop + sessionSlots, sessions.length);
  const visibleSessions = sessions.slice(scrollTop, visibleEnd);

  // Column header
  const header = (
    <Text wrap="truncate" bold color="cyan">
      {"  "}
      {"STATUS".padEnd(15)}
      {"ID".padEnd(6)}
      {"AGE".padEnd(9)}
      {"DIRECTORY".padEnd(cwdWidth + 1)}
      {"LAST TOOL".padEnd(toolColWidth + 1)}
      {"TASK"}
    </Text>
  );

  return (
    <Box flexDirection="column" paddingX={1} height={availableHeight}>
      {header}
      {hasMoreAbove && (
        <Text dimColor>  ↑ {scrollTop} more above</Text>
      )}
      {visibleSessions.map((session, vi) => {
        const i = scrollTop + vi;
        const isSelected = i === selectedIndex;
        const { icon, color, label } = STATUS_DISPLAY[session.status];
        const rawName = (session.name ?? session.lastUserMessage ?? session.prompt ?? "(no prompt)").replace(/\n/g, " ").replace(/\s+/g, " ");
        const displayName = rawName.slice(0, Math.max(0, promptCols));
        const cwdShort = shortenCwd(session.cwd).slice(0, cwdWidth);
        const duration = formatDuration(session);
        const statusLabel = label.padEnd(12);

        return (
          <Text key={session.sessionFile} wrap="truncate">
            <Text color={isSelected ? "blue" : undefined}>{isSelected ? ">" : " "} </Text>
            <Text color={color as any}>{icon} {statusLabel} </Text>
            <Text dimColor>#{session.shortId} </Text>
            <Text>{duration.padEnd(8)} </Text>
            <Text color="magenta">{cwdShort.padEnd(cwdWidth)} </Text>
            <Text dimColor>{formatToolCol(session, toolColWidth).padEnd(toolColWidth)} </Text>
            <Text color={isSelected ? "white" : undefined}>{displayName}</Text>
          </Text>
        );
      })}
      {hasMoreBelow && (
        <Text dimColor>  ↓ {sessions.length - visibleEnd} more below</Text>
      )}
    </Box>
  );
}

function shortenCwd(cwd: string): string {
  const home = process.env.HOME ?? "";
  if (home && cwd.startsWith(home)) {
    return "~" + cwd.slice(home.length);
  }
  return cwd;
}

function formatDuration(session: TrackedSession): string {
  let ms: number;
  try {
    ms = Date.now() - statSync(session.sessionFile).mtimeMs;
  } catch {
    ms = 0;
  }
  return formatMs(ms);
}

function formatMs(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const secs = seconds % 60;
  if (minutes < 60) return `${minutes}m${secs.toString().padStart(2, "0")}s`;
  const hours = Math.floor(minutes / 60);
  const mins = minutes % 60;
  return `${hours}h${mins.toString().padStart(2, "0")}m`;
}

function formatToolCol(session: TrackedSession, maxWidth: number): string {
  if (!session.lastToolName) return "";

  const name = session.lastToolName;
  const elapsed = session.lastToolCallStartedAt && session.status === "interactive-active"
    ? " " + formatMs(Date.now() - session.lastToolCallStartedAt.getTime())
    : "";

  const full = name + elapsed;
  if (full.length <= maxWidth) return full;
  // Truncate tool name, keep elapsed
  const available = maxWidth - elapsed.length - 1;
  if (available < 3) return full.slice(0, maxWidth);
  return name.slice(0, available) + "…" + elapsed;
}
