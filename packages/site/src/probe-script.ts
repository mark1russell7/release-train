/**
 * The script of the site probe. The site check reads a probe as JavaScript: the body of an async function. The probe
 * source is TypeScript (`check-probe.ts`), so this module removes its types and its `export` line.
 */

import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";

/** This function gives the JavaScript of a probe source: the source with no types and no `export` statement. */
export function probeScript(source: string): string {
  return stripTypeScriptTypes(source, { mode: "strip" }).replace(/^export \{\};?\s*$/m, "");
}

/** This function reads the probe of the site and gives its JavaScript. */
export function readProbe(): string {
  return probeScript(readFileSync(new URL("./check-probe.ts", import.meta.url), "utf8"));
}
