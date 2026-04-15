// Help overlay

import React from "react";
import { Box, Text } from "ink";

export function HelpOverlay() {
  return (
    <Box flexDirection="column" paddingX={2} paddingY={1}>
      <Text bold color="cyan">pi-dash — Keybindings</Text>
      <Text> </Text>

      <Text bold>Session Categories</Text>
      <Box flexDirection="column" paddingLeft={2}>
        <Text><Text color="green">▶ running</Text>     Process alive, agent is working</Text>
        <Text><Text color="green">● active</Text>      Interactive session, agent working</Text>
        <Text><Text color="blue">◉ idle</Text>        Interactive session, waiting for input</Text>
        <Text><Text color="cyan">✓ done</Text>        Finished successfully</Text>
        <Text><Text color="red">✗ failed</Text>      Finished with error</Text>
        <Text><Text color="yellow">◼ killed</Text>     Process died without clean exit</Text>
      </Box>
      <Text> </Text>

      <Text bold>List View</Text>
      <Box flexDirection="column" paddingLeft={2}>
        <Text><Text color="yellow">↑/k ↓/j</Text>  Move selection</Text>
        <Text><Text color="yellow">Enter/p</Text>   Peek — view session event log</Text>
        <Text><Text color="yellow">R</Text>         Resume — open session in pi</Text>
        <Text><Text color="yellow">K</Text>         Kill — SIGTERM running session</Text>
        <Text><Text color="yellow">!</Text>         Force kill — SIGKILL</Text>
        <Text><Text color="yellow">/</Text>         Search — filter sessions by log content</Text>
        <Text><Text color="yellow">f</Text>         Cycle filter (all → interactive → running → finished)</Text>
        <Text><Text color="yellow">s</Text>         Cycle sort (newest → status → cwd → cost)</Text>
        <Text><Text color="yellow">d</Text>         Filter by directory of selected session (toggle)</Text>
        <Text><Text color="yellow">r</Text>         Refresh — re-scan sessions</Text>
        <Text><Text color="yellow">q</Text>         Quit</Text>
      </Box>
      <Text> </Text>

      <Text bold>Search Mode</Text>
      <Box flexDirection="column" paddingLeft={2}>
        <Text><Text color="yellow">type</Text>    Live filter as you type</Text>
        <Text><Text color="yellow">Enter</Text>   Confirm search, return to list</Text>
        <Text><Text color="yellow">Esc</Text>     Cancel search, clear filter</Text>
        <Text><Text color="yellow">↑/↓</Text>     Navigate filtered results</Text>
      </Box>
      <Text> </Text>

      <Text bold>Peek View</Text>
      <Box flexDirection="column" paddingLeft={2}>
        <Text><Text color="yellow">↑/k ↓/j</Text>  Scroll</Text>
        <Text><Text color="yellow">G</Text>         Jump to bottom</Text>
        <Text><Text color="yellow">F</Text>         Toggle auto-scroll</Text>
        <Text><Text color="yellow">K</Text>         Kill running session</Text>
        <Text><Text color="yellow">q/Esc</Text>     Back to list</Text>
      </Box>
      <Text> </Text>

      <Text bold>Detection</Text>
      <Box flexDirection="column" paddingLeft={2}>
        <Text dimColor>Session activity is determined from the session log data (tool calls, stop reasons).</Text>
        <Text dimColor>Active vs idle: detected via session file growth between poll cycles</Text>
      </Box>
      <Text> </Text>
      <Text dimColor>Press ? to return</Text>
    </Box>
  );
}
