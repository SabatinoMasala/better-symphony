export interface LogLine {
  source: string;
  message: string;
  type: "line" | "error" | "info" | "comment";
  timestamp: number;
}
