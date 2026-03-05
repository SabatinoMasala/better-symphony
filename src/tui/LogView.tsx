import { Box, Text } from "ink";
import type { LogLine } from "./types.js";

const SOURCE_COLORS = [
  "cyan",
  "green",
  "yellow",
  "magenta",
  "blue",
  "greenBright",
  "cyanBright",
  "magentaBright",
] as const;

const colorMap = new Map<string, string>();
colorMap.set("orchestrator", "gray");
let colorIndex = 0;

function getSourceColor(source: string): string {
  if (!colorMap.has(source)) {
    colorMap.set(source, SOURCE_COLORS[colorIndex % SOURCE_COLORS.length]);
    colorIndex++;
  }
  return colorMap.get(source)!;
}

interface LogViewProps {
  lines: LogLine[];
  scrollOffset: number;
  autoFollow: boolean;
  height: number;
  showSource: boolean;
}

export function LogView({
  lines,
  scrollOffset,
  autoFollow,
  height,
  showSource,
}: LogViewProps) {
  const logHeight = Math.max(1, height);
  const totalLines = lines.length;

  let startIdx: number;
  if (autoFollow || scrollOffset === 0) {
    startIdx = Math.max(0, totalLines - logHeight);
  } else {
    startIdx = Math.max(0, totalLines - logHeight - scrollOffset);
  }
  const endIdx = Math.min(totalLines, startIdx + logHeight);

  const visibleLines = lines.slice(startIdx, endIdx);

  const padCount = logHeight - visibleLines.length;

  return (
    <Box flexDirection="column" flexGrow={1} height={logHeight} overflow="hidden">
      {visibleLines.map((line, i) => (
        <LogLineRow key={startIdx + i} line={line} showSource={showSource} />
      ))}
      {padCount > 0 &&
        Array.from({ length: padCount }, (_, i) => (
          <Box key={`pad-${i}`} height={1}>
            <Text> </Text>
          </Box>
        ))}
    </Box>
  );
}

const SOURCE_WIDTH = 18;

function LogLineRow({
  line,
  showSource,
}: {
  line: LogLine;
  showSource: boolean;
}) {
  const msgColor =
    line.type === "error"
      ? "red"
      : line.type === "info"
        ? "cyan"
        : line.type === "comment"
          ? "gray"
          : "white";

  const sourceLabel = `[${line.source}]`.padEnd(SOURCE_WIDTH).slice(0, SOURCE_WIDTH);

  return (
    <Box height={1} overflow="hidden">
      {showSource && (
        <Text bold color={getSourceColor(line.source)} wrap="truncate">
          {sourceLabel}{" "}
        </Text>
      )}
      <Text color={msgColor} wrap="truncate">
        {line.message}
      </Text>
    </Box>
  );
}
