import { readFileSync } from "node:fs";
import { Ajv2020, type ValidateFunction } from "ajv/dist/2020.js";

export interface ResolverRole {
  scheme: string;
  entry: string;
  priority: number;
}

export interface PluginManifest {
  id: string;
  version: string;
  description?: string;
  irVersion: string;
  detect?: string[];
  files?: string[];
  inputs?: string[];
  provides?: string[];
  dependsOn?: string[];
  /** A lens with no tab in the web app. It still runs and its results stay available to the CLI and API. */
  hidden?: boolean;
  kinds?: string;
  roles: {
    frontend?: string;
    lens?: string;
    resolver?: ResolverRole;
  };
}

let validator: ValidateFunction | undefined;

function manifestValidator(): ValidateFunction {
  if (!validator) {
    const ajv = new Ajv2020({ allErrors: true, strict: false });
    const schema = JSON.parse(
      readFileSync(new URL("../schema/plugin-manifest.schema.json", import.meta.url), "utf8"),
    ) as object;
    validator = ajv.compile(schema);
  }
  return validator;
}

export type ManifestResult =
  | { ok: true; manifest: PluginManifest }
  | { ok: false; reason: string };

/** Validates a parsed insight-plugin.json. The reason names the first problems found. */
export function checkManifest(raw: unknown): ManifestResult {
  const check = manifestValidator();
  if (!check(raw)) {
    const reason = (check.errors ?? [])
      .slice(0, 5)
      .map((e) => `${e.instancePath || "manifest"} ${e.message ?? "is invalid"}`)
      .join("; ");
    return { ok: false, reason: `invalid manifest: ${reason}` };
  }
  const manifest = raw as PluginManifest;
  const [major, minor] = manifest.irVersion.slice(1).split(".").map(Number) as [number, number];
  const [coreMajor, coreMinor] = IR_VERSION.split(".").map(Number) as [number, number];
  if (major !== coreMajor || minor > coreMinor) {
    return {
      ok: false,
      reason: `targets IR ${manifest.irVersion} but this Insight provides IR ${IR_VERSION}`,
    };
  }
  return { ok: true, manifest };
}

/** The IR version this build of the core speaks. */
export const IR_VERSION = "1.0";
