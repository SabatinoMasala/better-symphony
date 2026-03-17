import { Card, CardHeader, CardTitle, CardContent } from "./ui/card";
import { formatTokens, formatDuration } from "../lib/utils";
import type { RuntimeSnapshot } from "../lib/use-sse";

interface StatsCardsProps {
  snapshot: RuntimeSnapshot | null;
}

export function StatsCards({ snapshot }: StatsCardsProps) {
  const running = snapshot?.running.length ?? 0;
  const retrying = snapshot?.retrying.length ?? 0;
  const tokens = snapshot?.token_totals.total_tokens ?? 0;
  const seconds = snapshot?.token_totals.seconds_running ?? 0;

  return (
    <div className="grid grid-cols-4 gap-4">
      <Card>
        <CardHeader>
          <CardTitle>Running Agents</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="text-2xl font-bold text-success">{running}</div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Retrying</CardTitle>
        </CardHeader>
        <CardContent>
          <div className={`text-2xl font-bold ${retrying > 0 ? "text-warning" : "text-muted-foreground"}`}>
            {retrying}
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Total Tokens</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="text-2xl font-bold">{formatTokens(tokens)}</div>
          <div className="text-xs text-muted-foreground mt-1">
            {formatTokens(snapshot?.token_totals.input_tokens ?? 0)} in / {formatTokens(snapshot?.token_totals.output_tokens ?? 0)} out
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
  );
}
