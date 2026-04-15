// Header bar — shows summary counts and current filter/sort

import React from "react";
import { Box, Text } from "ink";
import type { TrackedSession, FilterMode, SortMode } from "../types.js";
import { isAlive } from "../types.js";

function shortenPath(cwd: string): string {
  const home = process.env.HOME ?? "";
  if (home && cwd.startsWith(home)) return "~" + cwd.slice(home.length);
  return cwd;
}

interface HeaderBarProps {
  sessions: TrackedSession[];
  filter: FilterMode;
  sort: SortMode;
  searchMode: boolean;
  searchQuery: string;
  pathFilter: string | null;
}

export function HeaderBar({ sessions, filter, sort, searchMode, searchQuery, pathFilter }: HeaderBarProps) {
  const interactive = sessions.filter((s) => s.status === "interactive-idle" || s.status === "interactive-active").length;
  const running = sessions.filter((s) => s.status === "running").length;
  const done = sessions.filter((s) => s.status === "done").length;
  const failed = sessions.filter((s) => s.status === "failed").length;

  return (
    <Box paddingX={1} gap={2}>
      <Text bold color="cyan">pi-dash</Text>
      <Text color="green">▶ {running} running</Text>
      <Text color="blue">◉ {interactive} interactive</Text>
      <Text color="cyan">✓ {done} done</Text>
      <Text color="red">✗ {failed} failed</Text>
      <Text dimColor>│</Text>
      {searchMode ? (
        <Text><Text color="yellow">/</Text><Text color="white">{searchQuery}</Text><Text color="yellow">█</Text></Text>
      ) : searchQuery ? (
        <Text><Text dimColor>search: </Text><Text color="white">{searchQuery}</Text></Text>
      ) : (
        <>
          <Text dimColor>filter:</Text>
          <Text color="white">{filter}</Text>
          {pathFilter && (
            <><Text dimColor>path:</Text>
            <Text color="yellow">{shortenPath(pathFilter)}</Text></>
          )}
          <Text dimColor>sort:</Text>
          <Text color="white">{sort}</Text>
          <Text dimColor>│ ? help</Text>
        </>
      )}
    </Box>
  );
}
