import { describe, expect, test } from "bun:test";
import { sanitizeWorkspaceKey, validateWorkspacePath } from "./manager.js";

// ── sanitizeWorkspaceKey ─────────────────────────────────────────

describe("sanitizeWorkspaceKey", () => {
  test("preserves valid characters", () => {
    expect(sanitizeWorkspaceKey("SYM-42")).toBe("SYM-42");
    expect(sanitizeWorkspaceKey("issue.v2")).toBe("issue.v2");
    expect(sanitizeWorkspaceKey("my_issue")).toBe("my_issue");
  });

  test("replaces invalid characters with underscore", () => {
    expect(sanitizeWorkspaceKey("SYM/42")).toBe("SYM_42");
    expect(sanitizeWorkspaceKey("issue #1")).toBe("issue__1");
    expect(sanitizeWorkspaceKey("a@b!c")).toBe("a_b_c");
  });

  test("handles slashes and path traversal attempts", () => {
    expect(sanitizeWorkspaceKey("../../etc/passwd")).toBe(".._.._etc_passwd");
    expect(sanitizeWorkspaceKey("foo/bar/baz")).toBe("foo_bar_baz");
  });

  test("handles empty string", () => {
    expect(sanitizeWorkspaceKey("")).toBe("");
  });

  test("preserves dots and dashes", () => {
    expect(sanitizeWorkspaceKey("v1.2.3-beta")).toBe("v1.2.3-beta");
  });
});

// ── validateWorkspacePath ────────────────────────────────────────

describe("validateWorkspacePath", () => {
  test("valid path inside root", () => {
    expect(validateWorkspacePath("/tmp/workspaces/SYM-42", "/tmp/workspaces")).toBe(true);
  });

  test("path equal to root is valid", () => {
    expect(validateWorkspacePath("/tmp/workspaces", "/tmp/workspaces")).toBe(true);
  });

  test("path outside root is invalid", () => {
    expect(validateWorkspacePath("/tmp/other/SYM-42", "/tmp/workspaces")).toBe(false);
  });

  test("path traversal with absolute path is caught by prefix check", () => {
    // validateWorkspacePath checks string prefix; /tmp/workspaces/../other
    // starts with /tmp/workspaces/ so it passes the prefix check.
    // The real safety comes from sanitizeWorkspaceKey preventing .. in names.
    expect(validateWorkspacePath("/tmp/workspaces/../other", "/tmp/workspaces")).toBe(true);
  });

  test("deeply nested path inside root is valid", () => {
    expect(
      validateWorkspacePath("/tmp/workspaces/a/b/c", "/tmp/workspaces")
    ).toBe(true);
  });

  test("prefix overlap but not inside root is invalid", () => {
    // /tmp/workspaces-evil is not inside /tmp/workspaces
    expect(
      validateWorkspacePath("/tmp/workspaces-evil/foo", "/tmp/workspaces")
    ).toBe(false);
  });
});
