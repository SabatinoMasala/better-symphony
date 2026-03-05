import { Liquid } from "liquidjs";
import type { Issue } from "../config/types.js";

const liquid = new Liquid({ strictVariables: false, strictFilters: true });

/**
 * Render a hook script through Liquid so {{ issue.branch_name }} etc. work.
 * Uses lenient variables (strictVariables: false) so hooks without
 * template vars still work fine.
 */
export async function renderHook(script: string, issue: Issue): Promise<string> {
  return liquid.parseAndRender(script, { issue });
}
