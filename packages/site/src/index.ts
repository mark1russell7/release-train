/**
 * The site of release-train: a plan explorer that runs the planner of `@release-train/release-train` in the browser.
 */

export { depKey, mainVersion, noChoices, OWNER, planFor, SAMPLE, SCENARIOS, short, snapshot } from "./world.ts";
export type { Choices, SampleDep, SamplePackage, Scenario } from "./world.ts";
export { actionLine, BOX, dependencyDrawing, KIND_LABEL, semverReason, STATUS_LABEL, trainDrawing } from "./layout.ts";
export type { Arrow, Box, Drawing } from "./layout.ts";
