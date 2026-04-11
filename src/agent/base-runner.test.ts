import { describe, expect, test } from "bun:test";
import { stripAnsi, extractBlockText } from "./base-runner.js";

describe("stripAnsi", () => {
  test("strips color escape sequences", () => {
    expect(stripAnsi("\u001B[31mred text\u001B[0m")).toBe("red text");
  });

  test("strips bold/underline sequences", () => {
    expect(stripAnsi("\u001B[1mbold\u001B[22m \u001B[4munderline\u001B[24m")).toBe(
      "bold underline"
    );
  });

  test("preserves clean text", () => {
    expect(stripAnsi("plain text")).toBe("plain text");
  });

  test("strips carriage returns", () => {
    expect(stripAnsi("line1\r\nline2\r")).toBe("line1\nline2");
  });

  test("handles empty string", () => {
    expect(stripAnsi("")).toBe("");
  });

  test("strips cursor movement sequences", () => {
    expect(stripAnsi("\u001B[2Ahello\u001B[K")).toBe("hello");
  });

  test("strips multiple sequences in one string", () => {
    expect(
      stripAnsi("\u001B[32m✓\u001B[0m test \u001B[31m✗\u001B[0m fail")
    ).toBe("✓ test ✗ fail");
  });
});

describe("extractBlockText", () => {
  test("extracts text from flat text blocks", () => {
    const blocks = [
      { type: "text", text: "hello" },
      { type: "text", text: "world" },
    ];
    expect(extractBlockText(blocks)).toBe("hello world");
  });

  test("handles string blocks directly", () => {
    expect(extractBlockText(["hello", "world"])).toBe("hello world");
  });

  test("extracts from content property", () => {
    const blocks = [{ content: "inline content" }];
    expect(extractBlockText(blocks)).toBe("inline content");
  });

  test("handles nested content arrays", () => {
    const blocks = [
      {
        content: [
          { text: "nested1" },
          { text: "nested2" },
        ],
      },
    ];
    expect(extractBlockText(blocks)).toBe("nested1 nested2");
  });

  test("handles mixed types", () => {
    const blocks = [
      "plain",
      { text: "text-prop" },
      { content: "content-prop" },
      { content: [{ text: "deep" }] },
    ];
    expect(extractBlockText(blocks)).toBe("plain text-prop content-prop deep");
  });

  test("returns empty string for empty array", () => {
    expect(extractBlockText([])).toBe("");
  });

  test("skips blocks with no extractable text", () => {
    const blocks = [
      { type: "image", data: "binary" },
      { text: "valid" },
    ];
    expect(extractBlockText(blocks)).toBe("valid");
  });

  test("filters out empty strings", () => {
    const blocks = [
      { text: "" },
      { text: "real" },
      { content: "" },
    ];
    expect(extractBlockText(blocks)).toBe("real");
  });
});
