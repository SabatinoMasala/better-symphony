import type { LogLine } from "./types.js";

const SOURCE_COLORS = [
  "#00CCCC",
  "#00CC00",
  "#CCCC00",
  "#CC00CC",
  "#5555FF",
  "#55FF55",
  "#55FFFF",
  "#FF55FF",
] as const;

const colorMap = new Map<string, string>();
colorMap.set("orchestrator", "#888888");
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

  return (
    <box flexDirection="column" height={logHeight + 2} overflow="hidden" border borderStyle="rounded" borderColor="#444444" paddingX={1}>
      {visibleLines.map((line, i) => (
        <LogLineRow key={startIdx + i} line={line} showSource={showSource} />
      ))}
    </box>
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
      ? "#FF4444"
      : line.type === "info"
        ? "#00CCCC"
        : line.type === "comment"
          ? "#888888"
          : "#CCCCCC";

  const sourceLabel = `[${line.source}]`.padEnd(SOURCE_WIDTH).slice(0, SOURCE_WIDTH);

  return (
    <box height={1} overflow="hidden">
      <text>
        {showSource && (
          <span fg={getSourceColor(line.source)}>
            <strong>{sourceLabel} </strong>
          </span>
        )}
        <span fg={msgColor}>{line.message}</span>
      </text>
    </box>
  );
}
