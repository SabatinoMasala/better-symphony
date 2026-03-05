/**
 * Workspace Hooks
 * Shell script execution for workspace lifecycle events
 */

import { spawn } from "child_process";
import { logger } from "../logging/logger.js";

export interface HookResult {
  success: boolean;
  stdout: string;
  stderr: string;
  exitCode: number | null;
  timedOut: boolean;
}

/**
 * Execute a hook script in a workspace directory
 */
export async function executeHook(
  hookName: string,
  script: string,
  cwd: string,
  timeoutMs: number
): Promise<HookResult> {
  logger.debug(`Executing hook ${hookName}`, { hook: hookName, cwd });

  return new Promise((resolve) => {
    const proc = spawn("bash", ["-lc", script], {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        SYMPHONY_HOOK: hookName,
        SYMPHONY_WORKSPACE: cwd,
      },
    });

    let stdout = "";
    let stderr = "";
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      proc.kill("SIGTERM");
      setTimeout(() => {
        if (!proc.killed) {
          proc.kill("SIGKILL");
        }
      }, 5000);
    }, timeoutMs);

    proc.stdout?.on("data", (data) => {
      stdout += data.toString();
    });

    proc.stderr?.on("data", (data) => {
      stderr += data.toString();
    });

    proc.on("close", (exitCode) => {
      clearTimeout(timer);

      if (timedOut) {
        logger.warn(`Hook ${hookName} timed out after ${timeoutMs}ms`, { hook: hookName });
      } else if (exitCode !== 0) {
        logger.warn(`Hook ${hookName} failed with exit code ${exitCode}`, {
          hook: hookName,
          exitCode,
          stderr: stderr.slice(0, 500),
        });
      } else {
        logger.debug(`Hook ${hookName} completed successfully`, { hook: hookName });
      }

      resolve({
        success: !timedOut && exitCode === 0,
        stdout,
        stderr,
        exitCode,
        timedOut,
      });
    });

    proc.on("error", (err) => {
      clearTimeout(timer);
      logger.error(`Hook ${hookName} failed to execute: ${err.message}`, { hook: hookName });
      resolve({
        success: false,
        stdout: "",
        stderr: err.message,
        exitCode: null,
        timedOut: false,
      });
    });
  });
}
