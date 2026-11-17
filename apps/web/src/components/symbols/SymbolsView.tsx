// The Symbols tab: a call graph of the exported functions. A start list on the left names the exported functions of the
// scope; picking one opens its box as the head of a chain. A box lists the exported functions it calls (through internal
// helpers); picking one opens that callee's box to the right and drops whatever was right of the box. A "Callers" chip opens a
// box to the left that lists who calls the function, and picking a caller makes it the new head of the chain. The chain is
// kept in the URL (`chain=`), so a reload or a shared link opens the same boxes.
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { ProjectModel } from "@insight/model";
import { api } from "../../api";
import { fileTarget, useCodeTarget } from "../../codeTarget";
import { hrefView } from "../../router";
import { displayName } from "../../zoom/names";
import { exportedCallees, exportedCallers, exportedFunctions, isExportedFunction, type ExportedSymbol, type SymbolLink } from "../../symbols/graph";

/** The gap between two columns, where the connector runs. */
const CONNECTOR_GAP = 72;

interface Props {
  id: string;
  scope: string;
  /** The chain as the URL holds it: function ids joined by commas. */
  chain?: string;
}

/** The ids a `chain=` value names, in order. */
export function parseChain(raw: string | undefined): string[] {
  return raw ? raw.split(",").filter((s) => s.length > 0) : [];
}

/** The chain up to its first id that is not an exported function of the project. A stale or edited link keeps what it can. */
export function validChain(model: ProjectModel, ids: string[]): string[] {
  const out: string[] = [];
  for (const id of ids) {
    if (!isExportedFunction(model, id)) break;
    out.push(id);
  }
  return out;
}

/** The start list's rows that match a filter: its text is matched against the name and the file, ignoring case. */
export function filterSymbols(symbols: ExportedSymbol[], query: string): ExportedSymbol[] {
  const q = query.trim().toLowerCase();
  if (q === "") return symbols;
  return symbols.filter((s) => s.name.toLowerCase().includes(q) || s.file.toLowerCase().includes(q));
}

/** Calls `f` once per id: the first answer for an id is kept for the model's life. */
function memoBy(f: (id: string) => SymbolLink[]): (id: string) => SymbolLink[] {
  const seen = new Map<string, SymbolLink[]>();
  return (id) => {
    let hit = seen.get(id);
    if (hit === undefined) {
      hit = f(id);
      seen.set(id, hit);
    }
    return hit;
  };
}

/** Scrolls an element into view on the inline axis; a reader who asks for reduced motion gets no animation. */
function reveal(el: HTMLElement | undefined) {
  if (el === undefined || typeof el.scrollIntoView !== "function") return;
  const reduce = typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches === true;
  el.scrollIntoView({ behavior: reduce ? "auto" : "smooth", block: "nearest", inline: "end" });
}

export function SymbolsView({ id, scope, chain: chainParam }: Props) {
  const { showCode } = useCodeTarget();
  const [loaded, setLoaded] = useState<{ key: string; model?: ProjectModel; error?: string }>();
  const [raw, setRaw] = useState<string[]>(() => parseChain(chainParam));
  // The box whose callers are open (its index in the chain), or none.
  const [callersAt, setCallersAt] = useState<number | null>(null);
  const [filter, setFilter] = useState("");
  // The elements the connectors and the reveal read, by their place in the chain.
  const els = useRef(new Map<string, HTMLElement>());
  const trackRef = useRef<HTMLDivElement>(null);
  const [links, setLinks] = useState<string[]>([]);

  useEffect(() => {
    let cancelled = false;
    api.getSymbolModel(id).then(
      (model) => {
        if (!cancelled) setLoaded({ key: id, model });
      },
      (e: unknown) => {
        if (!cancelled) setLoaded({ key: id, error: e instanceof Error ? e.message : String(e) });
      },
    );
    return () => {
      cancelled = true;
    };
  }, [id]);

  // The URL is the source of the chain: a change of `chain=` (a link, Back, or the write below) replaces what the view holds.
  useEffect(() => {
    setRaw(parseChain(chainParam));
  }, [chainParam]);

  const model = loaded?.key === id ? loaded.model : undefined;
  const error = loaded?.key === id ? loaded.error : undefined;
  const graph = useMemo(
    () =>
      model === undefined
        ? undefined
        : { callees: memoBy((fn) => exportedCallees(model, fn)), callers: memoBy((fn) => exportedCallers(model, fn)) },
    [model],
  );
  const chain = useMemo(() => (model === undefined ? [] : validChain(model, raw)), [model, raw]);
  const symbols = useMemo(() => (model === undefined ? [] : exportedFunctions(model, scope)), [model, scope]);
  const shown = useMemo(() => filterSymbols(symbols, filter), [symbols, filter]);

  // Moves the chain: the state, and the URL that names it (so the chain survives a reload).
  const go = (next: string[]) => {
    setRaw(next);
    setCallersAt(null);
    const href = hrefView(id, "symbols", { scope, ...(next.length > 0 ? { chain: next.join(",") } : {}) });
    if (window.location.hash !== href) window.location.hash = href;
  };

  const chainKey = chain.join("\0");
  // Connectors: from the row that opened the next box to that box, and from the open callers box to the box it leads to.
  useLayoutEffect(() => {
    const draw = () => {
      const track = trackRef.current;
      if (track === null) return setLinks([]);
      const base = track.getBoundingClientRect();
      const at = (el: HTMLElement) => {
        const r = el.getBoundingClientRect();
        return { left: r.left - base.left, right: r.right - base.left, y: r.top - base.top + r.height / 2, top: r.top - base.top };
      };
      const paths: string[] = [];
      const curve = (from: { right: number; y: number }, to: { left: number; y: number }) =>
        `M ${from.right} ${from.y} C ${from.right + CONNECTOR_GAP / 2} ${from.y}, ${to.left - CONNECTOR_GAP / 2} ${to.y}, ${to.left} ${to.y}`;
      for (let i = 0; i + 1 < chain.length; i++) {
        const row = els.current.get(`row:${i}:${chain[i + 1]}`);
        const box = els.current.get(`box:${i + 1}`);
        if (row && box) {
          const a = at(row);
          const b = at(box);
          paths.push(curve({ right: a.right, y: a.y }, { left: b.left, y: b.top + 20 }));
        }
      }
      if (callersAt !== null) {
        const cb = els.current.get(`callers:${callersAt}`);
        const box = els.current.get(`box:${callersAt}`);
        if (cb && box) {
          const a = at(cb);
          const b = at(box);
          paths.push(curve({ right: a.right, y: a.top + 20 }, { left: b.left, y: b.top + 20 }));
        }
      }
      setLinks(paths);
    };
    draw();
    window.addEventListener("resize", draw);
    return () => window.removeEventListener("resize", draw);
  }, [chainKey, callersAt, model, filter]);

  // A box that opens (the chain's new last box, or a callers box) comes into view.
  const lastKey = chain.length > 0 ? `${chain.length - 1}:${chain[chain.length - 1]}` : "";
  useEffect(() => {
    if (lastKey !== "") reveal(els.current.get(`box:${chain.length - 1}`));
  }, [lastKey]);
  useEffect(() => {
    if (callersAt !== null) reveal(els.current.get(`callers:${callersAt}`));
  }, [callersAt]);

  if (error !== undefined) return <p className="error" role="alert">{error}</p>;
  if (model === undefined || graph === undefined) return <p className="muted small">Loading symbols</p>;

  const pickCallee = (i: number, calleeId: string) => {
    const kept = chain.slice(0, i + 1);
    // A row that is already the next box closes everything right of this one.
    go(chain[i + 1] === calleeId ? kept : [...kept, calleeId]);
  };
  const pickCaller = (i: number, callerId: string) => {
    // The caller becomes the new head; the boxes right of the box it calls stay as they were.
    go([callerId, ...chain.slice(i)]);
  };

  const groups: Array<{ file: string; items: ExportedSymbol[] }> = [];
  for (const s of shown) {
    const last = groups[groups.length - 1];
    if (last !== undefined && last.file === s.file) last.items.push(s);
    else groups.push({ file: s.file, items: [s] });
  }

  const lineOf = (fnId: string) => model.functionById.get(fnId)?.span?.start[0];
  const reg = (key: string) => (el: HTMLElement | null) => {
    if (el) els.current.set(key, el);
    else els.current.delete(key);
  };

  return (
    <div className="sym">
      <aside className="sym-list" aria-label="Exported functions">
        <div className="sym-filter">
          <input
            type="search"
            className="sym-filter-input"
            placeholder="Filter functions"
            aria-label="Filter exported functions"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
          />
        </div>
        {symbols.length === 0 && <p className="muted small sym-none">No exported functions in this scope</p>}
        {symbols.length > 0 && shown.length === 0 && <p className="muted small sym-none">No function matches “{filter}”</p>}
        {groups.map((g) => (
          <section key={g.file} className="sym-group">
            <h3 className="sym-file">{g.file}</h3>
            <ul className="sym-starts">
              {g.items.map((s) => (
                <li key={s.id}>
                  <button
                    type="button"
                    className="sym-start"
                    aria-current={chain[0] === s.id ? "true" : undefined}
                    onClick={() => go([s.id])}
                  >
                    {displayName(s.name, s.id)}
                  </button>
                </li>
              ))}
            </ul>
          </section>
        ))}
      </aside>
      <div className="sym-canvas">
        {chain.length === 0 ? (
          <p className="muted small sym-empty">Pick an exported function on the left to open its calls.</p>
        ) : (
          <div className="sym-track" ref={trackRef}>
            {chain.map((fnId, i) => {
              const fn = model.functionById.get(fnId);
              const name = displayName(fn?.name ?? fnId, fnId);
              const callersOpen = callersAt === i;
              const callers = graph.callers(fnId);
              const callees = graph.callees(fnId);
              return (
                <div key={`${i}:${fnId}`} className="sym-column">
                  {callersOpen && (
                    <section className="sym-box sym-callers" aria-label={`Callers of ${name}`} ref={reg(`callers:${i}`)}>
                      <header className="sym-head">
                        <span className="sym-callers-title">Callers of {name}</span>
                        <button type="button" className="sym-close" aria-label={`Close the callers of ${name}`} onClick={() => setCallersAt(null)}>
                          ×
                        </button>
                      </header>
                      {callers.length === 0 ? (
                        <p className="muted small sym-none">No exported callers</p>
                      ) : (
                        <ul className="sym-rows">
                          {callers.map((c) => (
                            <li key={c.id}>
                              <button type="button" className="sym-row" onClick={() => pickCaller(i, c.id)}>
                                <span className="sym-row-name">{displayName(c.name, c.id)}</span>
                                {c.via !== undefined && <span className="sym-via">via {displayName(c.via)}</span>}
                                {c.candidate && <span className="sym-maybe">maybe</span>}
                              </button>
                            </li>
                          ))}
                        </ul>
                      )}
                    </section>
                  )}
                  <section className="sym-box" data-box={fnId} aria-label={`Calls of ${name}`} ref={reg(`box:${i}`)}>
                    <header className="sym-head">
                      <button
                        type="button"
                        className="sym-title"
                        title="Show the source"
                        onClick={() => {
                          const line = lineOf(fnId);
                          if (fn !== undefined) showCode(fileTarget(fn.file, line !== undefined ? line + 1 : undefined));
                        }}
                      >
                        <span className="sym-name">{name}</span>
                        <span className="sym-path">{fn?.file ?? ""}</span>
                      </button>
                      <button
                        type="button"
                        className="sym-chip"
                        aria-expanded={callersOpen}
                        onClick={() => setCallersAt(callersOpen ? null : i)}
                      >
                        Callers {callers.length}
                      </button>
                    </header>
                    {callees.length === 0 ? (
                      <p className="muted small sym-none">Calls no exported functions</p>
                    ) : (
                      <ul className="sym-rows">
                        {callees.map((c) => {
                          const selected = chain[i + 1] === c.id;
                          return (
                            <li key={c.id}>
                              <button
                                type="button"
                                className="sym-row"
                                aria-pressed={selected}
                                data-row={c.id}
                                ref={reg(`row:${i}:${c.id}`)}
                                onClick={() => pickCallee(i, c.id)}
                              >
                                <span className="sym-row-name">{displayName(c.name, c.id)}</span>
                                {c.via !== undefined && <span className="sym-via">via {displayName(c.via)}</span>}
                                {c.candidate && <span className="sym-maybe">maybe</span>}
                              </button>
                            </li>
                          );
                        })}
                      </ul>
                    )}
                  </section>
                </div>
              );
            })}
            <svg className="sym-links" aria-hidden="true">
              {links.map((d, k) => (
                <path key={k} d={d} />
              ))}
            </svg>
          </div>
        )}
      </div>
    </div>
  );
}
