import type { Provenance } from "./types.ts";

/** The npm attestations document of one version. */
export interface Attestations {
  attestations?: { predicateType?: string; bundle?: { dsseEnvelope?: { payload?: string } } }[];
}

/** The part of an SLSA provenance statement that this package reads. */
export interface SlsaStatement {
  predicate?: {
    buildDefinition?: {
      externalParameters?: { workflow?: { repository?: unknown; path?: unknown } };
      internalParameters?: { github?: { repository_id?: unknown } };
      resolvedDependencies?: { digest?: { gitCommit?: unknown } }[];
    };
  };
}

/** This function gives the URL of the attestations document of one version on a registry. */
export function attestationsUrl(registry: string, name: string, version: string): string {
  return `${registry}/-/npm/v1/attestations/${name.replaceAll("/", "%2f")}@${encodeURIComponent(version)}`;
}

/** This function gives the SLSA provenance statements of an attestations document. It skips a statement that does not parse. */
export function slsaStatements(doc: Attestations): SlsaStatement[] {
  const out: SlsaStatement[] = [];
  for (const a of doc.attestations ?? []) {
    if (!a.predicateType?.startsWith("https://slsa.dev/provenance/")) continue;
    try {
      out.push(JSON.parse(Buffer.from(a.bundle?.dsseEnvelope?.payload ?? "", "base64").toString("utf8")) as SlsaStatement);
    } catch {
      // A statement that does not parse gives no provenance.
    }
  }
  return out;
}

/** This function gives the repository URL and the workflow file of the first SLSA statement that names both, or null. */
export function workflowProvenance(doc: Attestations): Provenance | null {
  for (const statement of slsaStatements(doc)) {
    const w = statement.predicate?.buildDefinition?.externalParameters?.workflow;
    if (typeof w?.repository === "string" && typeof w.path === "string") return { repository: w.repository, workflow: w.path };
  }
  return null;
}
