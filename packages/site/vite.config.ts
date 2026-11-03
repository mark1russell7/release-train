import { defineConfig, type Plugin } from "vite";
import { readProbe } from "./src/probe-script.ts";

// The Pages workflow sets SITE_BASE to "/release-train". A local build uses the root.
const env = (globalThis as { process?: { env: Record<string, string | undefined> } }).process?.env ?? {};
const base = env["SITE_BASE"] ? `${env["SITE_BASE"].replace(/\/$/, "")}/` : "/";

/** This plugin writes the probe of the site check to `dist/check-probe.js`, as JavaScript. */
function probe(): Plugin {
  return {
    name: "release-train-probe",
    apply: "build",
    generateBundle() {
      this.emitFile({ type: "asset", fileName: "check-probe.js", source: readProbe() });
    },
  };
}

// The site bundles the planner of `@release-train/release-train` from the workspace: `graph.ts` and `plan.ts` only.
// These modules use no Node built-in, so the page runs the same planner as the CLI.
export default defineConfig({
  base,
  plugins: [probe()],
  build: {
    target: "es2022",
  },
  define: {
    __BUILD__: JSON.stringify({ sha: (env["GITHUB_SHA"] ?? "local").slice(0, 7), date: new Date().toISOString().slice(0, 10) }),
  },
});
