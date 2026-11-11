import { useEffect, useMemo, useState, type KeyboardEvent } from "react";
import { api, type ArchModel, type Span } from "../../api";
import { diagramModel, FOLDER_GRID, type DiagramModel } from "../../arch/folders";
import { ARCH_HEADER_H, ARCH_PAD, archLayout, arrowKey, arrowLabel, type ArchBox } from "../../arch/layout";
import { IMPORTED_BY, IMPORTS, scopedView, type ScopedDiagram } from "../../arch/scoped";
import { hrefFile, hrefView } from "../../router";

/** What is selected in the diagram: one arrow, named by its key. */
type Selection = { kind: "arrow"; key: string } | null;

const LABEL_CHARS = 18;

/**
 * Folder cards per row: the full grid on a desktop, two on a tablet and one on a phone. A card is 250 px wide, so only one
 * fits a 390 px phone without shrinking it past reading.
 */
const cardsPerRow = (width: number): number => (width <= 520 ? 1 : width <= 860 ? 2 : FOLDER_GRID);
/** Cards per row in the middle band of a scoped diagram: two on a desktop, one below it. */
const bandPerRow = (width: number): number => (width > 1200 ? 2 : 1);

const fit = (text: string, max: number): string => (text.length > max ? `${text.slice(0, max - 1)}…` : text);
const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`;
const layerTitle = (layer: string): string => (layer === "ir" ? "IR" : layer.charAt(0).toUpperCase() + layer.slice(1));
const siteLine = (span: Span): number => span.start[0] + 1;

/**
 * The arch tab: the package architecture, drawn as one column per layer. Packages are folder cards, and each import between
 * two packages is an arrow. The explorer scope picks what is drawn: a folder or package scope shows the cards inside it in
 * a middle band, the packages that import it on the left and the ones it imports on the right (see arch/scoped.ts). The
 * root scope draws the whole project. A click on a card opens it in Arch, or its source for a file. Selecting an arrow
 * lights its two ends and fills the side panel.
 */
export function ArchView({ id, scope }: { id: string; scope: string }) {
  const [done, setDone] = useState<{ id: string; model?: ArchModel; error?: string } | null>(null);
  useEffect(() => {
    let cancelled = false;
    // The model covers the whole snapshot, so the root scope names it.
    api.getScopeArch(id, "").then(
      (model) => {
        if (!cancelled) setDone({ id, model });
      },
      (e: unknown) => {
        if (!cancelled) setDone({ id, error: e instanceof Error ? e.message : String(e) });
      },
    );
    return () => {
      cancelled = true;
    };
  }, [id]);
  if (done?.id !== id) return <p className="muted">Loading</p>;
  if (done.model === undefined) return <p className="error" role="alert">{done.error}</p>;
  if (done.model.packages.length === 0) {
    return <p className="muted">No packages found (this project has no package.json files).</p>;
  }
  // Keyed by scope, so a new scope starts with no arrow selected.
  return <ArchDiagram key={scope} id={id} scope={scope} model={done.model} />;
}

function ArchDiagram({ id, scope, model: whole }: { id: string; scope: string; model: ArchModel }) {
  // A folder or package scope derives its diagram (arch/scoped.ts). The root scope, or a file at the root, has none. A project
  // with one package draws its folders instead (see arch/folders.ts). Everything below reads the shown model.
  const scoped = useMemo<ScopedDiagram | null>(() => scopedView(whole, scope), [whole, scope]);
  const shown = useMemo<DiagramModel>(() => scoped ?? diagramModel(whole), [scoped, whole]);
  const model = shown.model;
  const [width, setWidth] = useState(() => window.innerWidth);
  useEffect(() => {
    const onResize = () => setWidth(window.innerWidth);
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);
  const perRow = cardsPerRow(width);
  const folders = scoped === null && shown.depth !== undefined;
  const layout = useMemo(
    () => archLayout(model, scoped ? { band: { layer: scoped.inner, perRow: bandPerRow(width) } } : folders ? { grid: perRow } : {}),
    [model, scoped, folders, perRow, width],
  );
  // A folder grid narrower than its cards' full row is drawn to the container's width, so every edge stays inside it.
  const fitWidth = folders && perRow < FOLDER_GRID;
  const [sel, setSel] = useState<Selection>(null);
  // The scope's folder (a file scope gives its folder), and how many cards lie inside it.
  const at = scoped?.scope ?? "";
  const innerCount = scoped ? model.packages.filter((p) => p.layer === scoped.inner).length : 0;
  const empty = scoped !== null && innerCount === 0;

  // The boxes lit by the selection: the two ends of the selected arrow.
  const lit = useMemo<Set<string> | null>(() => {
    if (sel === null) return null;
    const arrow = layout.arrows.find((a) => a.key === sel.key);
    return arrow ? new Set([arrow.from, arrow.to]) : null;
  }, [sel, layout]);

  const arrowLit = (key: string): boolean => sel !== null && key === sel.key;

  // Lit arrows are drawn last, so they sit on top of the rest.
  const arrows = [...layout.arrows].sort((a, b) => Number(arrowLit(a.key)) - Number(arrowLit(b.key)));

  // A file card opens its source. Any other card opens its folder or package in Arch, as the scope. The root package ('.') is the project.
  const fileCard = (box: ArchBox): boolean => scoped !== null && scoped.cards === "files" && box.pkg.layer === scoped.inner;
  const cardHref = (box: ArchBox): string =>
    fileCard(box) ? hrefFile(id, box.pkg.path) : hrefView(id, "arch", { scope: box.pkg.path === "." ? "" : box.pkg.path });
  const openBox = (box: ArchBox) => {
    window.location.hash = cardHref(box);
  };
  const boxKey = (box: ArchBox, e: KeyboardEvent<SVGGElement>) => {
    if (e.key !== "Enter" && e.key !== " ") return;
    e.preventDefault();
    openBox(box);
  };

  const parts = at ? at.split("/") : [];
  return (
    <div className="arch">
      {scoped !== null && (
        <div className="arch-scope-head">
          <nav className="arch-crumbs" aria-label="Scope">
            {parts.length === 0 ? (
              <span aria-current="page">Project</span>
            ) : (
              <a href={hrefView(id, "arch")}>Project</a>
            )}
            {parts.map((seg, i) => {
              const path = parts.slice(0, i + 1).join("/");
              const current = i === parts.length - 1;
              return (
                <span key={path}>
                  <span className="muted"> / </span>
                  {current ? <span aria-current="page">{seg}</span> : <a href={hrefView(id, "arch", { scope: path })}>{seg}</a>}
                </span>
              );
            })}
          </nav>
          <a className="arch-flow small" href={hrefView(id, "flow", { scope: at })}>
            Open in Flow
          </a>
        </div>
      )}
      {scoped !== null && !empty && (
        <p className="muted small arch-caption">
          Inside {at}: {scoped.cards === "folders" ? `${plural(innerCount, "folder")} (cut at depth ${scoped.depth})` : plural(innerCount, "file")}.
          Left: what imports it. Right: what it imports.
          {scoped.fromFile !== undefined && " Scope is a file; showing its folder."}
          {scoped.notDrawn > 0 &&
            ` ${scoped.notDrawn} cross-package ${scoped.notDrawn === 1 ? "link has" : "links have"} no import site and ${
              scoped.notDrawn === 1 ? "is" : "are"
            } not drawn.`}
        </p>
      )}
      {scoped === null && shown.depth !== undefined && (
        <p className="muted small arch-caption">
          {plural(whole.packages.length, "package")} in this project, so the cards are its folders that hold code, cut at depth{" "}
          {shown.depth} (1 is the top-level directories). Edges add up the imports between files in each pair of folders.
        </p>
      )}
      {empty && <p className="muted">No source files in {at}.</p>}
      {!empty && <div className="arch-scroll">
        <svg
          className="arch-svg"
          width={fitWidth ? undefined : layout.width}
          height={fitWidth ? undefined : layout.height}
          style={fitWidth ? { width: "100%", height: "auto" } : undefined}
          viewBox={`0 0 ${layout.width} ${layout.height}`}
          role="img"
          aria-label="Package architecture"
        >
          <defs>
            <marker id="arch-head" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
              <path className="arch-head" d="M0 0 L10 5 L0 10 z" />
            </marker>
            <marker id="arch-head-error" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
              <path className="arch-head error" d="M0 0 L10 5 L0 10 z" />
            </marker>
          </defs>
          {/* Clicking the empty diagram clears the selection. Boxes and arrows stop the click before it gets here. */}
          <rect className="arch-bg" x={0} y={0} width={layout.width} height={layout.height} onClick={() => setSel(null)} />
          {layout.columns.map((col) => (
            <text key={col.layer} className="arch-layer" x={col.x} y={ARCH_PAD + ARCH_HEADER_H / 2 + 4}>
              {layerTitle(col.layer)}
            </text>
          ))}
          {arrows.map((a) => {
            const on = arrowLit(a.key);
            const dim = sel !== null && !on;
            const cls = ["arch-arrow", on && "lit", dim && "dim", a.violation && "violation", a.dashed && "dashed"].filter(Boolean).join(" ");
            const pick = (e: { stopPropagation: () => void }) => {
              e.stopPropagation();
              setSel({ kind: "arrow", key: a.key });
            };
            return (
              <g key={a.key}>
                <path className={cls} d={a.d} strokeWidth={a.width} markerEnd={a.violation ? "url(#arch-head-error)" : "url(#arch-head)"} />
                <path className="arch-hit" d={a.d} onClick={pick}>
                  <title>{`${a.from} -> ${a.to}: ${plural(a.edge.imports, "import")}, ${plural(a.edge.calls, "call")}`}</title>
                </path>
                <text className={`arch-count${dim ? " dim" : ""}`} x={a.label.x} y={a.label.y} textAnchor="middle" dy="0.35em" onClick={pick}>
                  {arrowLabel(a.edge)}
                </text>
              </g>
            );
          })}
          {layout.boxes.map((box) => {
            const dim = lit !== null && !lit.has(box.id);
            const cls = ["arch-box", dim && "dim"].filter(Boolean).join(" ");
            const file = fileCard(box);
            const action = file ? "Open source" : "Open in Arch";
            // A boundary card's line counts its imports, over all its arrows. Other cards count their files.
            const boundary = scoped !== null && (box.pkg.layer === IMPORTED_BY || box.pkg.layer === IMPORTS);
            const imports = boundary ? layout.arrows.reduce((n, a) => (a.from === box.id || a.to === box.id ? n + a.edge.imports : n), 0) : 0;
            return (
              <g
                key={box.id}
                className={cls}
                role="button"
                tabIndex={0}
                aria-label={`${box.pkg.name}, ${boundary ? plural(imports, "import") : plural(box.pkg.fileCount, "file")}. ${action}`}
                onClick={(e) => {
                  e.stopPropagation();
                  openBox(box);
                }}
                onKeyDown={(e) => boxKey(box, e)}
              >
                <title>{`${box.pkg.path}: ${action.toLowerCase()}`}</title>
                <rect x={box.x} y={box.y} width={box.w} height={box.h} rx={14} style={{ fill: `var(--band-${box.column % 6})` }} />
                <text className="arch-name" x={box.x + 14} y={box.y + 34}>
                  {fit(box.pkg.name, LABEL_CHARS)}
                </text>
                <text className="arch-sub" x={box.x + 14} y={box.y + 60}>
                  {boundary
                    ? plural(imports, "import")
                    : box.pkg.functions === undefined
                      ? plural(box.pkg.fileCount, "file")
                      : `${plural(box.pkg.fileCount, "file")} · ${box.pkg.functions} fns`}
                </text>
              </g>
            );
          })}
        </svg>
      </div>}
      {!empty && shown.other > 0 && (
        <p className="muted small arch-other">
          Other: {shown.other} {shown.other === 1 ? "folder" : "folders"} without code
        </p>
      )}
      {!empty && <Panel id={id} model={model} sel={sel} externalsOf={scoped?.pkg?.name} />}
    </div>
  );
}

function Panel({ id, model, sel, externalsOf }: { id: string; model: ArchModel; sel: Selection; externalsOf?: string }) {
  return (
    <aside className="arch-panel">
      {sel === null ? (
        <>
          <Violations id={id} model={model} />
          <p className="muted small">
            Click a card to open it: a folder or package in Arch, a file in Source. Select an arrow to see its import sites. An
            arrow&apos;s number counts imports; &quot;c&quot; means calls only. Dashed arrows are inferred, for example a workspace
            import matched by package name.
          </p>
        </>
      ) : (
        <ArrowDetail id={id} model={model} arrow={sel.key} />
      )}
      {externalsOf !== undefined && <Externals name={externalsOf} rows={model.externals} />}
      <Unresolved id={id} model={model} />
    </aside>
  );
}

/** The external packages a scope's package imports, with their import counts. Only drawn for a scoped view. */
function Externals({ name, rows }: { name: string; rows: ArchModel["externals"] }) {
  return (
    <details className="arch-unresolved">
      <summary>
        <h2>
          External packages of {name} ({rows.length})
        </h2>
      </summary>
      {rows.length === 0 ? (
        <p className="muted small">No external packages.</p>
      ) : (
        <ul className="arch-list">
          {rows.map((x) => (
            <li key={x.name}>
              <span className="mono small">{x.name}</span> {plural(x.imports, "import")}
            </li>
          ))}
        </ul>
      )}
    </details>
  );
}

function Violations({ id, model }: { id: string; model: ArchModel }) {
  const rows = model.violations;
  return (
    <section>
      <h2>Rule violations ({rows.length})</h2>
      {rows.length === 0 ? (
        <p className="muted small">No rule is broken.</p>
      ) : (
        <ul className="arch-list">
          {rows.map((v, i) => {
            const first = v.sites[0];
            return (
              <li key={`${v.from}\0${v.to}\0${i}`}>
                <div className="error small">{v.rule}</div>
                <div className="mono small">
                  {v.from} -&gt; {v.to}
                </div>
                {first && (
                  <a className="mono small" href={hrefFile(id, first.file, siteLine(first))}>
                    {first.file}:{siteLine(first)}
                  </a>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

/** The selected arrow: its counts, confidence, rule violation and import sites. `arrow` is the arrow's key. */
function ArrowDetail({ id, model, arrow }: { id: string; model: ArchModel; arrow: string }) {
  const edge = model.edges.find((e) => arrowKey(e.from, e.to) === arrow);
  if (!edge) return null;
  const violation = model.violations.find((v) => v.from === edge.from && v.to === edge.to);
  return (
    <section>
      <h2 className="mono">
        {edge.from} -&gt; {edge.to}
      </h2>
      <p className="small">
        {plural(edge.imports, "import")}, {plural(edge.calls, "call")}, confidence {edge.confidence}
      </p>
      {violation && <p className="error small">Breaks the rule: {violation.rule}</p>}
      <h3>Import sites</h3>
      <Sites id={id} sites={edge.sites} />
    </section>
  );
}

function Sites({ id, sites }: { id: string; sites: Span[] }) {
  if (sites.length === 0) return <p className="muted small">No import sites recorded: this arrow comes from calls the IR resolved across the two packages.</p>;
  return (
    <ul className="arch-list">
      {sites.map((s, i) => (
        <li key={`${s.file}\0${s.start[0]}\0${s.start[1]}\0${i}`}>
          <a className="mono small" href={hrefFile(id, s.file, siteLine(s))}>
            {s.file}:{siteLine(s)}
          </a>
        </li>
      ))}
    </ul>
  );
}

function Unresolved({ id, model }: { id: string; model: ArchModel }) {
  const rows = model.unresolved;
  return (
    <details className="arch-unresolved">
      <summary>
        <h2>Unresolved imports ({rows.length})</h2>
      </summary>
      {rows.length === 0 ? (
        <p className="muted small">Every relative import resolves.</p>
      ) : (
        <ul className="arch-list">
          {rows.map((u, i) => (
            <li key={`${u.fromPackage}\0${u.text}\0${i}`}>
              <span className="mono small">{u.fromPackage}</span> imports <code>{u.text}</code>
              {u.span && (
                <>
                  {" "}
                  <a className="mono small" href={hrefFile(id, u.span.file, siteLine(u.span))}>
                    {u.span.file}:{siteLine(u.span)}
                  </a>
                </>
              )}
            </li>
          ))}
        </ul>
      )}
    </details>
  );
}
