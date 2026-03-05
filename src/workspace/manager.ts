/**
 * Workspace Manager
 * Handles workspace creation, lifecycle, and hooks
 */

import { existsSync, mkdirSync, rmSync, readdirSync } from "fs";
import { join, resolve, isAbsolute } from "path";
import type { Workspace, ServiceConfig, Issue } from "../config/types.js";
import { logger } from "../logging/logger.js";
import { executeHook } from "./hooks.js";
import { renderHook } from "./render-hook.js";

/**
 * Sanitize issue identifier for use as workspace directory name
 * Only [A-Za-z0-9._-] allowed, other characters replaced with _
 */
export function sanitizeWorkspaceKey(identifier: string): string {
  return identifier.replace(/[^A-Za-z0-9._-]/g, "_");
}

/**
 * Validate workspace path is inside workspace root (safety invariant)
 */
export function validateWorkspacePath(workspacePath: string, workspaceRoot: string): boolean {
  const absPath = isAbsolute(workspacePath) ? workspacePath : resolve(workspacePath);
  const absRoot = isAbsolute(workspaceRoot) ? workspaceRoot : resolve(workspaceRoot);

  // Ensure workspace is inside root
  return absPath.startsWith(absRoot + "/") || absPath === absRoot;
}

export class WorkspaceManager {
  private root: string;
  private hooks: ServiceConfig["hooks"];

  constructor(config: ServiceConfig) {
    this.root = config.workspace.root;
    this.hooks = config.hooks;
    this.ensureRootExists();
  }

  private ensureRootExists(): void {
    if (!existsSync(this.root)) {
      mkdirSync(this.root, { recursive: true });
      logger.info("Created workspace root directory", { path: this.root });
    }
  }

  updateConfig(config: ServiceConfig): void {
    this.root = config.workspace.root;
    this.hooks = config.hooks;
    this.ensureRootExists();
  }

  /**
   * Create or reuse workspace for an issue
   */
  async createWorkspace(issue: Issue): Promise<Workspace> {
    const workspaceKey = sanitizeWorkspaceKey(issue.identifier);
    const workspacePath = join(this.root, workspaceKey);

    // Validate path safety
    if (!validateWorkspacePath(workspacePath, this.root)) {
      throw new Error(`Workspace path ${workspacePath} is outside root ${this.root}`);
    }

    const createdNow = !existsSync(workspacePath);

    if (createdNow) {
      try {
        mkdirSync(workspacePath, { recursive: true });
        logger.info("Created workspace directory", {
          issue_id: issue.id,
          issue_identifier: issue.identifier,
          path: workspacePath,
        });
      } catch (err) {
        throw new Error(`Failed to create workspace: ${(err as Error).message}`);
      }

      // Run after_create hook
      if (this.hooks.after_create) {
        const rendered = await renderHook(this.hooks.after_create, issue);
        const result = await executeHook(
          "after_create",
          rendered,
          workspacePath,
          this.hooks.timeout_ms
        );

        if (!result.success) {
          // Cleanup partial workspace on hook failure
          try {
            rmSync(workspacePath, { recursive: true, force: true });
          } catch {
            // Ignore cleanup errors
          }
          throw new Error(`after_create hook failed: ${result.stderr || "timeout"}`);
        }
      }
    } else {
      logger.debug("Reusing existing workspace", {
        issue_id: issue.id,
        issue_identifier: issue.identifier,
        path: workspacePath,
      });
    }

    return {
      path: workspacePath,
      workspace_key: workspaceKey,
      created_now: createdNow,
    };
  }

  /**
   * Run before_run hook
   */
  async runBeforeRunHook(workspacePath: string, issue: Issue): Promise<void> {
    if (!this.hooks.before_run) return;

    const rendered = await renderHook(this.hooks.before_run, issue);
    const result = await executeHook(
      "before_run",
      rendered,
      workspacePath,
      this.hooks.timeout_ms
    );

    if (!result.success) {
      throw new Error(`before_run hook failed: ${result.stderr || "timeout"}`);
    }
  }

  /**
   * Run after_run hook (failures are logged but not fatal)
   */
  async runAfterRunHook(workspacePath: string, issue: Issue): Promise<void> {
    if (!this.hooks.after_run) return;

    const rendered = await renderHook(this.hooks.after_run, issue);
    await executeHook("after_run", rendered, workspacePath, this.hooks.timeout_ms);
  }

  /**
   * Remove workspace for an issue (terminal cleanup)
   */
  async removeWorkspace(identifier: string): Promise<void> {
    const workspaceKey = sanitizeWorkspaceKey(identifier);
    const workspacePath = join(this.root, workspaceKey);

    if (!existsSync(workspacePath)) {
      return;
    }

    // Validate path safety
    if (!validateWorkspacePath(workspacePath, this.root)) {
      logger.error("Refusing to remove workspace outside root", {
        path: workspacePath,
        root: this.root,
      });
      return;
    }

    // Run before_remove hook
    if (this.hooks.before_remove) {
      await executeHook(
        "before_remove",
        this.hooks.before_remove,
        workspacePath,
        this.hooks.timeout_ms
      );
    }

    try {
      rmSync(workspacePath, { recursive: true, force: true });
      logger.info("Removed workspace", { identifier, path: workspacePath });
    } catch (err) {
      logger.warn("Failed to remove workspace", {
        identifier,
        path: workspacePath,
        error: (err as Error).message,
      });
    }
  }

  /**
   * Get workspace path for an issue (without creating)
   */
  getWorkspacePath(identifier: string): string {
    const workspaceKey = sanitizeWorkspaceKey(identifier);
    return join(this.root, workspaceKey);
  }

  /**
   * List all existing workspace identifiers
   */
  listWorkspaces(): string[] {
    if (!existsSync(this.root)) {
      return [];
    }

    try {
      return readdirSync(this.root, { withFileTypes: true })
        .filter((dirent) => dirent.isDirectory())
        .map((dirent) => dirent.name);
    } catch {
      return [];
    }
  }
}
