/**
 * The probe of the plan explorer. The site check of the Pages workflow starts it in a browser at each width, before
 * the deploy. A failed check stops the deploy.
 *
 * The site check reads this TypeScript file directly. It removes the types and the `export` line, and it starts the
 * result as the body of an async function.
 */

// The site check gives these helpers to the probe.
declare const check: (name: string, ok: unknown, detail?: unknown) => boolean;
declare const until: <T>(fn: () => T | Promise<T>, ms?: number) => Promise<T>;
declare const $: (selector: string) => Element | null;
declare const $$: (selector: string) => Element[];
declare const click: (target: string | Element) => void;

const action = (id: string): Element | null => $(`#waves .action[data-id="${id}"]`);
const waveOf = (id: string): number => Number(action(id)?.getAttribute("data-wave") ?? "-1");
const ids = (): string => $$("#waves .action").map((a) => `${a.getAttribute("data-id")}@${a.getAttribute("data-wave")}`).join(", ");
const text = (selector: string): string => $(selector)?.textContent ?? "";

// The start state: the scenario "A major release" of @acme/units.
check("the page starts with a train of actions", await until(() => $$("#waves .action").length >= 5), ids());
check("the release of units is in the first wave", waveOf("release:units") === 0, ids());
check("the train drawing has a box for each action", $$("#canvas svg .box").length === $$("#waves .action").length, `${$$("#canvas svg .box").length} boxes`);

click('[data-scenario="none"]');
check("with no bump, the train has no release", await until(() => $$('#waves .action[data-kind="release"]').length === 0), ids());
check("with no bump, the two old lockfiles update in range", $$('#waves .action[data-kind="adopt-in-range"]').length === 2, ids());

// The visitor bumps @acme/units to major.
click('[data-bump="@acme/units:major"]');
check("a major bump of units starts a release of units", await until(() => action("release:units") !== null), ids());
check("grid changes its range to the new major", text('#waves .action[data-id="update:grid"]').includes("^2.0.0"), text('#waves .action[data-id="update:grid"]'));
check("grid then releases a new version in a later wave", waveOf("release:grid") > waveOf("update:grid") && text('#waves .action[data-id="release:grid"]').includes("0.6.3"), ids());
check("chart waits for the new grid", waveOf("update:chart") > waveOf("release:grid"), ids());
check("the package list shows the next version of grid", text('.pkg[data-name="@acme/grid"] .status').includes("0.6.3"), text('.pkg[data-name="@acme/grid"] .status'));

// A version with no provenance holds the lockfile of chart.
click('[data-bump="@acme/units:none"]');
click('[data-prov="@acme/theme"]');
check("a version with no provenance is held", await until(() => text("#issues").includes("no provenance")), text("#issues"));
check("the held lockfile update leaves the train", await until(() => action("update:chart") === null), ids());

// A github: specifier blocks the release of cli.
click('[data-git="@acme/cli uses @acme/units"]');
click('[data-bump="@acme/cli:patch"]');
check("a github: dependency blocks the release of cli", await until(() => $('#waves .action.blocked[data-id="release:cli"]') !== null), ids());
check("the summary counts the blocks", Number(text("#sum-blocked .num")) >= 2, text("#sum-blocked"));

// The dependency drawing and the detail panel.
click('[data-view="deps"]');
check("the dependency drawing has a box for each package and app", await until(() => $$("#canvas svg .box").length === 8), `${$$("#canvas svg .box").length} boxes`);
// An SVG element has no click() method, so the probe sends the event itself.
$('#canvas svg .box[data-id="@acme/cli"]')?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
check("a box shows its package in the detail panel", await until(() => text("#detail").includes("@acme/cli") && text("#detail").includes("blocked")), text("#detail"));

// The start state again, for the screenshots.
click('[data-scenario="major"]');
check("a scenario button sets the train again", await until(() => action("release:units") !== null && $$("#canvas svg .box").length === $$("#waves .action").length), ids());

export {};
