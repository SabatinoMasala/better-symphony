/**
 * Agent Session
 * Manages a single coding agent session lifecycle
 */

import type { LiveSession, TokenTotals, RateLimitInfo } from "../config/types.js";

export function createSession(threadId: string, turnId: string, pid: string | null): LiveSession {
  return {
    session_id: `${threadId}-${turnId}`,
    thread_id: threadId,
    turn_id: turnId,
    process_pid: pid,
    last_event: null,
    last_activity_at: null,
    last_message: null,
    input_tokens: 0,
    output_tokens: 0,
    total_tokens: 0,
    last_reported_input_tokens: 0,
    last_reported_output_tokens: 0,
    last_reported_total_tokens: 0,
    turn_count: 1,
    cost_usd: 0,
    duration_ms: 0,
  };
}

export function updateSessionTurnId(session: LiveSession, turnId: string): void {
  session.turn_id = turnId;
  session.session_id = `${session.thread_id}-${turnId}`;
  session.turn_count++;
}

export function updateSessionEvent(
  session: LiveSession,
  event: string,
  message?: string
): void {
  session.last_event = event;
  session.last_activity_at = new Date();
  if (message) {
    session.last_message = message.slice(0, 500);
  }
}

export function updateSessionTokens(
  session: LiveSession,
  usage: {
    input_tokens?: number;
    output_tokens?: number;
    total_tokens?: number;
  }
): {
  delta_input: number;
  delta_output: number;
  delta_total: number;
} {
  const inputTokens = usage.input_tokens ?? 0;
  const outputTokens = usage.output_tokens ?? 0;
  const totalTokens = usage.total_tokens ?? 0;

  // Calculate deltas from last reported (for absolute totals)
  const delta_input = Math.max(0, inputTokens - session.last_reported_input_tokens);
  const delta_output = Math.max(0, outputTokens - session.last_reported_output_tokens);
  const delta_total = Math.max(0, totalTokens - session.last_reported_total_tokens);

  // Update session totals
  session.input_tokens = inputTokens;
  session.output_tokens = outputTokens;
  session.total_tokens = totalTokens;

  // Update last reported for delta tracking
  session.last_reported_input_tokens = inputTokens;
  session.last_reported_output_tokens = outputTokens;
  session.last_reported_total_tokens = totalTokens;

  return { delta_input, delta_output, delta_total };
}

export function createEmptyTotals(): TokenTotals {
  return {
    input_tokens: 0,
    output_tokens: 0,
    total_tokens: 0,
    seconds_running: 0,
  };
}

export function updateTotals(
  totals: TokenTotals,
  deltas: { delta_input: number; delta_output: number; delta_total: number }
): void {
  totals.input_tokens += deltas.delta_input;
  totals.output_tokens += deltas.delta_output;
  totals.total_tokens += deltas.delta_total;
}

export function parseRateLimits(payload: unknown): RateLimitInfo | null {
  if (!payload || typeof payload !== "object") return null;

  const info: RateLimitInfo = {};
  const p = payload as Record<string, unknown>;

  if (typeof p.requests_limit === "number") info.requests_limit = p.requests_limit;
  if (typeof p.requests_remaining === "number") info.requests_remaining = p.requests_remaining;
  if (typeof p.requests_reset === "number") info.requests_reset = p.requests_reset;
  if (typeof p.tokens_limit === "number") info.tokens_limit = p.tokens_limit;
  if (typeof p.tokens_remaining === "number") info.tokens_remaining = p.tokens_remaining;
  if (typeof p.tokens_reset === "number") info.tokens_reset = p.tokens_reset;

  return Object.keys(info).length > 0 ? info : null;
}
