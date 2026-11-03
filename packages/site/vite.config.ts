import { defineConfig } from "vite";

// The Pages workflow sets SITE_BASE to "/release-train". A local build uses the root.
const env = (globalThis as { process?: { env: Record<string, string | undefined> } }).process?.env ?? {};
const base = env["SITE_BASE"] ? `${env["SITE_BASE"].replace(/\/$/, "")}/` : "/";

// The site bundles the planner of `@release-train/release-train` from the workspace: `graph.ts` and `plan.ts` only.
// These modules use no Node built-in, so the page runs the same planner as the CLI.
export default defineConfig({
  base,
  build: {
    target: "es2022",
  },
  define: {
    __BUILD__: JSON.stringify({ sha: (env["GITHUB_SHA"] ?? "local").slice(0, 7), date: new Date().toISOString().slice(0, 10) }),
  },
});
