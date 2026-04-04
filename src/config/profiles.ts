/**
 * Matrix Profile Expansion
 * Expands a single workflow file with profiles/matrix into N virtual workflows.
 */

import { readFileSync } from "fs";
import { parse as parseYaml } from "yaml";
import { basename } from "path";
import type { WorkflowConfig, WorkflowDefinition, AgentConfig, ExpandedWorkflow } from "./types.js";
import { WorkflowError } from "./types.js";

// ── Interpolation ──────────────────────────────────────────────

function getNestedValue(obj: Record<string, unknown>, path: string): unknown {
  const parts = path.split(".");
  let current: unknown = obj;
  for (const part of parts) {
    if (current === null || current === undefined || typeof current !== "object") return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

/**
 * Replace ${profile.*} references in a string with values from the profile.
 * Throws on unresolved references.
 */
export function interpolateProfile(raw: string, profile: Record<string, unknown>): string {
  return raw.replace(/\$\{profile\.([^}]+)\}/g, (_match, key: string) => {
    const value = getNestedValue(profile, key);
    if (value === undefined) {
      throw new WorkflowError(
        "workflow_parse_error",
        `Unresolved profile reference: \${profile.${key}}`
      );
    }
    return String(value ?? "");
  });
}

// ── Deep Merge ─────────────────────────────────────────────────

/**
 * Deep-merge profile config overrides into workflow config.
 * Currently handles: agent block.
 */
export function deepMergeConfig(base: WorkflowConfig, profile: Record<string, unknown>): WorkflowConfig {
  const result = { ...base };

  if (profile.agent && typeof profile.agent === "object") {
    result.agent = {
      ...result.agent,
      ...(profile.agent as Partial<AgentConfig>),
    };
  }

  return result;
}

// ── Frontmatter Extraction ─────────────────────────────────────

function extractFrontmatter(content: string): { raw: string; body: string } | null {
  if (!content.startsWith("---")) return null;
  const endIndex = content.indexOf("\n---", 3);
  if (endIndex === -1) return null;
  return {
    raw: content.slice(4, endIndex),
    body: content.slice(endIndex + 4).trim(),
  };
}

// ── Expansion ──────────────────────────────────────────────────

/**
 * Expand a single workflow file into ExpandedWorkflow refs.
 * Non-matrix files return a single-element array.
 */
export function expandWorkflowFile(filePath: string): ExpandedWorkflow[] {
  const name = basename(filePath, ".md");

  let content: string;
  try {
    content = readFileSync(filePath, "utf-8");
  } catch {
    return [{ path: filePath, virtualName: name }];
  }

  const fm = extractFrontmatter(content);
  if (!fm) return [{ path: filePath, virtualName: name }];

  let parsed: Record<string, unknown>;
  try {
    parsed = parseYaml(fm.raw) as Record<string, unknown>;
  } catch {
    return [{ path: filePath, virtualName: name }];
  }

  if (!parsed || typeof parsed !== "object") {
    return [{ path: filePath, virtualName: name }];
  }

  const matrix = parsed.matrix as string[] | undefined;
  const profiles = parsed.profiles as Record<string, Record<string, unknown>> | undefined;

  if (!matrix || !Array.isArray(matrix)) {
    return [{ path: filePath, virtualName: name }];
  }

  if (matrix.length === 0) {
    return [];
  }

  if (!profiles || typeof profiles !== "object") {
    throw new WorkflowError(
      "workflow_parse_error",
      `Workflow '${basename(filePath)}' uses matrix but defines no profiles`
    );
  }

  for (const profileName of matrix) {
    if (!profiles[profileName]) {
      throw new WorkflowError(
        "workflow_parse_error",
        `Profile '${profileName}' not found in workflow '${basename(filePath)}'`
      );
    }
  }

  return matrix.map((profileName) => ({
    path: filePath,
    profileName,
    virtualName: `${name}:${profileName}`,
  }));
}

/**
 * Expand multiple workflow file paths into a flat list of ExpandedWorkflow refs.
 */
export function expandWorkflowPaths(filePaths: string[]): ExpandedWorkflow[] {
  return filePaths.flatMap((p) => expandWorkflowFile(p));
}

/**
 * Load a workflow definition for a specific matrix profile.
 * Interpolates ${profile.*} references and deep-merges profile config overrides.
 */
export function loadProfileWorkflow(filePath: string, profileName: string): WorkflowDefinition {
  const content = readFileSync(filePath, "utf-8");
  const fm = extractFrontmatter(content);

  if (!fm) {
    throw new WorkflowError("workflow_parse_error", `No frontmatter found in ${filePath}`);
  }

  let fullParsed: Record<string, unknown>;
  try {
    fullParsed = parseYaml(fm.raw) as Record<string, unknown>;
  } catch (err) {
    throw new WorkflowError(
      "workflow_parse_error",
      `Failed to parse YAML in ${basename(filePath)}: ${(err as Error).message}`
    );
  }

  const profiles = fullParsed?.profiles as Record<string, Record<string, unknown>> | undefined;
  if (!profiles || !profiles[profileName]) {
    throw new WorkflowError(
      "workflow_parse_error",
      `Profile '${profileName}' not found in ${basename(filePath)}`
    );
  }

  const profile = profiles[profileName];

  // Phase 1: Interpolate ${profile.*} in frontmatter
  const interpolatedFm = interpolateProfile(fm.raw, profile);

  // Parse interpolated YAML
  let config: WorkflowConfig;
  try {
    config = (parseYaml(interpolatedFm) as WorkflowConfig) || {};
  } catch (err) {
    throw new WorkflowError(
      "workflow_parse_error",
      `Failed to parse interpolated YAML for profile '${profileName}': ${(err as Error).message}`
    );
  }

  // Strip profiles and matrix from the final config
  delete config.profiles;
  delete config.matrix;

  // Deep-merge profile config overrides (e.g., agent block)
  config = deepMergeConfig(config, profile);

  // Phase 1 on body: Interpolate ${profile.*} in prompt template
  const promptTemplate = interpolateProfile(fm.body, profile);

  return { config, prompt_template: promptTemplate };
}
