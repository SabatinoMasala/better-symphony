import { describe, expect, test } from "bun:test";
import { interpolateProfile, deepMergeConfig } from "./profiles.js";
import type { WorkflowConfig } from "./types.js";

// ── interpolateProfile ───────────────────────────────────────────

describe("interpolateProfile", () => {
  test("replaces simple profile references", () => {
    const result = interpolateProfile(
      "project: ${profile.project_slug}",
      { project_slug: "my-proj" }
    );
    expect(result).toBe("project: my-proj");
  });

  test("replaces multiple references", () => {
    const result = interpolateProfile(
      "${profile.a} and ${profile.b}",
      { a: "foo", b: "bar" }
    );
    expect(result).toBe("foo and bar");
  });

  test("replaces nested references", () => {
    const result = interpolateProfile(
      "key: ${profile.db.host}",
      { db: { host: "localhost" } }
    );
    expect(result).toBe("key: localhost");
  });

  test("throws on unresolved reference", () => {
    expect(() =>
      interpolateProfile("${profile.missing}", {})
    ).toThrow("Unresolved profile reference");
  });

  test("returns string unchanged when no references", () => {
    const raw = "no references here";
    expect(interpolateProfile(raw, {})).toBe(raw);
  });

  test("handles numeric values", () => {
    const result = interpolateProfile("port: ${profile.port}", { port: 3000 });
    expect(result).toBe("port: 3000");
  });

  test("handles boolean values", () => {
    const result = interpolateProfile("flag: ${profile.enabled}", { enabled: true });
    expect(result).toBe("flag: true");
  });

  test("deeply nested paths", () => {
    const result = interpolateProfile(
      "${profile.a.b.c.d}",
      { a: { b: { c: { d: "deep" } } } }
    );
    expect(result).toBe("deep");
  });
});

// ── deepMergeConfig ──────────────────────────────────────────────

describe("deepMergeConfig", () => {
  test("merges agent block", () => {
    const base: WorkflowConfig = {
      agent: {
        binary: "claude",
        max_turns: 10,
        permission_mode: "acceptEdits",
      },
    };
    const profile = {
      agent: {
        max_turns: 25,
        append_system_prompt: "Be concise",
      },
    };

    const result = deepMergeConfig(base, profile);
    expect(result.agent?.binary).toBe("claude"); // preserved from base
    expect(result.agent?.max_turns).toBe(25); // overridden by profile
    expect(result.agent?.permission_mode).toBe("acceptEdits"); // preserved from base
    expect(result.agent?.append_system_prompt).toBe("Be concise"); // added by profile
  });

  test("does not mutate base config", () => {
    const base: WorkflowConfig = { agent: { binary: "claude" } };
    const baseCopy = { ...base, agent: { ...base.agent } };
    deepMergeConfig(base, { agent: { binary: "codex" } });
    expect(base.agent?.binary).toBe(baseCopy.agent?.binary);
  });

  test("handles profile with no agent block", () => {
    const base: WorkflowConfig = { agent: { binary: "claude" } };
    const result = deepMergeConfig(base, { other: "value" });
    expect(result.agent?.binary).toBe("claude");
  });

  test("handles base with no agent block", () => {
    const base: WorkflowConfig = {};
    const result = deepMergeConfig(base, { agent: { binary: "codex" } });
    expect(result.agent?.binary).toBe("codex");
  });

  test("preserves non-agent config", () => {
    const base: WorkflowConfig = {
      tracker: { kind: "linear" },
      agent: { binary: "claude" },
    };
    const result = deepMergeConfig(base, { agent: { binary: "codex" } });
    expect(result.tracker?.kind).toBe("linear");
  });
});
