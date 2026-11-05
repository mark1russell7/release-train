/** The file of the holds in the root of the repository. */
export const HOLDS_FILE = "lag-holds.json";

/** The most days from the run to the date of a hold. */
export const HOLD_MAX_DAYS = 14;

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * One decision that a package waits. With no field `repo`, the package stays with no release. A row over its limit with
 * a valid hold does not fail the gate. It keeps its days in the report, and it reads as held. With the field `repo`, the
 * train sends no update of the package to that repository. That hold says nothing about a release of the package.
 */
export interface LagHold {
  package: string;
  /** The dependent repository that does not get an update of the package. Absent: the hold is about the release of the package. */
  repo?: string;
  /** The reason in plain words. An extension of the date needs a new reason. */
  reason: string;
  /** The `https` address of the text of the decision. */
  ruling: string;
  /** The last day of the hold, as `YYYY-MM-DD` in UTC. */
  until: string;
}

/** The result of `readHolds`. Only a valid hold is in `holds`. */
export interface HoldReading {
  holds: LagHold[];
  faults: string[];
}

/** This function gives the start of the day of a date as a time in milliseconds, or null for a wrong date. */
function dayStart(date: string): number | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;
  const time = Date.parse(`${date}T00:00:00Z`);
  return Number.isNaN(time) || new Date(time).toISOString().slice(0, 10) !== date ? null : time;
}

/** This function gives the text of a field, or an empty string when the field is not text. */
const text = (record: Readonly<Record<string, unknown>>, field: string): string => {
  const value = record[field];
  return typeof value === "string" ? value.trim() : "";
};

/** This function gives the hold of a record of the file. An empty field `repo` is the same as no field. */
function holdOfRecord(record: Readonly<Record<string, unknown>>): LagHold {
  const repo = text(record, "repo");
  return { package: text(record, "package"), ...(repo === "" ? {} : { repo }), reason: text(record, "reason"), ruling: text(record, "ruling"), until: text(record, "until") };
}

/** This function gives the name of a hold in a fault. */
const holdName = (hold: LagHold): string => (hold.repo === undefined ? hold.package : `${hold.package} in ${hold.repo}`);

/** This function tells if a hold stops the update of the package `dep` in the repository `repo`. */
export function holdsUpdate(holds: readonly LagHold[], repo: string, dep: string): boolean {
  return holds.some((hold) => hold.repo === repo && hold.package === dep);
}

/** This function gives the faults of one hold at the time `now`. */
function holdFaults(hold: LagHold, now: Date): string[] {
  const name = hold.package === "" ? "A hold with no package" : holdName(hold);
  const faults: string[] = [];
  if (hold.package === "") faults.push(`${name}: the field package is empty.`);
  if (hold.reason === "") faults.push(`${name}: the hold has no reason.`);
  if (!/^https:\/\/\S+$/.test(hold.ruling)) faults.push(`${name}: the hold has no https link to its ruling.`);
  const start = dayStart(hold.until);
  if (start === null) {
    faults.push(`${name}: the hold has no date of the form YYYY-MM-DD.`);
    return faults;
  }
  const today = Math.floor(now.getTime() / DAY_MS) * DAY_MS;
  if (start < today) faults.push(`${name}: the date ${hold.until} of the hold is in the past.`);
  if (start - today > HOLD_MAX_DAYS * DAY_MS) faults.push(`${name}: the date ${hold.until} of the hold is more than ${HOLD_MAX_DAYS} days after the run.`);
  return faults;
}

/** This function reads the value of the file of the holds. A hold with a fault holds nothing, and the gate fails on the fault. */
export function readHolds(value: unknown, now: Date): HoldReading {
  const list = typeof value === "object" && value !== null ? (value as { holds?: unknown }).holds : undefined;
  if (!Array.isArray(list)) return { holds: [], faults: ["The file of the holds has no list holds."] };
  const reading: HoldReading = { holds: [], faults: [] };
  const seen = new Set<string>();
  for (const item of list as unknown[]) {
    const record = typeof item === "object" && item !== null ? (item as Record<string, unknown>) : {};
    const hold = holdOfRecord(record);
    const faults = holdFaults(hold, now);
    const key = holdName(hold);
    if (seen.has(key)) faults.push(`${key}: the file has two holds of this package.`);
    seen.add(key);
    reading.faults.push(...faults);
    if (faults.length === 0) reading.holds.push(hold);
  }
  return reading;
}

/** This function gives a fault for each hold with a later date and the same reason. An extension needs a new reason. */
export function extensionFaults(before: readonly LagHold[], after: readonly LagHold[]): string[] {
  return after.flatMap((hold) => {
    const old = before.find((item) => holdName(item) === holdName(hold));
    return old !== undefined && hold.until > old.until && hold.reason === old.reason ? [`${holdName(hold)}: the hold goes to ${hold.until} with its old reason. An extension needs a new reason.`] : [];
  });
}

/** This function gives the list of a file for a comparison. The value is not examined: an old hold can have a date in the past. */
export function holdsOfFile(value: unknown): LagHold[] {
  const list = typeof value === "object" && value !== null ? (value as { holds?: unknown }).holds : undefined;
  if (!Array.isArray(list)) return [];
  return (list as Record<string, unknown>[]).map(holdOfRecord);
}
