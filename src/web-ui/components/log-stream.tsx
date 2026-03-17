import { useRef, useEffect, useState, useMemo } from "react";
import { Badge } from "./ui/badge";
import { Button } from "./ui/button";
import { cn } from "../lib/utils";
import { ArrowDown } from "lucide-react";
import type { LogLine } from "../lib/use-sse";

interface LogStreamProps {
  logs: LogLine[];
}

const TYPE_COLORS: Record<LogLine["type"], string> = {
  error: "text-destructive",
  info: "text-blue-400",
  comment: "text-muted-foreground",
  line: "text-foreground",
};

export function LogStream({ logs }: LogStreamProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [autoFollow, setAutoFollow] = useState(true);
  const [sourceFilter, setSourceFilter] = useState<string>("all");

  // Derive unique sources
  const sources = useMemo(() => {
    const set = new Set<string>();
    for (const log of logs) set.add(log.source);
    return Array.from(set).sort();
  }, [logs]);

  const filteredLogs = useMemo(() => {
    if (sourceFilter === "all") return logs;
    return logs.filter((l) => l.source === sourceFilter);
  }, [logs, sourceFilter]);

  // Auto-scroll to bottom
  useEffect(() => {
    if (autoFollow && containerRef.current) {
      containerRef.current.scrollTop = containerRef.current.scrollHeight;
    }
  }, [filteredLogs, autoFollow]);

  const handleScroll = () => {
    if (!containerRef.current) return;
    const { scrollTop, scrollHeight, clientHeight } = containerRef.current;
    const atBottom = scrollHeight - scrollTop - clientHeight < 40;
    setAutoFollow(atBottom);
  };

  return (
    <div className="flex flex-col flex-1 min-h-0">
      <div className="flex items-center justify-between mb-2">
        <h2 className="text-sm font-medium text-muted-foreground">Logs</h2>
        <div className="flex items-center gap-2">
          <select
            className="text-xs bg-muted border border-border rounded px-2 py-1 text-foreground"
            value={sourceFilter}
            onChange={(e) => setSourceFilter(e.target.value)}
          >
            <option value="all">All sources</option>
            {sources.map((s) => (
              <option key={s} value={s}>{s}</option>
            ))}
          </select>
          {!autoFollow && (
            <Button size="sm" variant="ghost" onClick={() => setAutoFollow(true)}>
              <ArrowDown className="h-3.5 w-3.5" />
            </Button>
          )}
        </div>
      </div>

      <div
        ref={containerRef}
        onScroll={handleScroll}
        className="flex-1 min-h-0 overflow-y-auto rounded-lg border border-border bg-black/30 p-2 font-mono text-xs leading-5"
      >
        {filteredLogs.map((log, i) => (
          <div key={i} className="flex gap-2 hover:bg-muted/20 px-1">
            <span className="text-muted-foreground shrink-0 w-[70px]">
              {new Date(log.timestamp).toLocaleTimeString()}
            </span>
            <Badge
              variant={log.source === "orchestrator" ? "secondary" : "outline"}
              className="shrink-0 text-[10px] px-1.5 py-0 h-4 mt-0.5"
            >
              {log.source.length > 12 ? log.source.slice(0, 12) : log.source}
            </Badge>
            <span className={cn("break-all", TYPE_COLORS[log.type])}>
              {log.message}
            </span>
          </div>
        ))}
        {filteredLogs.length === 0 && (
          <div className="text-muted-foreground text-center py-8">No logs yet</div>
        )}
      </div>
    </div>
  );
}
