import picomatch from "picomatch";
import { enclosing, isExternal, ownerOf, type IRView, type Lens, type LensFinding, type LensResult, type TableView } from "@insight/sdk";
import type { IRNode, NodeId, Span } from "@insight/ir";

export interface ForbidRule {
  /** Glob over file paths. Direct effects in matching files are violations. */
  module: string;
  /** Effect kinds, with or without the "effects." prefix, such as "fs.write". */
  effects: string[];
  reason?: string;
}

export interface EffectsConfig {
  /** Function ids to start from. Default: every exported function. */
  entries?: string[];
  forbid?: ForbidRule[];
}

const shortKind = (kind: string): string => kind.replace(/^effects\./, "");

/** The file a function or module node belongs to. */
const fileOf = (view: IRView, id: NodeId): NodeId => enclosing(view, id, "structure.file")?.id ?? id;

/**
 * Side effects per function and the effects reachable from each entry point. Effects are
 * attributed to their owning function, then the callers of that function are walked to find the
 * entries that can reach them.
 */
export const lensEffects: Lens = {
  id: "lens-effects",
  title: "Effects",
  requires: ["structure", "effects"],
  optional: ["calls"],

  async run(view, ctx): Promise<LensResult> {
    const config = (ctx.config ?? {}) as EffectsConfig;
    const functions = view.nodes({ facet: "structure", kind: "structure.function" }).filter((f) => !isExternal(f));
    const fnById = new Map(functions.map((f) => [f.id, f]));
    const hasCalls = view.hasFacet("calls");

    // Effects of an external stub happen in another scope, so they are not this scope's effects.
    const effectNodes = view.nodes({ facet: "effects" }).filter((e) => !isExternal(e));
    /** owner id -> effect kind -> effect nodes */
    const direct = new Map<NodeId, Map<string, IRNode[]>>();
    for (const effect of effectNodes) {
      const owner = ownerOf(view, effect.id);
      if (!owner) continue;
      const kinds = direct.get(owner.id) ?? new Map<string, IRNode[]>();
      const list = kinds.get(shortKind(effect.kind)) ?? [];
      list.push(effect);
      kinds.set(shortKind(effect.kind), list);
      direct.set(owner.id, kinds);
    }

    const entries = Array.isArray(config.entries)
      ? config.entries.filter((id) => fnById.has(id))
      : functions.filter((f) => f.attrs.exported === true).map((f) => f.id);
    const entrySet = new Set(entries);

    /** entry id -> effect kind -> sites reachable from it */
    const surface = new Map<NodeId, Map<string, Set<string>>>();
    if (hasCalls) {
      for (const owner of direct.keys()) {
        if (!fnById.has(owner)) continue;
        const callers = view.trace([owner], { follow: ["calls.call"], direction: "in", uncertain: "may" });
        for (const id of callers.nodes.keys()) {
          if (!entrySet.has(id)) continue;
          const bucket = surface.get(id) ?? new Map<string, Set<string>>();
          for (const kind of direct.get(owner)?.keys() ?? []) {
            const sites = bucket.get(kind) ?? new Set<string>();
            sites.add(owner);
            bucket.set(kind, sites);
          }
          surface.set(id, bucket);
        }
      }
    }

    const findings: LensFinding[] = [];
    const forbid = Array.isArray(config.forbid) ? config.forbid : [];
    forbid.forEach((rule, index) => {
      const moduleMatch = picomatch(rule.module);
      const forbidden = new Set((rule.effects ?? []).map(shortKind));
      for (const effect of effectNodes) {
        const kind = shortKind(effect.kind);
        if (!forbidden.has(kind)) continue;
        const owner = ownerOf(view, effect.id);
        if (!owner) continue;
        const file = fileOf(view, owner.id);
        if (!moduleMatch(file)) continue;
        findings.push({
          lens: "lens-effects",
          id: `forbid:${index}:${effect.id}`,
          severity: "error",
          message: `${owner.id} performs ${kind} in ${file}, which rule ${index} forbids${rule.reason ? ` (${rule.reason})` : ""}`,
          nodes: [effect.id],
          ...(effect.span ? { span: effect.span } : {}),
        });
      }
    });

    for (const effect of effectNodes) {
      if (effect.kind !== "effects.unknown") continue;
      findings.push({
        lens: "lens-effects",
        id: `unknown:${effect.id}`,
        severity: "info",
        message: `Effect could not be classified${effect.attrs.api ? `: ${String(effect.attrs.api)}` : ""}`,
        nodes: [effect.id],
        ...(effect.span ? { span: effect.span as Span } : {}),
      });
    }

    const directRows = [...direct.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([owner, kinds]) => [
        owner,
        [...kinds.keys()].sort().join(", "),
        [...kinds.values()].reduce((n, list) => n + list.length, 0),
      ]);
    const directTable: TableView = {
      type: "table",
      id: "direct-effects",
      title: "Direct effects",
      columns: ["Function or file", "Effects", "Sites"],
      rows: directRows,
    };

    const surfaceTable: TableView = {
      type: "table",
      id: "surface",
      title: "Effect surface of entry points",
      columns: ["Entry", "Effects reachable", "Owning functions"],
      rows: entries.sort().map((entry) => {
        const bucket = surface.get(entry) ?? new Map<string, Set<string>>();
        const kinds = [...bucket.keys()].sort();
        const owners = new Set<string>();
        for (const sites of bucket.values()) for (const s of sites) owners.add(s);
        return [entry, kinds.join(", ") || "none", owners.size];
      }),
    };

    const sites = effectNodes.length;
    return {
      findings,
      views: [surfaceTable, directTable],
      metrics: {
        effectSites: sites,
        functionsWithEffects: [...direct.keys()].filter((id) => fnById.has(id)).length,
        entries: entries.length,
        entriesWithEffects: [...surface.keys()].length,
        forbidViolations: findings.filter((f) => f.id.startsWith("forbid:")).length,
        unknownEffects: effectNodes.filter((e) => e.kind === "effects.unknown").length,
      },
    };
  },
};

export default lensEffects;
