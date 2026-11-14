// The caller chain of the selected function: every function that calls or references it, transitively, as an ARIA tree
// the reader opens level by level. Loaded when the section opens. The tree itself (CallerChainView) renders from props only.
import { useEffect, useRef, useState } from "react";
import { CALLER_DEFAULTS, type CallerEdge, type CallerGraph, type CallerNode } from "@insight/model";
import { api } from "../../api";
import { readLambdas } from "../../zoom/lambdaPref";
import { hrefView } from "../../router";
import type { MapSelection } from "./ZoomMap";
import { KindTag, refHref } from "./refLink";
import {
  blindTip,
  completeness,
  expandAllKeys,
  focusAfterCollapse,
  summaryLine,
  treeKey,
  treeKeyOf,
  visibleRows,
  type Row,
  type TreeRow,
} from "./callerTree";

/** The link of a chain row, as RefItem links a reverse reference row: a function opens in its scope, or its file's scope when outside it. */
export function callerHref(id: string, scope: string, roots: boolean, node: CallerNode, trace?: string): string {
  return refHref(id, scope, roots, node, trace);
}

/**
 * The key a chain resets its expansion and focus on. A traced chain is the anchor's, whatever function is walked to, so it
 * keys on the anchor alone; an untraced chain is the function's.
 */
export function chainResetKey(id: string, scope: string, fn: string, trace?: string): string {
  return trace !== undefined ? `${id}\0trace\0${trace}` : `${id}\0${scope}\0${fn}`;
}

/** What a chain keeps across a remount of its pane: its open state, options, expansion and focus. */
export interface ChainState {
  opened: boolean;
  possible: boolean;
  stayInScope: boolean;
  depth: number;
  expanded: string[];
  focus?: string;
  capped: boolean;
}

/** The chain states kept by key, so a pane that remounts (a scope change reloads it) gets its state back. */
const chainMemory = new Map<string, ChainState>();
const CHAIN_MEMORY_CAP = 20;

/** Keeps a chain's state under its key, dropping the oldest key past the cap. */
export function rememberChain(key: string, state: ChainState): void {
  if (!chainMemory.has(key) && chainMemory.size >= CHAIN_MEMORY_CAP) {
    const oldest = chainMemory.keys().next().value;
    if (oldest !== undefined) chainMemory.delete(oldest);
  }
  chainMemory.set(key, state);
}

/** The state a chain kept under its key, if any. */
export function recalledChain(key: string): ChainState | undefined {
  return chainMemory.get(key);
}

/** Forgets every kept chain state. For test isolation. */
export function resetChainMemory(): void {
  chainMemory.clear();
}

/** The short name of a function id: the tail after its last ":" or "#", or the id itself. */
const shortName = (id: string) => id.split(/[:#]/).pop() || id;

/** The kind tags of a caller's edges: one per distinct tag, in edge order. Call is the default and is not tagged. */
function kindTags(edges: CallerEdge[]): Array<{ kind: string; how?: string }> {
  const seen = new Map<string, { kind: string; how?: string }>();
  for (const e of edges) {
    if (e.kind === "call") continue;
    const label = e.kind === "dispatch" && e.how === "message" ? "message" : e.kind;
    if (!seen.has(label)) seen.set(label, { kind: e.kind, ...(e.how !== undefined ? { how: e.how } : {}) });
  }
  return [...seen.values()];
}

const DEPTHS: Array<{ value: number; label: string }> = [
  { value: 1, label: "1" },
  { value: 2, label: "2" },
  { value: 3, label: "3" },
  { value: 6, label: "6" },
  { value: CALLER_DEFAULTS.maxDepth, label: "max" },
];

interface ViewProps {
  id: string;
  scope: string;
  roots: boolean;
  graph: CallerGraph;
  expanded: ReadonlySet<string>;
  focus?: string;
  possible: boolean;
  stayInScope: boolean;
  depth: number;
  lambdas: boolean;
  capped?: boolean;
  /** The anchored function, when the chain is traced: its row links keep it. */
  trace?: string;
  /** The selected function, offered as an "Anchor here" link while the chain is not traced. */
  pin?: string;
  onToggle?(key: string): void;
  onKey?(key: string): void;
  onFocus?(key: string): void;
  onOption?(o: { possible?: boolean; stayInScope?: boolean; depth?: number }): void;
  onExpandAll?(): void;
  onCollapseAll?(): void;
}

/** The chain's controls, summary, tree and completeness note. Presentational: it renders from its props only. */
export function CallerChainView(props: ViewProps) {
  const { id, scope, roots, graph, expanded, possible, stayInScope, depth, lambdas, capped, trace, pin, onOption } = props;
  const rows = visibleRows(graph, expanded, { lambdas });
  // The focus names a visible row, or else the first row takes the tab stop: a hidden focus must not leave the tree unreachable.
  const focusKey = rows.some((r) => r.key === props.focus) ? props.focus : rows[0]?.key;
  const note = completeness(graph, possible);

  return (
    <div className="chain-body">
      <div className="chain-tools">
        <label>
          Expand to{" "}
          <select aria-label="Expand all depth" value={depth} onChange={(e) => onOption?.({ depth: Number(e.target.value) })}>
            {DEPTHS.map((d) => (
              <option key={d.value} value={d.value}>
                {d.label}
              </option>
            ))}
          </select>
        </label>
        <button type="button" onClick={() => props.onExpandAll?.()}>
          Expand all
        </button>
        <button type="button" onClick={() => props.onCollapseAll?.()}>
          Collapse
        </button>
        <label>
          <input type="checkbox" checked={possible} onChange={(e) => onOption?.({ possible: e.target.checked })} /> Possible callers
        </label>
        <label>
          <input type="checkbox" checked={stayInScope} onChange={(e) => onOption?.({ stayInScope: e.target.checked })} /> Stay in scope
        </label>
      </div>
      <p className="chain-summary muted small">
        {summaryLine(graph)}
        {trace === undefined && pin !== undefined && (
          <>
            {" "}
            <a className="chain-pin" href={hrefView(id, "flow", { scope, fn: pin, roots, trace: pin })}>
              Anchor here
            </a>
          </>
        )}
      </p>
      <ul
        role="tree"
        aria-label="Caller chain"
        className="chain-tree"
        onKeyDown={(e) => {
          const key = treeKeyOf(e);
          if (key === undefined) return;
          e.preventDefault();
          props.onKey?.(key);
        }}
      >
        {rows.map((r) => {
          const focused = r.key === focusKey;
          const tab = focused ? 0 : -1;
          const level = r.level;
          const indent = { paddingInlineStart: `${(level - 1) * 0.9}rem` };
          if (r.type === "more") {
            return (
              <li
                key={r.key}
                role="treeitem"
                aria-level={level}
                tabIndex={tab}
                data-key={r.key}
                className="chain-more muted small"
                style={indent}
                onFocus={() => props.onFocus?.(r.key)}
              >
                {`+${r.count} more${r.reason === "depth" ? " (depth limit)" : ""}`}
              </li>
            );
          }
          if (r.type === "cycle") {
            return (
              <li
                key={r.key}
                role="treeitem"
                aria-level={level}
                aria-posinset={r.posinset}
                aria-setsize={r.setsize}
                tabIndex={tab}
                data-key={r.key}
                className="chain-row cycle"
                style={indent}
                onFocus={() => props.onFocus?.(r.key)}
              >
                {`↻ calls back into ${r.node.name}`}
              </li>
            );
          }
          return (
            <ChainRow
              key={r.key}
              row={r}
              tab={tab}
              indent={indent}
              href={callerHref(id, scope, roots, r.node, trace)}
              onToggle={props.onToggle}
              onFocus={props.onFocus}
            />
          );
        })}
      </ul>
      {capped && <p className="muted small">Showing the first 500 rows.</p>}
      <p className={`chain-note small${note.complete ? " complete" : ""}`}>{note.text}</p>
    </div>
  );
}

function ChainRow({
  row,
  tab,
  indent,
  href,
  onToggle,
  onFocus,
}: {
  row: TreeRow;
  tab: number;
  indent: { paddingInlineStart: string };
  href: string;
  onToggle?(key: string): void;
  onFocus?(key: string): void;
}) {
  const { node, edges } = row;
  const tip = blindTip(node, edges.find((e) => e.site) ?? row.edge);
  const classes = ["chain-row", node.certainty === "possible" ? "possible" : "", !node.inScope ? "outside" : ""].filter(Boolean).join(" ");
  const count = edges.reduce((sum, e) => sum + e.count, 0);
  return (
    <li
      role="treeitem"
      aria-level={row.level}
      aria-posinset={row.posinset}
      aria-setsize={row.setsize}
      aria-expanded={row.expandable ? row.expanded : undefined}
      tabIndex={tab}
      data-key={row.key}
      className={classes}
      style={indent}
      onFocus={() => onFocus?.(row.key)}
    >
      {row.expandable ? (
        <button type="button" className="chain-toggle" tabIndex={-1} onClick={() => onToggle?.(row.key)}>
          {row.expanded ? "▾" : "▸"}
        </button>
      ) : (
        <span className="chain-toggle" aria-hidden="true" />
      )}
      <a className="ref-row" href={href} tabIndex={-1}>
        <span className="ref-name">{node.name}</span>{" "}
        <span className="mono muted small">{node.line > 0 ? `${node.file}:${node.line}` : node.file}</span>
        {kindTags(edges).map((t) => (
          <KindTag key={t.how !== undefined ? `${t.kind}\0${t.how}` : t.kind} kind={t.kind} how={t.how} />
        ))}
        {count > 1 && <span className="muted small"> ×{count}</span>}
        {node.certainty === "possible" && (
          <>
            {" "}
            <span className="chain-possible">possible</span>
          </>
        )}
        {row.alsoVia > 0 && <span className="muted small"> {`also via ${row.alsoVia} ${row.alsoVia === 1 ? "path" : "paths"}`}</span>}
        {node.blind !== undefined && tip !== undefined && (
          <>
            {" "}
            <span className="chain-blind" title={tip} aria-label={tip}>
              ◌
            </span>
          </>
        )}
        {node.stop === "outside-scope" && <span className="muted small"> outside the scope, not followed</span>}
        {node.stop === "possible-off" && <span className="muted small"> possible callers not followed</span>}
      </a>
    </li>
  );
}

/** The caller chain section of the side panel: collapsed until opened, then fetched once for the selected function. */
export function CallerChain({ id, sel, roots, trace }: { id: string; sel: MapSelection; roots: boolean; trace?: string }) {
  const scope = sel.build.path;
  const fn = sel.selected.ref;
  // A traced chain is the anchored function's, whatever function the reader walks to; the anchor's chain is kept while it stays.
  const target = trace ?? fn;
  const chainKey = chainResetKey(id, scope, fn, trace);
  // A traced chain starts open: the state is read once at mount, so a later trace opens the element by hand (see below).
  // A remounted pane starts from the state its chain kept under the same key.
  const saved = recalledChain(chainKey);
  const [startOpen] = useState(trace !== undefined);
  const [opened, setOpened] = useState(saved?.opened ?? startOpen);
  const started = opened || trace !== undefined;
  const [possible, setPossible] = useState(saved?.possible ?? false);
  const [stayInScope, setStayInScope] = useState(saved?.stayInScope ?? false);
  const [depth, setDepth] = useState<number>(saved?.depth ?? CALLER_DEFAULTS.maxDepth);
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set(saved?.expanded ?? []));
  const [focus, setFocus] = useState<string | undefined>(saved?.focus);
  const [capped, setCapped] = useState(saved?.capped ?? false);
  const [lastFn, setLastFn] = useState(chainKey);
  const [loaded, setLoaded] = useState<{ key: string; graph?: CallerGraph; error?: string }>();
  const treeRef = useRef<HTMLDetailsElement>(null);
  const reqKey = `${id}\0${scope}\0${target}\0${possible}\0${stayInScope}`;

  // A different chain starts with its own expansion and focus. Walking to another function keeps an anchored chain's.
  if (lastFn !== chainKey) {
    setLastFn(chainKey);
    const back = recalledChain(chainKey);
    if (back) {
      setOpened(back.opened);
      setPossible(back.possible);
      setStayInScope(back.stayInScope);
      setDepth(back.depth);
      setExpanded(new Set(back.expanded));
      setFocus(back.focus);
      setCapped(back.capped);
    } else {
      setExpanded(new Set());
      setFocus(undefined);
      setCapped(false);
      // An anchored chain that is new starts with the defaults; an untraced one keeps its options, as it always has.
      if (trace !== undefined) {
        setPossible(false);
        setStayInScope(false);
        setDepth(CALLER_DEFAULTS.maxDepth);
      }
    }
  }

  // The state is kept under its key on every change, so the next mount of this pane finds it.
  useEffect(() => {
    rememberChain(chainKey, {
      opened,
      possible,
      stayInScope,
      depth,
      expanded: [...expanded],
      ...(focus !== undefined ? { focus } : {}),
      capped,
    });
  }, [chainKey, opened, possible, stayInScope, depth, expanded, focus, capped]);

  // Anchoring a chain from an untraced view opens the element that is already mounted.
  useEffect(() => {
    if (trace !== undefined && treeRef.current) treeRef.current.open = true;
  }, [trace]);

  useEffect(() => {
    if (!started) return;
    let cancelled = false;
    const key = reqKey;
    api.getCallerGraph(id, scope, target, { possible, stayInScope }).then(
      (graph) => {
        if (!cancelled) setLoaded({ key, graph });
      },
      (e: unknown) => {
        if (!cancelled) setLoaded({ key, error: e instanceof Error ? e.message : String(e) });
      },
    );
    return () => {
      cancelled = true;
    };
  }, [started, reqKey, id, scope, target, possible, stayInScope]);

  // Keyboard moves move the DOM focus too, to the row the state names.
  useEffect(() => {
    if (focus === undefined) return;
    const el = [...(treeRef.current?.querySelectorAll<HTMLElement>("[data-key]") ?? [])].find((x) => x.dataset.key === focus);
    el?.focus();
  }, [focus]);

  const current = loaded?.key === reqKey ? loaded : undefined;
  const lambdas = readLambdas();
  const graph = current?.graph;
  const rows: Row[] = graph ? visibleRows(graph, expanded, { lambdas }) : [];

  const onKey = (key: string) => {
    if (!graph) return;
    const r = treeKey(rows, { focus, expanded }, key);
    setExpanded(r.expanded);
    setFocus(r.focus);
    if (r.open !== undefined) {
      const row = rows.find((x) => x.key === r.open);
      if (row?.type === "node") window.location.assign(callerHref(id, scope, roots, row.node, trace));
    }
  };

  const clearHref = hrefView(id, "flow", { scope, fn, roots });
  const anchorHeader =
    trace === undefined ? null : (
      <p className="chain-anchor">
        Callers of <strong className="mono">{graph?.nodes[0]?.name ?? shortName(trace)}</strong>{" "}
        <a className="chain-clear" href={clearHref} aria-label="Clear the caller chain anchor" title="Clear">
          ×
        </a>
      </p>
    );

  return (
    <details
      ref={treeRef}
      className="ref-list caller-chain"
      open={startOpen || undefined}
      onToggle={(e) => {
        if (e.currentTarget.open) setOpened(true);
      }}
    >
      <summary>Caller chain</summary>
      {!started ? null : current?.error !== undefined ? (
        <>
          {anchorHeader}
          <p className="muted small">The caller chain is not available: {current.error}</p>
        </>
      ) : graph === undefined ? (
        <>
          {anchorHeader}
          <p className="muted small">Loading the caller chain</p>
        </>
      ) : (
        <>
          {anchorHeader}
          <CallerChainView
            id={id}
            scope={scope}
            roots={roots}
            graph={graph}
            trace={trace}
            pin={fn}
            expanded={expanded}
            focus={focus}
            possible={possible}
            stayInScope={stayInScope}
            depth={depth}
            lambdas={lambdas}
            capped={capped}
            onToggle={(key) => {
              // Collapsing a row hides its subtree: a focus inside it moves to the row.
              if (expanded.has(key)) setFocus((f) => focusAfterCollapse(f, key));
              setExpanded((prev) => {
                const next = new Set(prev);
                if (next.has(key)) next.delete(key);
                else next.add(key);
                return next;
              });
            }}
            onKey={onKey}
            onFocus={(key) => setFocus(key)}
            onOption={(o) => {
              if (o.possible !== undefined) setPossible(o.possible);
              if (o.stayInScope !== undefined) setStayInScope(o.stayInScope);
              if (o.depth !== undefined) setDepth(o.depth);
            }}
            onExpandAll={() => {
              const r = expandAllKeys(graph, depth, { lambdas });
              setExpanded(new Set(r.keys));
              setCapped(r.capped);
            }}
            onCollapseAll={() => {
              setExpanded(new Set());
              setCapped(false);
              setFocus(undefined);
            }}
          />
        </>
      )}
    </details>
  );
}
