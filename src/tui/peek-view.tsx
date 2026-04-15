// Peek view — full-screen scrollable event log for a session

import React from "react";
import { Box, Text, useStdout } from "ink";
import type { TrackedSession } from "../types.js";

interface PeekViewProps {
  session: TrackedSession;
  scrollOffset: number;
  autoScroll: boolean;
}

interface PeekLine {
  time: string;
  type: string;
  detail: string;
  color: string;
  continued?: boolean; // true for continuation lines of the same entry
}

export function PeekView({ session, scrollOffset, autoScroll }: PeekViewProps) {
  const { stdout } = useStdout();
  const termHeight = stdout?.rows ?? 24;
  const contentHeight = termHeight - 4; // header + footer

  const lines = session.peekLines.flatMap(line => formatPeekLine(line) ?? []);

  // Auto-scroll: show last N lines
  const effectiveOffset = autoScroll
    ? Math.max(0, lines.length - contentHeight)
    : Math.min(scrollOffset, Math.max(0, lines.length - contentHeight));

  const visibleLines = lines.slice(effectiveOffset, effectiveOffset + contentHeight);

  const statusColor = ({
    running: "green",
    "interactive-active": "green",
    "interactive-idle": "blue",
    done: "cyan",
    failed: "red",
    killed: "yellow",
    unknown: "gray",
  } as Record<string, string>)[session.status] ?? "gray";

  return (
    <Box flexDirection="column" width="100%">
      {/* Header */}
      <Box paddingX={1} gap={1}>
        <Text bold color="cyan">Peek: #{session.shortId}</Text>
        <Text>—</Text>
        <Text color={statusColor} bold>{session.status}</Text>
        <Text dimColor>({lines.length} entries)</Text>
        {autoScroll && <Text color="green"> ▼ auto-scroll</Text>}
      </Box>

      {/* Event log */}
      <Box flexDirection="column" paddingX={1} flexGrow={1}>
        {visibleLines.map((line, i) => (
          <Box key={effectiveOffset + i} gap={1}>
            <Text dimColor>{line.continued ? "        " : line.time}</Text>
            <Text color={line.color as any}>{line.continued ? "                    " : line.type.padEnd(20)}</Text>
            <Text wrap="wrap">{line.detail}</Text>
          </Box>
        ))}
        {visibleLines.length === 0 && (
          <Text dimColor>No entries to display.</Text>
        )}
      </Box>

      {/* Footer */}
      <Box paddingX={1} gap={2}>
        <Text dimColor>[q] back</Text>
        <Text dimColor>[↑↓/jk] scroll</Text>
        <Text dimColor>[G] bottom</Text>
        <Text dimColor>[F] toggle auto-scroll</Text>
        {session.pid && <Text dimColor>[K] kill</Text>}
      </Box>
    </Box>
  );
}

/**
 * Format a raw JSONL line into one or more PeekLines (no truncation).
 */
function formatPeekLine(rawLine: string): PeekLine[] | null {
  let entry: any;
  try {
    entry = JSON.parse(rawLine);
  } catch {
    return null;
  }

  const time = entry.timestamp
    ? new Date(entry.timestamp).toLocaleTimeString("en-US", { hour12: false })
    : "        ";

  switch (entry.type) {
    case "message": {
      const msg = entry.message;
      if (!msg) return [{ time, type: "message", detail: "(empty)", color: "white" }];

      switch (msg.role) {
        case "user": {
          const text = typeof msg.content === "string"
            ? msg.content
            : (msg.content?.find?.((c: any) => c.type === "text")?.text ?? "");
          return expandLines(time, "user", text, "blue");
        }
        case "assistant": {
          const results: PeekLine[] = [];
          const stopInfo = msg.stopReason ? ` [${msg.stopReason}]` : "";
          const costInfo = msg.usage?.cost?.total ? ` $${msg.usage.cost.total.toFixed(4)}` : "";
          const typeLabel = `assistant${stopInfo}`;
          const color = msg.stopReason === "error" ? "red" : "green";

          if (Array.isArray(msg.content)) {
            let first = true;
            for (const block of msg.content) {
              if (block.type === "text" && block.text) {
                const label = first ? typeLabel : "";
                const suffix = first ? costInfo : "";
                const lines = expandLines(
                  first ? time : "",
                  label,
                  block.text + suffix,
                  color
                );
                results.push(...lines);
                first = false;
              } else if (block.type === "toolCall") {
                const argsStr = formatToolArgs(block.arguments);
                const label = first ? typeLabel : "";
                const suffix = first ? costInfo : "";
                const detail = `→ ${block.name}(${argsStr})${suffix}`;
                results.push({
                  time: first ? time : "        ",
                  type: first ? label.padEnd(20) : "                    ",
                  detail,
                  color,
                  continued: !first,
                });
                first = false;
              }
            }
          }
          if (results.length === 0) {
            results.push({ time, type: typeLabel, detail: costInfo, color });
          }
          return results;
        }
        case "toolResult": {
          const isErr = msg.isError;
          const text = typeof msg.content === "string"
            ? msg.content
            : (msg.content?.find?.((c: any) => c.type === "text")?.text ?? "");
          return expandLines(
            time,
            `tool:${entry.message.toolName ?? "?"}`,
            text,
            isErr ? "red" : "gray"
          );
        }
        case "bashExecution": {
          const detail = `$ ${msg.command ?? ""} → exit ${msg.exitCode ?? "?"}`;
          return expandLines(
            time,
            "bash",
            detail,
            msg.exitCode === 0 ? "gray" : "red"
          );
        }
        default: {
          const detail = typeof msg.content === "string"
            ? msg.content
            : JSON.stringify(msg.content);
          return expandLines(time, msg.role, detail, "white");
        }
      }
    }

    case "compaction":
      return [{ time, type: "compaction", detail: `${entry.tokensBefore ?? "?"} tokens summarized`, color: "magenta" }];

    case "model_change":
      return [{ time, type: "model_change", detail: `${entry.provider}/${entry.modelId}`, color: "yellow" }];

    case "thinking_level_change":
      return [{ time, type: "thinking", detail: entry.thinkingLevel, color: "yellow" }];

    case "session_info":
      return [{ time, type: "session_info", detail: `name: "${entry.name}"`, color: "cyan" }];

    default:
      return [{ time, type: entry.type, detail: "", color: "gray" }];
  }
}

/**
 * Expand a potentially multi-line detail string into multiple PeekLine entries.
 * The first line gets the time + type label; continuation lines are indented.
 */
function expandLines(time: string, type: string, text: string, color: string): PeekLine[] {
  const lines = text.split("\n");
  return lines.map((line, i) => ({
    time: i === 0 ? time : "        ",
    type: i === 0 ? type : "",
    detail: line,
    color,
    continued: i > 0,
  }));
}

function formatToolArgs(args: any): string {
  if (!args) return "";
  if (typeof args === "string") return args;
  try {
    return JSON.stringify(args);
  } catch {
    return "";
  }
}
