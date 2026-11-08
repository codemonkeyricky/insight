// Zoom spike: one d3-zoom camera over a folder (or the project), where a file box opens into its functions once
// it is big enough on screen. Layouts run in the ELK worker. The camera moves without re-rendering React: the
// transform goes straight onto a <g>, and React re-renders only when the visible or expanded set changes.
import { Profiler, useEffect, useRef, useState, type ProfilerOnRenderCallback } from "react";
import { select, pointer } from "d3-selection";
import "d3-transition";
import { zoom, zoomIdentity, type D3ZoomEvent, type ZoomBehavior, type ZoomTransform } from "d3-zoom";
import { createRoot } from "react-dom/client";
import { FRAME_HEAD, FRAME_PAD, folderScene, functionLayout, rootScene, type Box, type Edge, type FunctionLayout, type Scene } from "./scenes";

/** A file box opens once it is this wide on screen, and closes again below the lower mark, so it does not flicker. */
const EXPAND_PX = 240;
const COLLAPSE_PX = 200;
const SCALE: [number, number] = [0.02, 16];

interface Metrics {
  layouts: { name: string; ms: number; where: string; nodes: number; edges: number; wallMs: number }[];
  fnLayouts: { file: string; ms: number; where: string; boxes: number; wallMs: number }[];
  /** Milliseconds spent in each camera update (culling and the imperative transform). */
  frames: number[];
  /** Actual render time of each React commit, from the Profiler. */
  commits: number[];
}
declare global {
  interface Window {
    __zoomSpike?: Metrics;
  }
}
const metrics: Metrics = (window.__zoomSpike = { layouts: [], fnLayouts: [], frames: [], commits: [] });

interface Expanded {
  id: string;
  fn: FunctionLayout | null;
  error?: string;
}

interface Visible {
  boxes: Box[];
  edges: Edge[];
  key: string;
}

const EMPTY_VISIBLE: Visible = { boxes: [], edges: [], key: "" };

/** The part of the world the window shows at this camera. */
function worldRect(t: ZoomTransform, w: number, h: number) {
  return { x0: -t.x / t.k, y0: -t.y / t.k, x1: (w - t.x) / t.k, y1: (h - t.y) / t.k };
}

const hits = (b: { x: number; y: number; w: number; h: number }, r: ReturnType<typeof worldRect>) =>
  b.x < r.x1 && b.x + b.w > r.x0 && b.y < r.y1 && b.y + b.h > r.y0;

function pointsBox(points: [number, number][]) {
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const [x, y] of points) {
    x0 = Math.min(x0, x);
    y0 = Math.min(y0, y);
    x1 = Math.max(x1, x);
    y1 = Math.max(y1, y);
  }
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

function polyline(points: [number, number][]) {
  return points.map(([x, y], i) => `${i === 0 ? "M" : "L"}${x.toFixed(1)} ${y.toFixed(1)}`).join(" ");
}

function ZoomSpike() {
  const svgRef = useRef<SVGSVGElement>(null);
  const gRef = useRef<SVGGElement>(null);
  const zoomRef = useRef<ZoomBehavior<SVGSVGElement, unknown>>(undefined);
  const transform = useRef<ZoomTransform>(zoomIdentity);
  const sceneRef = useRef<Scene | null>(null);
  const sizeRef = useRef({ w: window.innerWidth, h: window.innerHeight });
  const expandedRef = useRef<string | null>(null);
  const fnCache = useRef(new Map<string, FunctionLayout>());
  const frameId = useRef(0);
  const decide = useRef(true);
  const pointerAt = useRef<[number, number] | null>(null);
  const seq = useRef(0);
  const visibleKey = useRef("");

  const [size, setSize] = useState(sizeRef.current);
  const [scene, setScene] = useState<Scene | null>(null);
  const [expanded, setExpanded] = useState<Expanded | null>(null);
  const [visible, setVisible] = useState<Visible>(EMPTY_VISIBLE);
  const [status, setStatus] = useState("starting");
  const [hud, setHud] = useState({ scale: 1, frameAvg: 0, frameMax: 0 });

  const commitMetrics: ProfilerOnRenderCallback = (_id, _phase, actual) => {
    metrics.commits.push(actual);
  };

  // The camera. The zoom event only records the transform and asks for one update per animation frame.
  useEffect(() => {
    const svg = svgRef.current;
    if (!svg) return;
    const z = zoom<SVGSVGElement, unknown>()
      .scaleExtent(SCALE)
      .on("zoom", (ev: D3ZoomEvent<SVGSVGElement, unknown>) => {
        transform.current = ev.transform;
        const src = ev.sourceEvent as Event | null;
        // A wheel or a click puts the focus under the pointer. A drag only pans, so it leaves the open file alone.
        decide.current = !(src && (src.type === "mousemove" || src.type === "touchmove"));
        pointerAt.current = src && "clientX" in src ? pointer(src, svg) : null;
        if (!frameId.current) frameId.current = requestAnimationFrame(update);
      });
    zoomRef.current = z;
    select(svg).call(z);
    return () => {
      select(svg).on(".zoom", null);
      cancelAnimationFrame(frameId.current);
    };
    // update is stable: it reads everything through refs.
  }, []);

  useEffect(() => {
    const onResize = () => {
      sizeRef.current = { w: window.innerWidth, h: window.innerHeight };
      setSize(sizeRef.current);
    };
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  /** Expands the file under the focus once it is wide enough, closes the open one once it is too narrow, and culls. */
  function update() {
    frameId.current = 0;
    const s = sceneRef.current;
    const z = zoomRef.current;
    const svg = svgRef.current;
    if (!s || !z || !svg) return;
    const t0 = performance.now();
    const t = transform.current;
    const { w, h } = sizeRef.current;
    gRef.current?.setAttribute("transform", `translate(${t.x} ${t.y}) scale(${t.k})`);

    if (decide.current) {
      const p = pointerAt.current ?? [w / 2, h / 2];
      const focus = { x: (p[0] - t.x) / t.k, y: (p[1] - t.y) / t.k };
      const open = expandedRef.current;
      const openBox = open ? s.boxes.find((b) => b.id === open) : undefined;
      let next = openBox && openBox.w * t.k >= COLLAPSE_PX ? open : null;
      const under = s.boxes.find((b) => focus.x >= b.x && focus.x <= b.x + b.w && focus.y >= b.y && focus.y <= b.y + b.h);
      if (under && under.w * t.k > EXPAND_PX) next = under.id;
      if (next !== expandedRef.current) {
        expandedRef.current = next;
        if (next === null) setExpanded(null);
        else {
          const cached = fnCache.current.get(next);
          setExpanded({ id: next, fn: cached ?? null });
          if (!cached) openFile(next, s.name);
        }
      }
    }

    const r = worldRect(t, w, h);
    const boxes = s.boxes.filter((b) => hits(b, r));
    const edges = s.edges.filter((e) => hits(pointsBox(e.points), r));
    const key = `${boxes.map((b) => b.id).join("|")}#${edges.length}#${expandedRef.current ?? ""}`;
    if (key !== visibleKey.current) {
      visibleKey.current = key;
      setVisible({ boxes, edges, key });
    }
    const ms = performance.now() - t0;
    metrics.frames.push(ms);
    const recent = metrics.frames.slice(-120);
    setHud({ scale: t.k, frameAvg: recent.reduce((a, b) => a + b, 0) / recent.length, frameMax: Math.max(...recent) });
  }

  function openFile(id: string, sceneName: string) {
    const started = performance.now();
    functionLayout(id).then(
      (fl) => {
        fnCache.current.set(id, fl);
        metrics.fnLayouts.push({ file: id, ms: fl.layout.ms, where: fl.layout.where, boxes: fl.boxes.length, wallMs: performance.now() - started });
        if (expandedRef.current === id) {
          setExpanded({ id, fn: fl });
          visibleKey.current = "";
          if (!frameId.current) frameId.current = requestAnimationFrame(update);
        }
      },
      (err: unknown) => {
        if (expandedRef.current === id) setExpanded({ id, fn: null, error: `${sceneName}: ${String(err)}` });
      },
    );
  }

  async function choose(kind: "folder" | "project") {
    const mine = ++seq.current;
    setStatus(`laying out ${kind}...`);
    const started = performance.now();
    const s = kind === "folder" ? await folderScene("packages/", "packages") : await rootScene();
    if (mine !== seq.current) return;
    metrics.layouts.push({ name: `${kind} (${s.boxes.length} boxes)`, ms: s.layout.ms, where: s.layout.where, nodes: s.layout.nodes, edges: s.layout.edges, wallMs: performance.now() - started });
    sceneRef.current = s;
    expandedRef.current = null;
    visibleKey.current = "";
    setExpanded(null);
    setScene(s);
    setStatus(`${kind}: ${s.layout.nodes} boxes, ${s.layout.edges} calls, layout ${Math.round(s.layout.ms)} ms (${s.layout.where})`);
    fit(s.width, s.height);
  }

  /** Moves the camera so the whole rectangle is visible. Animated, so the zoom steps read as one motion. */
  function fit(width: number, height: number, animate = false) {
    const svg = svgRef.current;
    const z = zoomRef.current;
    if (!svg || !z) return;
    const { w, h } = sizeRef.current;
    const k = Math.min(w / width, h / height) * 0.96;
    const t = zoomIdentity.translate((w - width * k) / 2, (h - height * k) / 2).scale(k);
    if (animate) select(svg).transition().duration(700).call(z.transform, t);
    else select(svg).call(z.transform, t);
  }

  function fitBox(b: Box) {
    const { w, h } = sizeRef.current;
    const k = Math.min(w / (b.w * 1.08), h / (b.h * 1.08), SCALE[1]);
    const svg = svgRef.current;
    const z = zoomRef.current;
    if (!svg || !z) return;
    const t = zoomIdentity.translate(w / 2 - (b.x + b.w / 2) * k, h / 2 - (b.y + b.h / 2) * k).scale(k);
    select(svg).transition().duration(700).call(z.transform, t);
  }

  useEffect(() => {
    // choose reads only refs and the seq counter, so it runs once.
    void choose("folder");
  }, []);

  const level = expanded ? "file" : "folder";
  const fnView = expanded?.fn ?? null;
  return (
    <>
      <div className="zs-hud" aria-live="polite">
        <div className="zs-row">
          <button type="button" onClick={() => void choose("folder")}>Folder: packages/</button>
          <button type="button" onClick={() => void choose("project")}>Project root</button>
          <button type="button" onClick={() => scene && fit(scene.width, scene.height, true)}>Fit all</button>
        </div>
        <div>{status}</div>
        <div>
          level <b>{level}</b> · scale {hud.scale.toFixed(2)}
          {expanded ? ` · open: ${expanded.id}` : ""}
          {expanded && !expanded.fn && !expanded.error ? " · laying out functions..." : ""}
        </div>
        <div>
          camera update avg {hud.frameAvg.toFixed(2)} ms, max {hud.frameMax.toFixed(2)} ms
        </div>
        {expanded?.error ? <div className="zs-err">{expanded.error}</div> : null}
      </div>
      <Profiler id="scene" onRender={commitMetrics}>
        <svg ref={svgRef} className="zs-svg" width={size.w} height={size.h} role="img" aria-label="Zoomable call map">
          <g ref={gRef}>
            {visible.edges.map((e) => (
              <path key={`e${e.id}`} d={polyline(e.points)} className="zs-edge" />
            ))}
            {visible.boxes.map((b) => {
              if (expanded && expanded.id === b.id && fnView) {
                const fw = Math.max(b.w, fnView.width + 2 * FRAME_PAD);
                const fh = Math.max(b.h, fnView.height + FRAME_HEAD + FRAME_PAD);
                const ox = b.x + FRAME_PAD;
                const oy = b.y + FRAME_HEAD;
                return (
                  <g key={b.id} className="zs-frame">
                    <rect x={b.x} y={b.y} width={fw} height={fh} rx={8} />
                    <text x={b.x + 12} y={b.y + 20} className="zs-title">{b.label}</text>
                    {fnView.edges.map((e) => (
                      <path key={`fe${e.id}`} transform={`translate(${ox} ${oy})`} d={polyline(e.points)} className="zs-edge" />
                    ))}
                    {fnView.boxes.map((f) => (
                      <g key={f.id} transform={`translate(${ox + f.x} ${oy + f.y})`} className="zs-fn">
                        <rect width={f.w} height={f.h} rx={5} />
                        <text x={8} y={18}>{f.label}</text>
                        <text x={8} y={33} className="zs-sub">{f.sub}</text>
                      </g>
                    ))}
                  </g>
                );
              }
              return (
                <g key={b.id} transform={`translate(${b.x} ${b.y})`} className="zs-box" onClick={() => fitBox(b)}>
                  <rect width={b.w} height={b.h} rx={6} />
                  <text x={10} y={18}>{b.label}</text>
                  <text x={10} y={34} className="zs-sub">{b.sub}{b.count ? ` · ${b.count} fn` : ""}</text>
                </g>
              );
            })}
          </g>
        </svg>
      </Profiler>
    </>
  );
}

const SPIKE_STYLE = `
  html, body, #root { margin: 0; height: 100%; font: 12px/1.3 system-ui, sans-serif; background: #f6f7f9; color: #1d2433; overflow: hidden; }
  .zs-svg { display: block; cursor: grab; touch-action: none; }
  .zs-hud { position: fixed; left: 12px; top: 12px; z-index: 2; background: #ffffffee; border: 1px solid #d9dde6; border-radius: 8px; padding: 8px 10px; max-width: 520px; }
  .zs-row { display: flex; gap: 6px; margin-bottom: 6px; }
  .zs-hud button { font: inherit; padding: 3px 8px; }
  .zs-err { color: #a86b00; }
  .zs-box rect { fill: #e6eefb; stroke: #5d6578; stroke-width: 1; cursor: pointer; }
  .zs-box:nth-child(3n) rect { fill: #e7f4ec; }
  .zs-box:nth-child(3n+2) rect { fill: #fbf1de; }
  .zs-box text { font-size: 13px; fill: #1d2433; pointer-events: none; }
  .zs-frame rect { fill: #ffffffdd; stroke: #3b6fd1; stroke-width: 2; }
  .zs-title { font-size: 14px; font-weight: 600; fill: #1d2433; }
  .zs-fn rect { fill: #ffffff; stroke: #2f7d5b; stroke-width: 1.2; }
  .zs-fn text { font-size: 12px; fill: #1d2433; }
  .zs-sub { font-size: 10px; fill: #5d6578; }
  .zs-edge { fill: none; stroke: #8a92a3; stroke-width: 1.4; }
`;

const style = document.createElement("style");
style.textContent = SPIKE_STYLE;
document.head.appendChild(style);
createRoot(document.getElementById("root") as HTMLElement).render(<ZoomSpike />);
