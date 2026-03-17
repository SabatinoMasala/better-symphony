import { Badge } from "./ui/badge";
import type { RuntimeSnapshot } from "../lib/use-sse";

function formatTimeUntil(dateStr: string): string {
  const ms = new Date(dateStr).getTime() - Date.now();
  if (ms <= 0) return "now";
  const s = Math.ceil(ms / 1000);
  if (s < 60) return `${s}s`;
  return `${Math.floor(s / 60)}m ${s % 60}s`;
}

interface RetryTableProps {
  retrying: RuntimeSnapshot["retrying"];
}

export function RetryTable({ retrying }: RetryTableProps) {
  if (retrying.length === 0) return null;

  return (
    <div>
      <h2 className="text-sm font-medium text-muted-foreground mb-2">Retrying</h2>
      <div className="rounded-lg border border-border overflow-hidden">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-border bg-muted/50">
              <th className="text-left p-3 font-medium text-muted-foreground">Issue</th>
              <th className="text-left p-3 font-medium text-muted-foreground">Workflow</th>
              <th className="text-right p-3 font-medium text-muted-foreground">Attempt</th>
              <th className="text-right p-3 font-medium text-muted-foreground">Retry In</th>
              <th className="text-left p-3 font-medium text-muted-foreground">Error</th>
            </tr>
          </thead>
          <tbody>
            {retrying.map((entry) => (
              <tr key={entry.issue_id} className="border-b border-border last:border-0 hover:bg-muted/30">
                <td className="p-3 font-mono">{entry.identifier}</td>
                <td className="p-3">
                  {entry.workflow ? (
                    <Badge variant="secondary">{entry.workflow}</Badge>
                  ) : (
                    <span className="text-muted-foreground">-</span>
                  )}
                </td>
                <td className="p-3 text-right font-mono">#{entry.attempt}</td>
                <td className="p-3 text-right font-mono">
                  <Badge variant="warning">{formatTimeUntil(entry.due_at)}</Badge>
                </td>
                <td className="p-3 text-muted-foreground truncate max-w-xs">
                  {entry.error ?? "-"}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
