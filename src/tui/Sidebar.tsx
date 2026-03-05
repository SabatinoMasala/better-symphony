import { Box, Text } from "ink";
import type { RuntimeSnapshot } from "../orchestrator/state.js";

interface SidebarProps {
  tabs: string[];
  selectedTab: number;
  snapshot: RuntimeSnapshot | null;
  shuttingDown: boolean;
  height: number;
  focused: boolean;
}

const SIDEBAR_WIDTH = 24;

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

function formatDuration(seconds: number): string {
  if (seconds < 60) return `${Math.round(seconds)}s`;
  const mins = Math.floor(seconds / 60);
  const secs = Math.round(seconds % 60);
  return `${mins}m${secs}s`;
}

export function Sidebar({
  tabs,
  selectedTab,
  snapshot,
  shuttingDown,
  height,
  focused,
}: SidebarProps) {
  const runningCount = snapshot?.running.length ?? 0;
  const retryingCount = snapshot?.retrying.length ?? 0;
  const totalTokens = snapshot?.token_totals.total_tokens ?? 0;
  const secondsRunning = snapshot?.token_totals.seconds_running ?? 0;

  return (
    <Box
      flexDirection="column"
      width={SIDEBAR_WIDTH}
      height={height}
      borderStyle="single"
      borderLeft={false}
      borderTop={false}
      borderBottom={false}
      borderColor={focused ? "cyan" : "gray"}
      paddingLeft={1}
    >
      {/* Status Section */}
      <Box flexDirection="column">
        <Text bold color="white">
          Symphony
        </Text>
        <Text dimColor>{"─".repeat(SIDEBAR_WIDTH - 4)}</Text>

        {shuttingDown ? (
          <Text color="red" bold>
            Shutting down...
          </Text>
        ) : (
          <>
            <Box>
              <Text dimColor>agents: </Text>
              {runningCount > 0 ? (
                <Text color="green" bold>
                  {runningCount} running
                </Text>
              ) : (
                <Text dimColor>idle</Text>
              )}
            </Box>
            {retryingCount > 0 && (
              <Box>
                <Text dimColor>retry: </Text>
                <Text color="yellow">{retryingCount} queued</Text>
              </Box>
            )}
            <Box>
              <Text dimColor>tokens: </Text>
              <Text>{formatTokens(totalTokens)}</Text>
            </Box>
            <Box>
              <Text dimColor>uptime: </Text>
              <Text>{formatDuration(secondsRunning)}</Text>
            </Box>
          </>
        )}
      </Box>

      {/* Running Agents Section */}
      <Box flexDirection="column" marginTop={1} flexGrow={1}>
        <Text bold color="white">
          Agents
        </Text>
        <Text dimColor>{"─".repeat(SIDEBAR_WIDTH - 4)}</Text>

        {tabs.map((tab, i) => {
          const isSelected = i === selectedTab;
          // Find running info for this tab
          const runInfo = snapshot?.running.find(
            (r) => r.issue_identifier === tab
          );
          const retryInfo = snapshot?.retrying.find(
            (r) => r.identifier === tab
          );

          let statusIcon = "";
          let statusColor: string = "gray";
          let workflowTag = "";
          if (runInfo) {
            statusIcon = " ●";
            statusColor = "green";
            if (runInfo.workflow) workflowTag = ` (${runInfo.workflow})`;
          } else if (retryInfo) {
            statusIcon = " ↻";
            statusColor = "yellow";
            if (retryInfo.workflow) workflowTag = ` (${retryInfo.workflow})`;
          }

          return (
            <Box key={tab}>
              <Text
                bold={isSelected}
                color={isSelected ? "cyan" : "gray"}
              >
                {isSelected ? ">" : " "}
                {tab}
              </Text>
              {statusIcon && (
                <Text color={statusColor}>{statusIcon}</Text>
              )}
              {workflowTag && (
                <Text dimColor>{workflowTag}</Text>
              )}
            </Box>
          );
        })}
      </Box>

      {/* Keybinds Section */}
      <Box flexDirection="column">
        <Text dimColor>{"─".repeat(SIDEBAR_WIDTH - 4)}</Text>
        <Text dimColor>
          <Text bold color="gray">q</Text> quit
        </Text>
        <Text dimColor>
          <Text bold color="gray">↑↓</Text> nav   <Text bold color="gray">G</Text> end
        </Text>
        <Text dimColor>
          <Text bold color="gray">←→</Text> focus  <Text bold color="gray">r</Text> refresh
        </Text>
      </Box>
    </Box>
  );
}
