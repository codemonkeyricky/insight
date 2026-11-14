// The caller chain of the selected function: every function that calls or references it, transitively, as an ARIA tree
// the reader opens level by level. Loaded when the section opens. The tree itself (CallerChainView) renders from props only.
import { useEffect, useRef, useState } from "react";
import { CALLER_DEFAULTS, type CallerGraph, type CallerNode } from "@insight/model";
import { api } from "../../api";
import { readLambdas } from "../../zoom/lambdaPref";
import { hrefFlow, hrefView } from "../../router";
import type { MapSelection } from "./ZoomMap";
import { blindTip, completeness, expandAllKeys, isTreeKey, summaryLine, treeKey, visibleRows, type Row, type TreeRow } from "./callerTree";

/** The link of a chain row, as RefItem links a reverse reference row: a function opens in its scope, or its file's scope when outside it. */
export function callerHref(id: string, scope: string, roots: boolean, node: CallerNode): string {
  return node.isFunction
    ? hrefView(id, "flow", { scope: node.inScope ? scope : node.file, fn: node.id, roots })
    : hrefFlow(id, node.file);
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
  onToggle?(key: string): void;
  onKey?(key: string): void;
  onFocus?(key: string): void;
  onOption?(o: { possible?: boolean; stayInScope?: boolean; depth?: number }): void;
  onExpandAll?(): void;
  onCollapseAll?(): void;
}

/** The chain's controls, summary, tree and completeness note. Presentational: it renders from its props only. */
export function CallerChainView(props: ViewProps) {
  const { id, scope, roots, graph, expanded, possible, stayInScope, depth, lambdas, capped, onOption } = props;
  const rows = visibleRows(graph, expanded, { lambdas });
  const focusKey = props.focus ?? rows[0]?.key;
  const note = completeness(graph, possible);

  return (
    <div className="chain-body">
      <div className="chain-tools">
        <select aria-label="Depth" value={depth} onChange={(e) => onOption?.({ depth: Number(e.target.value) })}>
          {DEPTHS.map((d) => (
            <option key={d.value} value={d.value}>
              {d.label}
            </option>
          ))}
        </select>
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
      <p className="chain-summary muted small">{summaryLine(graph)}</p>
      <ul
        role="tree"
        aria-label="Caller chain"
        className="chain-tree"
        onKeyDown={(e) => {
          if (!isTreeKey(e.key)) return;
          e.preventDefault();
          props.onKey?.(e.key);
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
              href={callerHref(id, scope, roots, r.node)}
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
  const { node, edge } = row;
  const tip = blindTip(node, edge);
  const classes = ["chain-row", node.certainty === "possible" ? "possible" : "", !node.inScope ? "outside" : ""].filter(Boolean).join(" ");
  return (
    <li
      role="treeitem"
      aria-level={row.level}
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
        {edge.kind !== "call" && (
          <>
            {" "}
            <span className={`kind ${edge.kind}`}>{edge.kind === "dispatch" && edge.how === "message" ? "message" : edge.kind}</span>
          </>
        )}
        {edge.count > 1 && <span className="muted small"> ×{edge.count}</span>}
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
export function CallerChain({ id, sel, roots }: { id: string; sel: MapSelection; roots: boolean }) {
  const scope = sel.build.path;
  const fn = sel.selected.ref;
  const fnKey = `${id}\0${scope}\0${fn}`;
  const [opened, setOpened] = useState(false);
  const [possible, setPossible] = useState(false);
  const [stayInScope, setStayInScope] = useState(false);
  const [depth, setDepth] = useState<number>(CALLER_DEFAULTS.maxDepth);
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const [focus, setFocus] = useState<string>();
  const [capped, setCapped] = useState(false);
  const [lastFn, setLastFn] = useState(fnKey);
  const [loaded, setLoaded] = useState<{ key: string; graph?: CallerGraph; error?: string }>();
  const treeRef = useRef<HTMLDetailsElement>(null);
  const reqKey = `${fnKey}\0${possible}\0${stayInScope}`;

  // A different function starts with its own expansion and focus.
  if (lastFn !== fnKey) {
    setLastFn(fnKey);
    setExpanded(new Set());
    setFocus(undefined);
    setCapped(false);
  }

  useEffect(() => {
    if (!opened) return;
    let cancelled = false;
    const key = `${id}\0${scope}\0${fn}\0${possible}\0${stayInScope}`;
    api.getCallerGraph(id, scope, fn, { possible, stayInScope }).then(
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
  }, [opened, id, scope, fn, possible, stayInScope]);

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
      if (row?.type === "node") window.location.assign(callerHref(id, scope, roots, row.node));
    }
  };

  return (
    <details
      ref={treeRef}
      className="ref-list caller-chain"
      onToggle={(e) => {
        if (e.currentTarget.open) setOpened(true);
      }}
    >
      <summary>Caller chain</summary>
      {!opened ? null : current?.error !== undefined ? (
        <p className="muted small">The caller chain is not available: {current.error}</p>
      ) : graph === undefined ? (
        <p className="muted small">Loading the caller chain</p>
      ) : (
        <CallerChainView
          id={id}
          scope={scope}
          roots={roots}
          graph={graph}
          expanded={expanded}
          focus={focus}
          possible={possible}
          stayInScope={stayInScope}
          depth={depth}
          lambdas={lambdas}
          capped={capped}
          onToggle={(key) =>
            setExpanded((prev) => {
              const next = new Set(prev);
              if (next.has(key)) next.delete(key);
              else next.add(key);
              return next;
            })
          }
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
          }}
        />
      )}
    </details>
  );
}
