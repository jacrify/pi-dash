// Session file parser — reads .jsonl session files and produces TrackedSession objects

import { readFileSync, statSync } from "node:fs";
import type { TrackedSession, SessionEntry } from "./types.js";

/**
 * Parse a session file into a TrackedSession.
 */
export function parseSessionFile(filePath: string): TrackedSession | null {
  let raw: string;
  try {
    raw = readFileSync(filePath, "utf-8");
  } catch {
    return null;
  }

  const lines = raw.trim().split("\n");
  if (lines.length === 0) return null;

  let header: SessionEntry;
  try {
    header = JSON.parse(lines[0]!);
  } catch {
    return null;
  }

  if (header.type !== "session") return null;

  let fileSize = 0;
  try {
    fileSize = statSync(filePath).size;
  } catch {}

  const session: TrackedSession = {
    sessionId: header.id ?? "",
    shortId: (header.id ?? "").slice(0, 4),
    sessionFile: filePath,
    cwd: header.cwd ?? "",
    name: null,
    prompt: "",
    lastUserMessage: null,
    status: "unknown",
    pid: null,
    interactive: null,
    startedAt: new Date(header.timestamp ?? Date.now()),
    endedAt: null,
    duration: null,
    lastFileSize: fileSize,
    fileGrowingSince: null,
    turnCount: 0,
    userMessageCount: 0,
    lastToolName: null,
    lastToolArgs: null,
    lastAssistantStopReason: null,
    model: null,
    provider: null,
    stopReason: null,
    errorMessage: null,
    lastOutput: null,
    totalUsage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, totalCost: 0 },
    peekLines: [],
  };

  // Walk all entries
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i]!;
    if (!line.trim()) continue;

    if (session.peekLines.length >= 500) {
      session.peekLines.shift();
    }
    session.peekLines.push(line);

    let entry: SessionEntry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }

    processEntry(session, entry);
  }

  // Determine status and mode from what we found
  if (session.stopReason) {
    if (session.stopReason === "error" || session.errorMessage) {
      session.status = "failed";
    } else {
      session.status = "done";
    }
  }

  // We can only know interactive vs -p from live process observation.
  // Default to null (unknown) — tracker will set it from process correlation
  // if it catches the process alive, and preserve it after death.
  // session.interactive defaults to true in the struct, override to reflect uncertainty.

  if (session.endedAt && session.startedAt) {
    session.duration = session.endedAt.getTime() - session.startedAt.getTime();
  }

  return session;
}

/**
 * Process a single session entry and update TrackedSession in place.
 */
export function processEntry(session: TrackedSession, entry: SessionEntry): void {
  switch (entry.type) {
    case "message": {
      const msg = entry.message;
      if (!msg) break;

      if (msg.role === "user") {
        session.userMessageCount++;
        session.lastAssistantStopReason = null;
        // Extract user message text
        let userText: string | null = null;
        if (typeof msg.content === "string") {
          userText = msg.content.slice(0, 200);
        } else if (Array.isArray(msg.content)) {
          const textBlock = msg.content.find((c: any) => c.type === "text");
          if (textBlock) {
            userText = textBlock.text.slice(0, 200);
          }
        }
        if (userText) {
          if (!session.prompt) {
            session.prompt = userText;
          }
          session.lastUserMessage = userText;
        }
      }

      if (msg.role === "assistant") {
        if (msg.provider) session.provider = msg.provider;
        if (msg.model) session.model = msg.model;
        if (msg.stopReason) {
          session.stopReason = msg.stopReason;
          session.lastAssistantStopReason = msg.stopReason;
          if (msg.stopReason === "stop" || msg.stopReason === "toolUse") {
            session.endedAt = entry.timestamp ? new Date(entry.timestamp) : new Date();
          }
        }
        if (msg.errorMessage) session.errorMessage = msg.errorMessage;

        if (msg.usage) {
          session.totalUsage.inputTokens += msg.usage.input ?? 0;
          session.totalUsage.outputTokens += msg.usage.output ?? 0;
          session.totalUsage.cacheReadTokens += msg.usage.cacheRead ?? 0;
          session.totalUsage.totalCost += msg.usage.cost?.total ?? 0;
        }

        if (msg.stopReason) {
          session.turnCount++;
        }

        if (Array.isArray(msg.content)) {
          const lastToolCall = [...msg.content].reverse().find((c: any) => c.type === "toolCall");
          if (lastToolCall) {
            session.lastToolName = lastToolCall.name ?? null;
            session.lastToolArgs = summarizeArgs(lastToolCall.arguments);
          }

          // Capture last assistant text output
          const textBlocks = msg.content.filter((c: any) => c.type === "text" && c.text);
          if (textBlocks.length > 0) {
            const lastText = textBlocks[textBlocks.length - 1].text as string;
            // Take the last few lines (up to 200 chars)
            const lines = lastText.trim().split("\n");
            const tail = lines.slice(-3).join(" ").slice(-200);
            session.lastOutput = tail;
          }
        } else if (typeof msg.content === "string" && msg.content.trim()) {
          const lines = msg.content.trim().split("\n");
          session.lastOutput = lines.slice(-3).join(" ").slice(-200);
        }
      }
      break;
    }

    case "session_info": {
      if (entry.name) session.name = entry.name;
      break;
    }

    case "model_change": {
      if (entry.provider) session.provider = entry.provider;
      if (entry.modelId) session.model = entry.modelId;
      break;
    }
  }
}

/**
 * Incrementally parse new bytes appended to a session file.
 * NOTE: Does NOT update session.status — that's the caller's job
 * (session-tracker handles status via process correlation).
 */
export function parseTail(session: TrackedSession, newLines: string[]): void {
  for (const line of newLines) {
    if (!line.trim()) continue;

    if (session.peekLines.length >= 500) {
      session.peekLines.shift();
    }
    session.peekLines.push(line);

    let entry: SessionEntry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }

    processEntry(session, entry);
  }

  if (session.endedAt && session.startedAt) {
    session.duration = session.endedAt.getTime() - session.startedAt.getTime();
  }
}

function summarizeArgs(args: any): string | null {
  if (!args) return null;
  if (typeof args === "string") return args.slice(0, 80);
  if (args.path) return args.path;
  if (args.command) return args.command.slice(0, 80);
  try {
    return JSON.stringify(args).slice(0, 80);
  } catch {
    return null;
  }
}
