import { Badge } from "./ui/badge";
import { formatElapsed } from "../lib/utils";
import type { RuntimeSnapshot } from "../lib/use-sse";

interface AgentTableProps {
  running: RuntimeSnapshot["running"];
}

export function AgentTable({ running }: AgentTableProps) {
  if (running.length === 0) {
    return (
      <div className="rounded-lg border border-border p-8 text-center text-muted-foreground">
        No agents running
      </div>
    );
  }

  return (
    <div className="rounded-lg border border-border overflow-hidden">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-border bg-muted/50">
            <th className="text-left p-3 font-medium text-muted-foreground">Issue</th>
            <th className="text-left p-3 font-medium text-muted-foreground">Workflow</th>
            <th className="text-left p-3 font-medium text-muted-foreground">State</th>
            <th className="text-right p-3 font-medium text-muted-foreground">Turns</th>
            <th className="text-right p-3 font-medium text-muted-foreground">Duration</th>
          </tr>
        </thead>
        <tbody>
          {running.map((agent) => (
            <tr key={agent.issue_id} className="border-b border-border last:border-0 hover:bg-muted/30">
              <td className="p-3 font-mono">{agent.issue_identifier}</td>
              <td className="p-3">
                {agent.workflow ? (
                  <Badge variant="secondary">{agent.workflow}</Badge>
                ) : (
                  <span className="text-muted-foreground">-</span>
                )}
              </td>
              <td className="p-3">
                <Badge variant="success">{agent.state}</Badge>
              </td>
              <td className="p-3 text-right font-mono">{agent.turn_count}</td>
              <td className="p-3 text-right font-mono">{formatElapsed(agent.started_at)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
