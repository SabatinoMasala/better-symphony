import type { RuntimeSnapshot } from "../orchestrator/state.js";

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

interface StatusBarProps {
  snapshot: RuntimeSnapshot | null;
  shuttingDown: boolean;
}

export function StatusBar({ snapshot, shuttingDown }: StatusBarProps) {
  if (shuttingDown) {
    return (
      <box border borderStyle="rounded" borderColor="#444444" paddingX={1}>
        <text>
          <span fg="#FF4444"><strong>Shutting down...</strong></span>
          <span fg="#888888"> (press q again to force)</span>
        </text>
      </box>
    );
  }

  const running = snapshot?.running.length ?? 0;
  const retrying = snapshot?.retrying.length ?? 0;
  const tokens = snapshot?.token_totals.total_tokens ?? 0;
  const uptime = snapshot?.token_totals.seconds_running ?? 0;

  return (
    <box flexDirection="row" border borderStyle="rounded" borderColor="#444444" paddingX={1}>
      <box>
        <text>
          <span fg="#888888">agents:</span>
          {running > 0 ? (
            <span fg="#00FF00"><strong>{` ${running}`}</strong></span>
          ) : (
            <span fg="#666666"> idle</span>
          )}
          {retrying > 0 && (
            <span fg="#FFFF00">{` | retry: ${retrying}`}</span>
          )}
          <span fg="#888888">{` | tokens: `}</span>
          <span fg="#CCCCCC">{formatTokens(tokens)}</span>
          <span fg="#888888">{` | up: `}</span>
          <span fg="#CCCCCC">{formatDuration(uptime)}</span>
        </text>
      </box>
      <box flexGrow={1} />
      <box>
        <text>
          <span fg="#666666">q</span>
          <span fg="#555555">{` quit  `}</span>
          <span fg="#666666">j/k</span>
          <span fg="#555555">{` scroll  `}</span>
          <span fg="#666666">[/]</span>
          <span fg="#555555">{` tabs  `}</span>
          <span fg="#666666">r</span>
          <span fg="#555555">{` poll`}</span>
        </text>
      </box>
    </box>
  );
}
