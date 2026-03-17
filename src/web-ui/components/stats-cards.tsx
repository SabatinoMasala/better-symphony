import { useState, useMemo } from "react";
import { Card, CardHeader, CardTitle, CardContent } from "./ui/card";
import { Badge } from "./ui/badge";
import { formatDuration, formatElapsed } from "../lib/utils";
import type { RuntimeSnapshot } from "../lib/use-sse";

interface StatsCardsProps {
  snapshot: RuntimeSnapshot | null;
  onAgentClick?: (issueIdentifier: string) => void;
}

export function StatsCards({ snapshot, onAgentClick }: StatsCardsProps) {
  const [showModal, setShowModal] = useState(false);

  const running = snapshot?.running.length ?? 0;
  const workflows = snapshot?.workflows ?? [];
  const totalSlots = workflows.reduce((s, w) => s + w.max_concurrent_agents, 0);
  const seconds = snapshot?.token_totals.seconds_running ?? 0;

  // Group running agents by workflow name for the modal
  const agentsByWorkflow = useMemo(() => {
    if (!snapshot) return new Map<string, RuntimeSnapshot["running"]>();
    const map = new Map<string, RuntimeSnapshot["running"]>();
    for (const agent of snapshot.running) {
      const key = agent.workflow ?? "default";
      const list = map.get(key);
      if (list) list.push(agent);
      else map.set(key, [agent]);
    }
    return map;
  }, [snapshot]);

  return (
    <>
      <div className="grid grid-cols-3 gap-3 sm:gap-4">
        <Card>
          <CardHeader>
            <CardTitle>Running Agents</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold text-success">{running}</div>
          </CardContent>
        </Card>

        <Card
          className="cursor-pointer hover:border-muted-foreground transition-colors"
          onClick={() => setShowModal(true)}
        >
          <CardHeader>
            <CardTitle>Workflows</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">
              {workflows.length}
              <span className="text-muted-foreground text-base font-normal ml-1">
                ({totalSlots} slots)
              </span>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Agent Runtime</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{formatDuration(seconds)}</div>
          </CardContent>
        </Card>
      </div>

      {showModal && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/60"
          onClick={() => setShowModal(false)}
        >
          <div
            className="bg-card border border-border rounded-lg shadow-xl w-full max-w-lg mx-4"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between p-4 border-b border-border">
              <h3 className="text-lg font-semibold">Workflows</h3>
              <button
                className="text-muted-foreground hover:text-foreground text-xl leading-none px-2"
                onClick={() => setShowModal(false)}
              >
                &times;
              </button>
            </div>

            <div className="p-4 space-y-3">
              {workflows.length === 0 ? (
                <div className="text-center text-muted-foreground py-4">No workflows loaded</div>
              ) : (
                workflows.map((wf) => {
                  const available = wf.max_concurrent_agents - wf.running_count;
                  const agents = agentsByWorkflow.get(wf.name) ?? [];
                  return (
                    <div key={wf.name} className="bg-muted/20 rounded-lg p-3">
                      <div className="flex items-center justify-between mb-2">
                        <span className="font-medium">{wf.name}</span>
                        <Badge variant={wf.running_count > 0 ? "success" : "secondary"} className="text-xs">
                          {wf.running_count} / {wf.max_concurrent_agents} agents
                        </Badge>
                      </div>
                      <div className="w-full bg-muted rounded-full h-1.5">
                        <div
                          className="bg-success rounded-full h-1.5 transition-all"
                          style={{ width: `${wf.max_concurrent_agents > 0 ? (wf.running_count / wf.max_concurrent_agents) * 100 : 0}%` }}
                        />
                      </div>
                      <div className="text-xs text-muted-foreground mt-1.5">
                        {available} slot{available !== 1 ? "s" : ""} available
                      </div>

                      {agents.map((agent) => (
                        <div
                          key={agent.issue_id}
                          className="flex items-center justify-between mt-2 bg-muted/20 rounded px-2.5 py-1.5 text-sm cursor-pointer hover:bg-muted/40 transition-colors"
                          onClick={() => {
                            onAgentClick?.(agent.issue_identifier);
                            setShowModal(false);
                          }}
                        >
                          <span className="font-mono text-xs">{agent.issue_identifier}</span>
                          <div className="flex items-center gap-2 text-xs text-muted-foreground">
                            <span>{agent.turn_count} turns</span>
                            <span>{formatElapsed(agent.started_at)}</span>
                          </div>
                        </div>
                      ))}
                    </div>
                  );
                })
              )}
            </div>
          </div>
        </div>
      )}
    </>
  );
}
