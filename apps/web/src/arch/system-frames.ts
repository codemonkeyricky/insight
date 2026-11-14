import type { SystemEdge, SystemExternal, SystemModel, SystemResource, SystemRoute, SystemRuntime, SystemSlice } from "@insight/model";
import { CATEGORY_ORDER, CATEGORY_TITLES, pillText, routeText, shortLabel, type SysArrow, type SysBand, type SysBox, type SysFrame, type SysGroup, type SysLayout, type SysStrip, type SysTrunk } from "./system-layout";

// The geometry of the System view when the model is grounded (nested process > thread > coroutine frames, each with its
// slices), and of the flat model (components only, with the same kernel band and outside column). Pure: no React.
// Frames sit in a column per process; the slices of every frame share one stage-column grid, so a component lines up across
// frames. Each process has an in-process strip at its right edge; the kernel band is the full-height column after the
// strips; outside systems come after the band. Edges to outside systems go through one chip per API or syscall on the band.

/** Slices a frame shows before the "+N more" chip. */
export const SLICE_LIMIT = 9;

const CARD_W = 196;
const COL_GAP = 70;
const PAD = 10;
const HDR_H = 30;
const SLICE_H = 50;
const SLICE_GAP = 8;
const FRAME_GAP = 12;
const STRIP_W = 200;
const STRIP_GAP = 26;
const STRIP_TITLE_H = 26;
const RES_H = 40;
const RES_GAP = 6;
const BAND_MIN_W = 184;
const BAND_MAX_W = 380;
const PORT_GAP = 16;
// Text width estimates (px per character) for the fonts the view uses: card names 18 px, sub lines 14 px, chips 13 px mono.
const NAME_CH = 10;
const SUB_CH = 8.2;
const CODE_CH = 7.9;
const BAND_TITLE_H = 40;
const GAP_X = 150;
const OUT_W = 210;
const OUT_H = 46;
const OUT_GAP = 10;
const GROUP_H = 30;
const CHIP_H = 20;
const CHIP_GAP = 4;
const CHIP_ROW = 20;
const COMP_H = 64;
const TOP = 74;
const MARGIN = 28;
const MAX_CHIPS = 4;
const PILL_H = 24;
const ROUTE_GUTTER = 7;

export interface FrameOptions {
  /** Frames drawn collapsed: their header only, their edges re-attached to the header. */
  collapsed?: ReadonlySet<string>;
  /** Frames whose "+N more" chip was clicked: every slice is drawn. */
  widened?: ReadonlySet<string>;
  /** Auto-collapsed groups the user opened: a thread id (its coroutines are drawn one by one) or an unthreaded frame id. */
  open?: ReadonlySet<string>;
  /** The viewport the grid of process frames aims at, in px (default 1280 x 750). */
  viewport?: { w: number; h: number };
}

/** A thread with more coroutines than this, or an unthreaded frame with more slices, is drawn as one summary row. */
export const GROUP_MIN = 3;

/** A frame of the drawing tree, before its size and position are known. */
interface FNode {
  id: string;
  kind: SysFrame["kind"];
  rt?: SystemRuntime;
  container?: string;
  children: FNode[];
  slices: SystemSlice[];
  resources: SystemResource[];
  h: number;
  x: number;
  y: number;
  w: number;
  visible: SystemSlice[];
  hidden: number;
  /** A coroutine: the slices it shares with its thread (not drawn, their edges sit on the header) and the thread's label. */
  shared?: number;
  sharedWith?: string;
  /** The component the coroutine starts in, named in its header when none of its slices is drawn. */
  startsIn?: string;
  /** Set on an auto-collapsed frame: the key that opens it (see FrameOptions.open). */
  openKey?: string;
  /** A coroutine summary row: how many coroutines it stands for. */
  groupCount?: number;
  /** Where the free part of the right edge starts (below the strip's resources), for ports. */
  portTop?: number;
}

/** An inferred edge is drawn dashed and faded, except the Pipeline's produces and feeds facts. Direct and bundled arrows agree. */
const isInferred = (e: SystemEdge): boolean => e.confidence === "inferred" && e.verb !== "produces" && e.verb !== "feeds";
const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
const plural = (n: number, one: string): string => `${n} ${n === 1 ? one : `${one}s`}`;

/** The glyph of a resource card: a queue, a lock (drawn by the view), a semaphore, a condvar, the env "$", or a kernel op. */
export function resourceGlyph(kind: SystemResource["kind"]): string {
  return kind === "queue" ? "queue" : kind === "lock" ? "lock" : kind === "semaphore" ? "semaphore" : kind === "condvar" ? "condvar" : kind === "env" ? "$" : "os";
}

/** The chip a fact draws on the band: the syscall when the evidence has one, else the API, else the edge's label. */
export function chipLabelOf(edge: SystemEdge): string {
  const best = [...(edge.evidence ?? [])].sort((a, b) => b.count - a.count || cmp(a.api, b.api))[0];
  if (best !== undefined) return best.syscall ?? best.api;
  return edge.label.split(",")[0]?.trim() || edge.verb;
}

/** Grounded frames and the flat model, drawn over the same stage columns. */
export function layoutSystemFrames(sys: SystemModel, opts: FrameOptions = {}): SysLayout {
  const collapsed = opts.collapsed ?? new Set<string>();
  const widened = opts.widened ?? new Set<string>();
  const open = opts.open ?? new Set<string>();
  // Frames collapsed by default (a coroutine summary, a big unthreaded frame), until the user opens them.
  const autoCollapsed = new Set<string>();
  const isCol = (id: string): boolean => collapsed.has(id) || autoCollapsed.has(id);
  const coGroups = new Map<string, { count: number; open: boolean }>(); // thread id -> its coroutine summary
  let gridRight = 0;
  const grounded = sys.runtime === "grounded" && (sys.runtimes ?? []).length > 0;
  const compById = new Map(sys.components.map((c) => [c.id, c]));
  const routesBy = new Map<string, SystemRoute[]>();
  for (const r of sys.routes) {
    const l = routesBy.get(r.component);
    if (l === undefined) routesBy.set(r.component, [r]);
    else l.push(r);
  }

  // Columns: the stage of each component, densely numbered over the components that are drawn.
  const stageOf = new Map<string, number>();
  sys.stages.forEach((stage, i) => stage.forEach((id) => stageOf.set(id, i)));
  // A slice with no functions of its own (a hollow link in the call chain) is not drawn, nor are its edges.
  const slices = grounded ? (sys.slices ?? []).filter((x) => x.functions > 0) : [];
  const used = grounded ? new Set(slices.map((s) => s.component)) : new Set(sys.components.map((c) => c.id));
  const stagesUsed = [...new Set([...used].map((id) => stageOf.get(id) ?? Number.MAX_SAFE_INTEGER))].sort((a, b) => a - b);
  const denseOf = new Map(stagesUsed.map((s, i) => [s, i]));
  const C = Math.max(1, stagesUsed.length);
  const colOf = (comp: string): number => denseOf.get(stageOf.get(comp) ?? Number.MAX_SAFE_INTEGER) ?? C - 1;
  const innerW = C * CARD_W + (C - 1) * COL_GAP;
  const procW = innerW + 6 * PAD + STRIP_GAP + STRIP_W;

  const frames: SysFrame[] = [];
  const strips: SysStrip[] = [];
  const boxes: SysBox[] = [];
  const frameOfItem = new Map<string, string>(); // slice or resource id -> the frame that holds it
  const frameById = new Map<string, FNode>();
  let H = 0;

  const resources = sys.resources ?? [];
  const hasEnv = resources.some((r) => r.kind === "env");
  // The outside systems that are drawn (the config external gives way to an env resource), and the kernel-op ids.
  const ext = sys.externals.filter((e) => !(hasEnv && e.category === "config"));
  const extShown = new Set(ext.map((e) => e.id));
  const osIds = new Set(resources.filter((r) => r.kind === "os").map((r) => r.id));
  /** The band item an edge ends on: a chip for an outside system, the kernel-op box itself, else none (an in-process edge). */
  const bandTargetOf = (e: SystemEdge): string | undefined => (extShown.has(e.to) ? `chip:${chipLabelOf(e)}` : osIds.has(e.to) ? e.to : undefined);
  // Slices a coroutine shares with its thread are not drawn: item id -> the frame whose header carries their edges.
  const hiddenAt = new Map<string, string>();
  const portKeys = new Map<string, Set<string>>(); // top frame id -> the band targets its edges bundle into

  if (grounded) {
    const rts = new Map((sys.runtimes ?? []).map((r) => [r.id, r] as const));
    const nodes: FNode[] = [];
    const add = (rt: SystemRuntime, kind: SysFrame["kind"], container?: string): FNode => {
      const n: FNode = { id: rt.id, kind, rt, ...(container !== undefined ? { container } : {}), children: [], slices: [], resources: [], h: 0, x: 0, y: 0, w: 0, visible: [], hidden: 0 };
      frameById.set(rt.id, n);
      nodes.push(n);
      return n;
    };
    // The frame that holds a runtime's own frame; a thread with implicit:true draws no frame.
    for (const r of rts.values()) {
      if (r.kind === "program") add(r, "process");
      else if (r.kind === "unthreaded") add(r, "unthreaded");
      else if (r.kind === "thread" && r.implicit !== true) add(r, "thread", r.parent);
    }
    for (const r of rts.values()) {
      if (r.kind !== "coroutine") continue;
      const t = r.parent === undefined ? undefined : rts.get(r.parent);
      const holder = t === undefined ? undefined : t.kind === "thread" && t.implicit === true ? t.parent : t.id;
      add(r, "coroutine", holder);
    }
    // Each runtime's slices go to its frame; an implicit thread's slices go to its process.
    const hostOf = (rtId: string): string | undefined => {
      const r = rts.get(rtId);
      if (r === undefined) return undefined;
      if (r.kind === "thread" && r.implicit === true) return r.parent;
      return r.id;
    };
    for (const s of slices) {
      const host = hostOf(s.runtime);
      const node = host === undefined ? undefined : frameById.get(host);
      if (node === undefined) continue;
      node.slices.push(s);
      frameOfItem.set(s.id, node.id);
    }
    // A coroutine frame shows only the components it runs that its thread does not run itself (and the one it starts in).
    // The rest repeat the thread's own slices: they are counted in the header ("also runs N components of Main thread")
    // and their edges sit on the coroutine's header, so nothing is hidden, only not drawn twice.
    const componentsOnRuntime = new Map<string, Set<string>>();
    for (const s of slices) {
      const set = componentsOnRuntime.get(s.runtime) ?? new Set<string>();
      set.add(s.component);
      componentsOnRuntime.set(s.runtime, set);
    }
    for (const n of nodes) {
      if (n.kind !== "coroutine" || n.rt?.parent === undefined) continue;
      const parentRt = n.rt.parent;
      const onParent = componentsOnRuntime.get(parentRt) ?? new Set<string>();
      const own = n.slices.filter((s) => !onParent.has(s.component));
      const ownSet = new Set(own);
      const shared = n.slices.filter((s) => !ownSet.has(s));
      if (shared.length === 0) continue;
      n.slices = own;
      n.shared = shared.length;
      const rootSlice = shared.find((s) => s.root);
      if (rootSlice !== undefined) n.startsIn = compById.get(rootSlice.component)?.label ?? rootSlice.component;
      n.sharedWith = rts.get(parentRt)?.label ?? parentRt;
      for (const s of shared) hiddenAt.set(s.id, n.id);
    }
    for (const r of resources) {
      if (r.kind === "os" || r.program === undefined) continue;
      const node = frameById.get(r.program);
      if (node === undefined || node.kind !== "process") continue;
      node.resources.push(r);
      frameOfItem.set(r.id, node.id);
    }
    // A holder (thread or process) with many coroutines draws one summary row for them, until opened. Their slices' and
    // their own edges sit on the summary's header.
    {
      const byHolder = new Map<string, FNode[]>();
      for (const n of nodes) {
        if (n.kind !== "coroutine" || n.container === undefined || !frameById.has(n.container)) continue;
        const list = byHolder.get(n.container);
        if (list === undefined) byHolder.set(n.container, [n]);
        else list.push(n);
      }
      // The slice ids each coroutine frame carries at its header (see hiddenAt), so a coroutine folded into a summary hands them on.
      const hiddenBy = new Map<string, string[]>();
      for (const [k, v] of hiddenAt) {
        const l = hiddenBy.get(v);
        if (l === undefined) hiddenBy.set(v, [k]);
        else l.push(k);
      }
      const gone = new Set<FNode>();
      for (const [holderId, list] of byHolder) {
        if (list.length <= GROUP_MIN) continue;
        const isOpen = open.has(holderId);
        coGroups.set(holderId, { count: list.length, open: isOpen });
        if (isOpen) continue;
        const gid = `cogroup:${holderId}`;
        const g: FNode = {
          id: gid,
          kind: "coroutine",
          rt: { id: gid, kind: "coroutine", label: `${list.length} coroutines`, parent: holderId },
          container: holderId,
          children: [],
          slices: [],
          resources: [],
          h: 0, x: 0, y: 0, w: 0, visible: [], hidden: 0,
          openKey: holderId,
          groupCount: list.length,
        };
        frameById.set(gid, g);
        autoCollapsed.add(gid);
        for (const c of list) {
          for (const sl of c.slices) {
            g.slices.push(sl);
            frameOfItem.set(sl.id, gid);
          }
          for (const k of hiddenBy.get(c.id) ?? []) hiddenAt.set(k, gid);
          frameOfItem.set(c.id, gid);
          frameById.delete(c.id);
          gone.add(c);
        }
        nodes.push(g);
      }
      if (gone.size > 0) {
        const kept = nodes.filter((n) => !gone.has(n));
        nodes.length = 0;
        nodes.push(...kept);
      }
      for (const n of nodes) {
        if (n.kind === "unthreaded" && n.slices.length > GROUP_MIN && !open.has(n.id)) {
          autoCollapsed.add(n.id);
          n.openKey = n.id;
        }
      }
    }
    // Children: each frame's container lists it, threads and coroutines by id.
    const tops: FNode[] = [];
    for (const n of nodes) {
      const parent = n.container === undefined ? undefined : frameById.get(n.container);
      if (parent === undefined) {
        if (n.kind !== "unthreaded" && n.kind !== "process") continue; // a thread or coroutine with no drawn container is not drawn
        if (n.kind === "unthreaded" && n.slices.length === 0 && n.children.length === 0) continue; // nothing to show
        tops.push(n);
      } else parent.children.push(n);
    }
    const compLabel = (id: string): string => compById.get(id)?.label ?? id;
    for (const n of nodes) n.children.sort((a, b) => cmp(a.kind, b.kind) || cmp(a.id, b.id));
    for (const n of nodes) n.slices.sort((a, b) => colOf(a.component) - colOf(b.component) || cmp(compLabel(a.component), compLabel(b.component)) || cmp(a.id, b.id));
    tops.sort((a, b) => (a.kind === "unthreaded" ? 1 : 0) - (b.kind === "unthreaded" ? 1 : 0) || cmp(a.rt?.label ?? "", b.rt?.label ?? "") || cmp(a.id, b.id));

    // The band targets each top frame bundles its outside edges into, so the frame is tall enough for one port each.
    const topOfId = (id: string): FNode | undefined => {
      let cur = frameById.get(frameOfItem.get(id) ?? id);
      for (let guard = 0; cur?.container !== undefined && guard < 100; guard++) cur = frameById.get(cur.container);
      return cur !== undefined && (cur.kind === "process" || cur.kind === "unthreaded") ? cur : undefined;
    };
    for (const e of sys.edges) {
      const target = bandTargetOf(e);
      const top = target === undefined ? undefined : topOfId(e.from);
      if (target === undefined || top === undefined) continue;
      const set = portKeys.get(top.id) ?? new Set<string>();
      set.add(target);
      portKeys.set(top.id, set);
    }

    // Visible slices: all of a widened frame, else the first SLICE_LIMIT. A collapsed frame shows none.
    const visibleOf = (n: FNode): void => {
      const show = widened.has(n.id) ? n.slices.length : Math.min(n.slices.length, SLICE_LIMIT);
      n.visible = n.slices.slice(0, show);
      n.hidden = n.slices.length - show;
    };
    for (const n of nodes) visibleOf(n);

    const blockH = (n: FNode): number => {
      if (isCol(n.id) || n.visible.length === 0) return n.hidden > 0 && !isCol(n.id) ? CHIP_H + SLICE_GAP : 0;
      const perCol = new Map<number, number>();
      for (const s of n.visible) perCol.set(colOf(s.component), (perCol.get(colOf(s.component)) ?? 0) + 1);
      const rows = Math.max(...perCol.values());
      return rows * (SLICE_H + SLICE_GAP) - SLICE_GAP + (n.hidden > 0 ? CHIP_H + SLICE_GAP : 0);
    };
    const stripH = (n: FNode): number => (n.resources.length === 0 ? 24 : STRIP_TITLE_H + n.resources.length * (RES_H + RES_GAP) - RES_GAP);
    // Heights, bottom-up.
    const sizeOf = (n: FNode): number => {
      if (isCol(n.id)) return HDR_H;
      let content = 0;
      for (const c of n.children) content += sizeOf(c) + FRAME_GAP;
      if (n.children.length > 0) content -= FRAME_GAP;
      const block = blockH(n);
      const body = block + (block > 0 && n.children.length > 0 ? PAD : 0) + content;
      let h = HDR_H + PAD + body + PAD;
      // A frame with nothing to show (a thread or coroutine with no slices of its own) is its header alone, not an empty body.
      if (n.kind !== "process" && body === 0) h = HDR_H;
      if (n.kind === "process") h = Math.max(h, HDR_H + PAD + stripH(n) + PAD);
      // Room for one port per bundle on the right edge, below the strip's resources.
      const ports = portKeys.get(n.id)?.size ?? 0;
      if (ports > 0 && n.container === undefined) h = Math.max(h, HDR_H + PAD + (n.kind === "process" ? stripH(n) + 14 : 10) + ports * PORT_GAP + PAD);
      n.h = h;
      return h;
    };
    // Positions, top-down: a frame's slices are centred in its content; children stack below them.
    const place = (n: FNode, x: number, y: number, w: number): void => {
      n.x = x;
      n.y = y;
      n.w = w;
      frames.push({
        id: n.id,
        kind: n.kind,
        title: n.kind === "unthreaded" ? "Not on a thread" : n.rt?.label ?? n.id,
        sub: subOf(n),
        x,
        y,
        w,
        h: isCol(n.id) ? HDR_H : n.h,
        hdrH: HDR_H,
        collapsed: isCol(n.id),
        hidden: n.hidden,
        ...(n.openKey !== undefined ? { openKey: n.openKey } : {}),
        ...(coGroups.has(n.id) ? { coGroup: coGroups.get(n.id) } : {}),
        ...(n.container !== undefined ? { parent: n.container } : {}),
        ...(n.rt?.spawn !== undefined ? { spawn: { file: n.rt.spawn.file, line: n.rt.spawn.line, ...(n.rt.spawn.api !== undefined ? { api: n.rt.spawn.api } : {}), status: n.rt.spawn.status, ...(n.rt.spawn.fn !== undefined ? { fn: n.rt.spawn.fn } : {}) } } : {}),
        ...(n.rt?.coroutines !== undefined ? { coroutines: n.rt.coroutines } : {}),
        ...(n.rt?.kind === "thread" || n.rt?.kind === "program" ? { roots: [] } : {}),
      });
      if (isCol(n.id)) return;
      const isProc = n.kind === "process";
      const contentLeft = x + PAD;
      const cw = w - 2 * PAD - (isProc ? STRIP_W + STRIP_GAP : 0);
      const colStart = contentLeft + (cw - innerW) / 2;
      let cursor = y + HDR_H + PAD;
      const rowsByCol = new Map<number, number>();
      for (const s of n.visible) {
        const c = colOf(s.component);
        const row = rowsByCol.get(c) ?? 0;
        rowsByCol.set(c, row + 1);
        const bx = colStart + c * (CARD_W + COL_GAP);
        const by = cursor + row * (SLICE_H + SLICE_GAP);
        boxes.push(sliceBox(s, bx, by, n.id));
      }
      const block = blockH(n);
      if (n.hidden > 0) {
        const more = cursor + block - CHIP_H;
        boxes.push({ id: `more:${n.id}`, kind: "more", column: 0, x: contentLeft, y: more, w: Math.min(cw, 220), h: CHIP_H, title: `+${n.hidden} more`, sub: "", chips: [], frame: n.id });
      }
      cursor += block + (block > 0 && n.children.length > 0 ? PAD : 0);
      if (isProc) {
        const stripX = x + w - PAD - STRIP_W;
        const stripY = y + HDR_H + PAD;
        const stripHeight = n.h - HDR_H - 2 * PAD;
        strips.push({ id: `strip:${n.id}`, program: n.id, title: "In process", x: stripX, y: stripY, w: STRIP_W, h: stripHeight });
        n.portTop = stripY + stripH(n) + 14;
        n.resources.forEach((r, i) => boxes.push(resourceBox(r, stripX + 8, stripY + STRIP_TITLE_H + i * (RES_H + RES_GAP), STRIP_W - 16, n.id)));
      }
      const childW = w - 2 * PAD - (isProc ? STRIP_W + STRIP_GAP : 0);
      for (const c of n.children) {
        place(c, x + PAD, cursor, childW);
        cursor += c.h + FRAME_GAP;
      }
    };
    const subOf = (n: FNode): string => {
      if (n.groupCount !== undefined) return `${plural(n.slices.length, "own slice")} · open to see them`;
      if (n.kind === "process") return n.rt?.spawn !== undefined ? spawnSub(n.rt) : plural(n.slices.length, "slice");
      if (n.kind === "unthreaded") return plural(n.slices.length, "slice");
      if (n.kind === "coroutine") {
        const sharedNote = n.shared !== undefined ? `also runs ${plural(n.shared, "component")} of ${n.sharedWith ?? "its thread"}` : "";
        const startsIn = n.slices.length === 0 && n.shared !== undefined ? n.startsIn : undefined;
        return ["coroutine", startsIn !== undefined ? `starts in ${shortLabel(startsIn, 26)}` : "", n.slices.length > 0 ? `${plural(n.slices.length, "own slice")}` : "", sharedNote].filter(Boolean).join(" · ");
      }
      if (n.slices.length === 0 && n.children.length === 0) return "runs no component of this scope";
      return n.rt?.coroutines !== undefined ? `${plural(n.rt.coroutines, "coroutine")} · ${plural(n.slices.length, "slice")}` : plural(n.slices.length, "slice");
    };
    // Process frames sit in a grid of 1-4 columns, the one that fits a 1280 x 750 viewport best; the unthreaded frame comes last.
    const order = [...tops.filter((n) => n.kind !== "unthreaded"), ...tops.filter((n) => n.kind === "unthreaded")];
    for (const n of order) {
      sizeOf(n);
      n.w = procW;
    }
    const COL_GAP_P = 70;
    const vp = opts.viewport ?? { w: 1280, h: 750 };
    const assign = (g: number): { cols: number[]; ys: number[] } => {
      const ys = new Array<number>(g).fill(TOP);
      const cols = order.map((n) => {
        let c = 0;
        for (let i = 1; i < g; i++) if ((ys[i] as number) < (ys[c] as number)) c = i;
        ys[c] = (ys[c] as number) + n.h + 2 * FRAME_GAP;
        return c;
      });
      return { cols, ys };
    };
    let g = 1;
    if (order.length >= 4) {
      let best = 0;
      for (let k = 1; k <= Math.min(4, order.length); k++) {
        const { ys } = assign(k);
        const w = MARGIN + k * procW + (k - 1) * COL_GAP_P + 3 * GAP_X + BAND_MIN_W + OUT_W + MARGIN;
        const score = Math.min(vp.w / w, vp.h / (Math.max(...ys) - FRAME_GAP));
        if (score > best * 1.03) {
          best = score;
          g = k;
        }
      }
    }
    const { cols, ys } = assign(g);
    const colTop = new Array<number>(g).fill(TOP);
    order.forEach((n, i) => {
      const c = cols[i] as number;
      place(n, MARGIN + c * (procW + COL_GAP_P), colTop[c] as number, procW);
      colTop[c] = (colTop[c] as number) + n.h + 2 * FRAME_GAP;
    });
    gridRight = MARGIN + g * procW + (g - 1) * COL_GAP_P;
    const y = Math.max(...ys);
    H = Math.max(y, TOP) - FRAME_GAP;
    // Programless resources (no process owns them) share one strip below the processes.
    const orphan = resources.filter((r) => r.kind !== "os" && !frameOfItem.has(r.id));
    if (orphan.length > 0) {
      const stripY = y;
      const h = STRIP_TITLE_H + orphan.length * (RES_H + RES_GAP) + PAD;
      const x = MARGIN;
      strips.push({ id: "strip:orphan", title: "In process (no program)", x, y: stripY, w: STRIP_W, h });
      orphan.forEach((r, i) => {
        boxes.push(resourceBox(r, x + 8, stripY + STRIP_TITLE_H + i * (RES_H + RES_GAP), STRIP_W - 16, "strip:orphan"));
        frameOfItem.set(r.id, "strip:orphan");
      });
      H = Math.max(H, stripY + h - FRAME_GAP);
    }
  }

  // Flat (none, truncated, or no frames): the components as cards in their columns, and one strip with the scope's resources.
  let colsRight = MARGIN;
  if (!grounded && sys.components.length === 0) return { focusY: 0, width: 0, height: 0, columns: [], groups: [], boxes: [], arrows: [] };
  if (!grounded) {
    const comps = [...sys.components].sort((a, b) => cmp(a.label, b.label) || cmp(a.id, b.id));
    for (const comp of comps) {
      if (!used.has(comp.id)) continue;
      const col = colOf(comp.id);
      const routes = routesBy.get(comp.id) ?? [];
      const chips = routes.slice(0, MAX_CHIPS).map((r) => shortLabel(routeText(r), 30));
      if (routes.length > MAX_CHIPS) chips.push(`+${routes.length - MAX_CHIPS} more`);
      const y = TOP + stackOffset(comps, col, comp.id, colOf, used, routesBy, MAX_CHIPS);
      boxes.push({
        id: comp.id,
        kind: "component",
        column: col,
        x: MARGIN + col * (CARD_W + COL_GAP),
        y,
        w: CARD_W,
        h: COMP_H + chips.length * CHIP_ROW,
        title: shortLabel(comp.label, 24),
        sub: `${plural(comp.files, "file")} · ${plural(comp.functions, "function")}`,
        chips,
        component: comp,
      });
    }
    colsRight = MARGIN + C * CARD_W + (C - 1) * COL_GAP;
    const colsBottom = Math.max(TOP, ...boxes.map((b) => b.y + b.h));
    const flatRes = resources.filter((r) => r.kind !== "os");
    const stripX = colsRight + STRIP_GAP;
    const stripH = Math.max(colsBottom - TOP, STRIP_TITLE_H + flatRes.length * (RES_H + RES_GAP) + PAD, 120);
    strips.push({ id: "strip:flat", title: "In process (no entry found)", x: stripX, y: TOP, w: STRIP_W, h: stripH });
    flatRes.forEach((r, i) => {
      boxes.push(resourceBox(r, stripX + 8, TOP + STRIP_TITLE_H + i * (RES_H + RES_GAP), STRIP_W - 16, "strip:flat"));
      frameOfItem.set(r.id, "strip:flat");
    });
    colsRight = stripX + STRIP_W;
    H = Math.max(H, TOP + stripH - FRAME_GAP, colsBottom);
  }

  // The kernel band: full height, after the strips. Its width comes from its labels, so no op name or chip label is cut. Its
  // kernel-op boxes are stacked at the top; the chips follow them, each at the height of the outside system it leads to.
  const procRight = grounded ? gridRight : colsRight;
  const bandX = procRight + GAP_X;
  const osRes = resources.filter((r) => r.kind === "os");
  const chipLabels = new Set<string>();
  for (const e of sys.edges) if (extShown.has(e.to)) chipLabels.add(chipLabelOf(e));
  let need = BAND_MIN_W - 20;
  for (const l of chipLabels) need = Math.max(need, 28 + l.length * CODE_CH);
  for (const r of osRes) need = Math.max(need, 16 + r.label.length * NAME_CH + 36, 50 + ((r.names ?? [])[0]?.length ?? 0) * SUB_CH);
  const bandW = Math.min(BAND_MAX_W, Math.ceil(need + 20));
  osRes.forEach((r, i) => boxes.push(resourceBox(r, bandX + 10, TOP + BAND_TITLE_H + i * (RES_H + RES_GAP), bandW - 20, "band")));
  const chipTop = TOP + BAND_TITLE_H + osRes.length * (RES_H + RES_GAP) + 14;

  // Outside column: externals by category, the config external dropped where an env resource draws the environment.
  const outX = bandX + bandW + GAP_X;
  const groups: SysGroup[] = [];
  let outBottom = TOP;
  if (ext.length > 0) {
    // What an outside box says under its name: the paths, hosts or commands it names, else how much code reaches it.
    const reach = new Map<string, { calls: number; from: Set<string> }>();
    for (const e of sys.edges) {
      if (!extShown.has(e.to)) continue;
      const r = reach.get(e.to) ?? { calls: 0, from: new Set<string>() };
      r.calls += e.count;
      r.from.add(e.from);
      reach.set(e.to, r);
    }
    const subOfExternal = (e: SystemExternal): string => {
      const named = externalSub(e);
      if (named !== "") return named;
      const r = reach.get(e.id);
      return r === undefined ? "" : `${plural(r.calls, "call")} from ${plural(r.from.size, "slice")}`;
    };
    let y = TOP;
    for (const category of CATEGORY_ORDER) {
      const list = ext.filter((e) => e.category === category);
      if (list.length === 0) continue;
      groups.push({ category, title: CATEGORY_TITLES[category], x: outX, y: y + 18 });
      y += GROUP_H;
      for (const e of list) {
        boxes.push({ id: e.id, kind: "external", column: 0, x: outX, y, w: OUT_W, h: OUT_H, title: shortLabel(e.label, 19), sub: shortLabel(subOfExternal(e), 30), chips: [], category, external: e });
        y += OUT_H + OUT_GAP;
      }
      y += 6;
    }
    outBottom = y - OUT_GAP;
  }
  const envRes = resources.find((r) => r.kind === "env");
  // Boxes and frames are all placed by now (the chips come later): look ends up by id, the first of each id winning.
  const boxById = new Map<string, SysBox>();
  for (const b of boxes) if (!boxById.has(b.id)) boxById.set(b.id, b);
  const frameObj = new Map<string, SysFrame>();
  for (const f of frames) if (!frameObj.has(f.id)) frameObj.set(f.id, f);
  const endpoint = (id: string): SysBox | SysFrame | undefined => boxById.get(id) ?? frameObj.get(id);
  // A hidden item (under a collapsed frame) is drawn at the header of its outermost collapsed frame.
  const headerOf = (frameId: string | undefined): SysFrame | undefined => {
    let outer: string | undefined;
    let cur = frameId;
    for (let guard = 0; cur !== undefined && guard < 100; guard++) {
      if (isCol(cur)) outer = cur;
      cur = frameById.get(cur)?.container;
    }
    return outer === undefined ? undefined : frameObj.get(outer);
  };
  const resolve = (id: string): SysBox | SysFrame | undefined => {
    const direct = endpoint(id);
    if (direct !== undefined) return direct;
    const fr = frameOfItem.get(id) ?? (frameById.has(id) ? id : undefined);
    const collapsedHeader = headerOf(fr);
    if (collapsedHeader !== undefined) return collapsedHeader;
    // A slice a coroutine shares with its thread is drawn at the coroutine's header.
    const holder = hiddenAt.get(id);
    return holder === undefined ? undefined : frameObj.get(holder);
  };

  interface Pending {
    edge: SystemEdge;
    from: SysBox | SysFrame;
    to: SysBox | SysFrame;
    toId: string;
  }
  const pending: Pending[] = [];
  for (const e of sys.edges) {
    const from = resolve(e.from);
    let toEdgeId = e.to;
    if (!grounded && e.to === "env" && envRes !== undefined) toEdgeId = envRes.id;
    const to = resolve(toEdgeId);
    if (from === undefined || to === undefined || from === to) continue;
    pending.push({ edge: e, from, to, toId: toEdgeId });
  }
  const outside = (b: SysBox | SysFrame): boolean => !("hdrH" in b) && b.kind === "external";
  const isOs = (b: SysBox | SysFrame): b is SysBox => !("hdrH" in b) && b.kind === "os";
  // The chip of each label, and the outside boxes it leads to.
  const chipRows: Array<{ p: Pending; chipId: string }> = [];
  const chipTargets = new Map<string, Set<string>>();
  const direct: Pending[] = [];
  for (const p of pending) {
    if (outside(p.to) && !outside(p.from)) {
      const chipId = `chip:${chipLabelOf(p.edge)}`;
      chipRows.push({ p, chipId });
      chipTargets.set(chipId, (chipTargets.get(chipId) ?? new Set()).add(p.to.id));
    } else direct.push(p);
  }
  // Chip positions: each chip at the height of the outside boxes it leads to, pushed down until it clears the one above.
  const extY = new Map(boxes.filter((b) => b.kind === "external").map((b) => [b.id, b.y + b.h / 2] as const));
  const chipList = [...chipTargets.entries()].map(([id, targets]) => {
    const ys = [...targets].map((t) => extY.get(t) ?? TOP);
    return { id, label: id.slice("chip:".length), target: ys.reduce((a, b) => a + b, 0) / ys.length };
  });
  chipList.sort((a, b) => a.target - b.target || cmp(a.id, b.id));
  const chipBox = new Map<string, SysBox>();
  let prevBottom = chipTop - CHIP_GAP;
  for (const c of chipList) {
    const y = Math.max(c.target - CHIP_H / 2, prevBottom + CHIP_GAP);
    const box: SysBox = { id: c.id, kind: "chip", column: 0, x: bandX + 10, y, w: bandW - 20, h: CHIP_H, title: c.label, sub: "", chips: [], chipLabel: c.label };
    boxes.push(box);
    chipBox.set(c.id, box);
    prevBottom = y + CHIP_H;
  }

  const bandBottom = Math.max(H, outBottom, ...boxes.map((b) => b.y + b.h), prevBottom) + MARGIN;
  const bandContent = Math.max(prevBottom, ...boxes.filter((b) => b.frame === "band").map((b) => b.y + b.h));
  const band: SysBand = { x: bandX, y: 0, w: bandW, h: Math.min(bandBottom, bandContent + 24) };
  const outRight = ext.length > 0 ? outX + OUT_W : bandX + bandW;
  const width = outRight + MARGIN;
  const height = bandBottom;

  // Arrows. Direct edges run between their ends. An edge from a frame to the band goes slice -> port on its process frame's
  // right edge (a short faint segment, one per edge), then one trunk per (process, band item) from the port to the chip or
  // kernel-op box; each chip runs on to its outside boxes once.
  const arrows: SysArrow[] = [];
  const trunks: SysTrunk[] = [];
  const sideOf = (a: SysBox | SysFrame, b: SysBox | SysFrame): "fwd" | "back" | "loop" => (b.x >= a.x + a.w ? "fwd" : b.x + b.w <= a.x ? "back" : "loop");
  const portKey = (n: SysBox | SysFrame, side: "l" | "r"): string => `${n.id}|${side}`;
  // Ports per node side, sorted by the other end, spread evenly along the side.
  const sidePorts = new Map<string, Array<{ idx: number; other: number }>>();
  const planned: Array<{ idx: number; from: SysBox | SysFrame; to: SysBox | SysFrame; edge: SystemEdge; band?: "in" | "out"; toNode: string; fromNode: string; text: string; sides: [("l" | "r"), ("l" | "r")] }> = [];
  const addPlanned = (idx: number, from: SysBox | SysFrame, to: SysBox | SysFrame, edge: SystemEdge, band: "in" | "out" | undefined, text: string) => {
    const mode = sideOf(from, to);
    const sa: "l" | "r" = mode === "back" ? "l" : "r";
    const sb: "l" | "r" = mode === "fwd" ? "l" : "r";
    planned.push({ idx, from, to, edge, ...(band !== undefined ? { band } : {}), toNode: to.id, fromNode: from.id, text, sides: [sa, sb] });
    const ka = portKey(from, sa);
    const kb = portKey(to, sb);
    const pa = sidePorts.get(ka);
    if (pa === undefined) sidePorts.set(ka, [{ idx: planned.length - 1, other: centreY(to) }]);
    else pa.push({ idx: planned.length - 1, other: centreY(to) });
    const pb = sidePorts.get(kb);
    if (pb === undefined) sidePorts.set(kb, [{ idx: planned.length - 1, other: centreY(from) }]);
    else pb.push({ idx: planned.length - 1, other: centreY(from) });
  };
  // The top-level frame (process or unthreaded) an end sits in, when it sits in one.
  const topFrameOf = (n: SysBox | SysFrame): SysFrame | undefined => {
    if (!grounded) return undefined;
    let cur: FNode | undefined = frameById.get("hdrH" in n ? n.id : (n.frame ?? ""));
    for (let guard = 0; cur?.container !== undefined && guard < 100; guard++) cur = frameById.get(cur.container);
    return cur === undefined ? undefined : frameObj.get(cur.id);
  };
  interface Bundled {
    top: SysFrame;
    target: SysBox;
    items: Pending[];
  }
  const bundles = new Map<string, Bundled>();
  const addBundled = (top: SysFrame, target: SysBox, p: Pending): void => {
    const key = `${top.id}>${target.id}`;
    const b = bundles.get(key) ?? { top, target, items: [] };
    b.items.push(p);
    bundles.set(key, b);
  };
  let idx = 0;
  const strayDirect: Pending[] = [];
  for (const p of direct) {
    const top = isOs(p.to) ? topFrameOf(p.from) : undefined;
    if (top !== undefined && isOs(p.to)) addBundled(top, p.to, p);
    else strayDirect.push(p);
  }
  for (const p of strayDirect) addPlanned(idx++, p.from, p.to, p.edge, undefined, pillText(p.edge));
  for (const row of chipRows) {
    const chip = chipBox.get(row.chipId) as SysBox;
    const top = topFrameOf(row.p.from);
    if (top !== undefined) addBundled(top, chip, row.p);
    else addPlanned(idx++, row.p.from, chip, row.p.edge, "in", pillText(row.p.edge));
  }
  // Chip -> external, once per pair, with no pill.
  const seenOut = new Set<string>();
  for (const row of chipRows) {
    const key = `${row.chipId}>${row.p.to.id}`;
    if (seenOut.has(key)) continue;
    seenOut.add(key);
    addPlanned(idx++, chipBox.get(row.chipId) as SysBox, row.p.to, row.p.edge, "out", "");
  }
  // Obstacles for routing: every card and every frame header, except the edge's own ends.
  // Built once and indexed on a grid: the boxes and frame headers do not move while edges are routed.
  const obstacles = new ObstacleGrid();
  for (const b of boxes) obstacles.add(b.id, { x: b.x, y: b.y, w: b.w, h: b.h });
  for (const f of frames) obstacles.add(f.id, { x: f.x, y: f.y, w: f.w, h: f.hdrH });
  const portAt = new Map<number, { x1: number; y1: number; x2: number; y2: number }>();
  // The slot of a port among those on its side, ordered by the other end: sorted once per side.
  const slotOf = new Map<string, Map<number, number>>();
  for (const [k, list] of sidePorts) {
    list.sort((p, q) => p.other - q.other || p.idx - q.idx);
    const m = new Map<number, number>();
    list.forEach((q, i) => {
      if (!m.has(q.idx)) m.set(q.idx, i);
    });
    slotOf.set(k, m);
  }
  const slot = (n: SysBox | SysFrame, side: "l" | "r", planIdx: number): number => slotOf.get(portKey(n, side))?.get(planIdx) ?? 0;
  for (const p of planned) {
    const a = p.from;
    const b = p.to;
    const sa = p.sides[0];
    const sb = p.sides[1];
    const ya = endY(a, slot(a, sa, p.idx), (sidePorts.get(portKey(a, sa)) ?? []).length);
    const yb = endY(b, slot(b, sb, p.idx), (sidePorts.get(portKey(b, sb)) ?? []).length);
    portAt.set(p.idx, { x1: sa === "r" ? a.x + a.w : a.x, y1: ya, x2: sb === "r" ? b.x + b.w : b.x, y2: yb });
  }
  for (const p of planned) {
    const pt = portAt.get(p.idx) as { x1: number; y1: number; x2: number; y2: number };
    const { x1, y1, x2, y2 } = pt;
    const dir = x2 >= x1 ? 1 : -1;
    const k = Math.max(40, Math.abs(x2 - x1) * 0.5);
    const same = p.sides[0] === p.sides[1];
    // Across a gap: the curve leaves and enters horizontally. Same side (a loop): it bulges out past that side.
    const c1x = same ? x1 + (p.sides[0] === "r" ? 1 : -1) * 44 : x1 + dir * k;
    const c2x = same ? x2 + (p.sides[1] === "r" ? 1 : -1) * 44 : x2 - dir * k;
    const segs = [x1, y1, c1x, y1, c2x, y2, x2, y2];
    let d = `M${num(x1)} ${num(y1)} C${num(c1x)} ${num(y1)} ${num(c2x)} ${num(y2)} ${num(x2)} ${num(y2)}`;
    let samples = bezierSamples(segs);
    // A curve that crosses a card or a frame header it does not end at is redrawn as an orthogonal route around them,
    // in the gutters, entering each end from its side. Headers are obstacles, so no edge runs through a frame's title band.
    if (samples.slice(1, -1).some((q) => obstacles.contains(q, p.fromNode, p.toNode))) {
      const pts = routeAround([x1, y1], [x2, y2], obstacles, p.fromNode, p.toNode);
      if (pts !== undefined) {
        d = `M${pts.map((q) => `${num(q[0])} ${num(q[1])}`).join(" L")}`;
        samples = polyline(pts);
      }
    }
    const edge = p.edge;
    const text = p.text;
    arrows.push({
      id: p.band === "out" ? `${p.fromNode}>${p.toNode}` : edge.id,
      edge,
      from: p.fromNode,
      to: p.toNode,
      d,
      samples,
      pill: { x: 0, y: 0, w: 0, h: PILL_H, text },
      dashed: edge.verb === "runs" || edge.verb === "spawns",
      inferred: isInferred(edge),
      ...(p.band !== undefined ? { band: p.band } : {}),
    });
  }

  // Bundles: per process, ports run down its right edge in the order of their targets (so trunks do not cross), each as near
  // its sources as the spacing allows.
  const byTop = new Map<string, Bundled[]>();
  for (const b of bundles.values()) byTop.set(b.top.id, [...(byTop.get(b.top.id) ?? []), b]);
  for (const [topId, list] of byTop) {
    list.sort((a, b) => centreY(a.target) - centreY(b.target) || cmp(a.target.id, b.target.id));
    const top = list[0]?.top as SysFrame;
    const node = frameById.get(topId) as FNode;
    const y0 = top.collapsed ? top.y + HDR_H / 2 : (node.portTop ?? top.y + HDR_H + 10);
    const y1 = top.collapsed ? y0 : Math.max(y0, top.y + top.h - 10);
    const want = list.map((b) => {
      const ys = b.items.map((p) => centreY(p.from));
      return Math.min(y1, Math.max(y0, ys.reduce((a, c) => a + c, 0) / ys.length));
    });
    const gap = top.collapsed ? 0 : PORT_GAP;
    const at = want.slice();
    for (let i = 1; i < at.length; i++) at[i] = Math.max(at[i] as number, (at[i - 1] as number) + gap);
    for (let i = at.length - 1; i >= 0; i--) {
      const limit = i === at.length - 1 ? y1 : (at[i + 1] as number) - gap;
      at[i] = Math.min(at[i] as number, limit);
    }
    for (let i = 0; i < at.length; i++) at[i] = Math.max(at[i] as number, y0 + gap * i);
    list.forEach((b, i) => {
      const port = { x: top.x + top.w, y: at[i] as number };
      const target = b.target;
      const tx = target.x;
      const ty = target.y + target.h / 2;
      const kk = Math.max(40, (tx - port.x) * 0.5);
      const trunkSamples = bezierSamples([port.x, port.y, port.x + kk, port.y, tx - kk, ty, tx, ty]);
      const arrowIds: string[] = [];
      for (const p of b.items) {
        const from = p.from;
        const sx = "hdrH" in from ? from.x + from.w : from.x + from.w;
        const sy = "hdrH" in from ? from.y + HDR_H / 2 : from.y + from.h / 2;
        const edge = p.edge;
        let inner: Array<[number, number]> = [[sx, sy], [port.x, port.y]];
        if (from.id === top.id) inner = [[port.x, port.y], [port.x, port.y]];
        else {
          const routed = routeAround([sx, sy], [port.x, port.y], obstacles, from.id, target.id);
          inner = routed ?? [[sx, sy], [sx + 20, sy], [sx + 20, port.y], [port.x, port.y]];
        }
        arrows.push({
          id: edge.id,
          edge,
          from: from.id,
          to: target.id,
          d: `M${inner.map((q) => `${num(q[0])} ${num(q[1])}`).join(" L")}`,
          samples: [...polyline(inner), ...trunkSamples],
          pill: { x: 0, y: 0, w: 0, h: PILL_H, text: pillText(edge) },
          dashed: edge.verb === "runs" || edge.verb === "spawns",
          inferred: isInferred(edge),
          bundled: true,
          noPill: true,
          ...(isOs(target) ? {} : { band: "in" as const }),
        });
        arrowIds.push(edge.id);
      }
      const verb = b.items.some((p) => p.edge.verb === "writes") ? "writes" : (b.items[0] as Pending).edge.verb;
      trunks.push({
        id: `trunk:${top.id}>${target.id}`,
        process: top.id,
        to: target.id,
        port,
        d: `M${num(port.x)} ${num(port.y)} C${num(port.x + kk)} ${num(port.y)} ${num(tx - kk)} ${num(ty)} ${num(tx)} ${num(ty)}`,
        samples: trunkSamples,
        edges: arrowIds,
        count: b.items.length,
        verb,
        pill: { x: 0, y: 0, w: 0, h: PILL_H, text: b.items.length > 1 ? `×${b.items.length}` : "" },
      });
    });
  }

  // Pills: on the curve, slid along it and nudged off every card, header, chip and other pill. A trunk's pill is its count.
  const taken = new RectGrid();
  for (const b of boxes) taken.add({ x: b.x - 4, y: b.y - 4, w: b.w + 8, h: b.h + 8 });
  for (const f of frames) taken.add({ x: f.x, y: f.y, w: f.w, h: HDR_H });
  const topFrames = frames.filter((f) => f.parent === undefined);
  const placePill = (samples: Array<{ x: number; y: number }>, text: string, order: number[], mustShow = true, constrain = false): { x: number; y: number; w: number; h: number; text: string } => {
    const w = Math.round(text.length * 8.2 + 20);
    const at = arcAt(samples);
    let chosen: { x: number; y: number } | undefined;
    // A pill that must sit in a frame stays within a pill's height of its line; a free one may slide further.
    const NUDGES = constrain ? [0, 14, -14, 26, -26] : [0, 26, -26, 52, -52, 78, -78, 104, -104, 130, -130, 156, -156];
    for (const t of order) {
      for (const off of NUDGES) {
        const c = at(t);
        const r = { x: c.x - w / 2, y: c.y + off - PILL_H / 2, w, h: PILL_H };
        const homed = !constrain || frames.length === 0 || topFrames.some((f) => c.x > f.x && c.x < f.x + f.w && c.y + off > f.y && c.y + off < f.y + f.h) || c.x >= band.x;
        if (homed && !taken.overlapsAny(r)) {
          chosen = { x: c.x, y: c.y + off };
          break;
        }
      }
      if (chosen !== undefined) break;
    }
    // No free spot near the edge: a crowded edge shows no pill (its count stays in the panel) rather than one on a card.
    if (chosen === undefined && !mustShow) return { x: 0, y: 0, w: 0, h: PILL_H, text: "" };
    const c = chosen ?? at(order[0] ?? 0.5);
    taken.add({ x: c.x - w / 2, y: c.y - PILL_H / 2, w, h: PILL_H });
    return { x: c.x, y: c.y, w, h: PILL_H, text };
  };
  for (const a of arrows) {
    if (a.pill.text === "" || a.noPill) continue;
    a.pill = placePill(a.samples, a.pill.text, [0.5, 0.42, 0.58, 0.34, 0.66, 0.26, 0.74], frames.length === 0, frames.length > 0);
  }
  for (const t of trunks) {
    if (t.pill.text === "") continue;
    t.pill = placePill(t.samples, t.pill.text, [0.3, 0.22, 0.38, 0.5, 0.62]);
  }
  if (arrows.length === 0 && boxes.length === 0 && frames.length === 0) return { focusY: 0, width: 0, height: 0, columns: [], groups: [], boxes: [], arrows: [] };
  const first = boxes.filter((b) => b.column === 0 && b.kind !== "external");
  const focusY = first.length === 0 ? height / 2 : first.reduce((s, b) => s + b.y + b.h / 2, 0) / first.length;
  return {
    focusY,
    width: width + MARGIN,
    height,
    columns: ext.length > 0 ? [{ index: 0, title: "Outside", x: outX, w: OUT_W }] : [],
    groups,
    boxes,
    arrows,
    frames,
    strips,
    band,
    ...(trunks.length > 0 ? { trunks } : {}),
  };

  function externalSub(e: { names?: string[]; host?: string; command?: string }): string {
    if (e.names !== undefined && e.names.length > 0) {
      const first = e.names.slice(0, 3).join(", ");
      return e.names.length > 3 ? `${first} +${e.names.length - 3}` : first;
    }
    return e.host ?? e.command ?? "";
  }
  function spawnSub(rt: SystemRuntime): string {
    const s = rt.spawn;
    if (s === undefined) return "";
    return [s.api ?? "spawn", s.status].join(" · ");
  }
}

function sliceBox(s: SystemSlice, x: number, y: number, frame: string): SysBox {
  const sub = `${s.functions} ${s.functions === 1 ? "fn" : "fns"}${s.root ? " · root" : ""}`;
  return {
    id: s.id,
    kind: "slice",
    column: 0,
    x,
    y,
    w: CARD_W,
    h: SLICE_H,
    title: shortLabel(s.component, 24),
    sub,
    chips: [],
    frame,
    slice: s,
    root: s.root,
    ...(s.awaits !== undefined ? { awaits: s.awaits } : {}),
  };
}

function resourceBox(r: SystemResource, x: number, y: number, w: number, frame: string): SysBox {
  const names = r.names ?? [];
  // A kernel-op box keeps its whole name (the band is sized from it) and lists as many targets as fit, then "+N".
  if (r.kind === "os") {
    const room = Math.max(1, Math.floor((w - 44) / SUB_CH));
    const shown: string[] = [];
    let used = 0;
    for (const n of names) {
      const next = used + (shown.length > 0 ? 2 : 0) + n.length;
      if (shown.length > 0 && next + (names.length - shown.length - 1 > 0 ? 4 : 0) > room) break;
      shown.push(n);
      used = next;
    }
    const more = names.length - shown.length;
    const sub = names.length === 0 ? r.kind : `${shown.join(", ")}${more > 0 ? ` +${more}` : ""}`;
    return { id: r.id, kind: "os", column: 0, x, y, w, h: RES_H, title: r.label, sub, chips: [], frame, resource: r, glyph: resourceGlyph(r.kind) };
  }
  const sub = names.length === 0 ? r.kind : `${names.slice(0, 2).join(", ")}${names.length > 2 ? ` +${names.length - 2}` : ""}`;
  // A narrow box (a process strip) keeps its title and subtitle short enough to clear the glyph.
  const narrow = w < 200;
  return { id: r.id, kind: "resource", column: 0, x, y, w, h: RES_H, title: shortLabel(r.label, narrow ? 12 : 24), sub: shortLabel(sub, narrow ? 15 : 26), chips: [], frame, resource: r, glyph: resourceGlyph(r.kind) };
}

/** The stacking offset of a flat card: the sum of the heights of the cards above it in its column. */
function stackOffset(comps: Array<{ id: string }>, col: number, id: string, colOf: (c: string) => number, used: Set<string>, routesBy: Map<string, SystemRoute[]>, maxChips: number): number {
  let y = 0;
  for (const c of comps) {
    if (!used.has(c.id) || colOf(c.id) !== col) continue;
    if (c.id === id) return y;
    const n = routesBy.get(c.id)?.length ?? 0;
    const chips = Math.min(n, maxChips) + (n > maxChips ? 1 : 0);
    y += COMP_H + chips * CHIP_ROW + 14;
  }
  return y;
}

const num = (n: number): string => String(Math.round(n * 10) / 10);

function centreY(n: SysBox | SysFrame): number {
  return "hdrH" in n ? n.y + HDR_H / 2 : n.y + n.h / 2;
}

function endY(n: SysBox | SysFrame, slot: number, count: number): number {
  if ("hdrH" in n) return n.y + HDR_H / 2;
  const h = n.h;
  if (count <= 1) return n.y + h / 2;
  const span = Math.min(h - 16, 12 * (count - 1));
  return n.y + h / 2 - span / 2 + (span * slot) / (count - 1);
}

interface Rect { x: number; y: number; w: number; h: number }

const GRID_CELL = 128;
const cellKey = (cx: number, cy: number): number => (cx + 32768) * 65536 + (cy + 32768);

/** Rectangles bucketed on a coarse grid, so a query looks only at the rectangles near it. */
class RectGrid {
  private readonly cells = new Map<number, Rect[]>();
  add(r: Rect): void {
    const x0 = Math.floor(r.x / GRID_CELL), x1 = Math.floor((r.x + r.w) / GRID_CELL);
    const y0 = Math.floor(r.y / GRID_CELL), y1 = Math.floor((r.y + r.h) / GRID_CELL);
    for (let cx = x0; cx <= x1; cx++) {
      for (let cy = y0; cy <= y1; cy++) {
        const k = cellKey(cx, cy);
        const l = this.cells.get(k);
        if (l === undefined) this.cells.set(k, [r]);
        else l.push(r);
      }
    }
  }
  /** True when `q` overlaps a rectangle of the grid (strictly: touching edges do not count). */
  overlapsAny(q: Rect): boolean {
    const x0 = Math.floor(q.x / GRID_CELL), x1 = Math.floor((q.x + q.w) / GRID_CELL);
    const y0 = Math.floor(q.y / GRID_CELL), y1 = Math.floor((q.y + q.h) / GRID_CELL);
    for (let cx = x0; cx <= x1; cx++) {
      for (let cy = y0; cy <= y1; cy++) {
        const l = this.cells.get(cellKey(cx, cy));
        if (l !== undefined && l.some((o) => overlaps(q, o))) return true;
      }
    }
    return false;
  }
}

/** The routing obstacles (cards and frame headers) keyed by the id of the box or frame, so an edge can skip its own ends. */
class ObstacleGrid {
  private readonly cells = new Map<number, Array<Rect & { id: string }>>();
  private readonly all: Array<Rect & { id: string }> = [];
  add(id: string, r: Rect): void {
    const o = { ...r, id };
    this.all.push(o);
    const x0 = Math.floor(r.x / GRID_CELL), x1 = Math.floor((r.x + r.w) / GRID_CELL);
    const y0 = Math.floor(r.y / GRID_CELL), y1 = Math.floor((r.y + r.h) / GRID_CELL);
    for (let cx = x0; cx <= x1; cx++) {
      for (let cy = y0; cy <= y1; cy++) {
        const k = cellKey(cx, cy);
        const l = this.cells.get(k);
        if (l === undefined) this.cells.set(k, [o]);
        else l.push(o);
      }
    }
  }
  /** True when the point is inside (or on the border of) an obstacle other than the two ends. */
  contains(q: { x: number; y: number }, a: string, b: string): boolean {
    const l = this.cells.get(cellKey(Math.floor(q.x / GRID_CELL), Math.floor(q.y / GRID_CELL)));
    return l !== undefined && l.some((r) => r.id !== a && r.id !== b && q.x >= r.x && q.x <= r.x + r.w && q.y >= r.y && q.y <= r.y + r.h);
  }
  /** The obstacles other than the two ends that reach into the window. */
  within(minX: number, maxX: number, minY: number, maxY: number, a: string, b: string): Rect[] {
    const seen = new Set<Rect & { id: string }>();
    const out: Rect[] = [];
    const x0 = Math.floor(minX / GRID_CELL), x1 = Math.floor(maxX / GRID_CELL);
    const y0 = Math.floor(minY / GRID_CELL), y1 = Math.floor(maxY / GRID_CELL);
    for (let cx = x0; cx <= x1; cx++) {
      for (let cy = y0; cy <= y1; cy++) {
        for (const r of this.cells.get(cellKey(cx, cy)) ?? []) {
          if (seen.has(r)) continue;
          seen.add(r);
          if (r.id !== a && r.id !== b && r.x < maxX && r.x + r.w > minX && r.y < maxY && r.y + r.h > minY) out.push(r);
        }
      }
    }
    return out;
  }
}

/**
 * Orthogonal route from a to b that keeps off every rectangle. Candidate lines sit ROUTE_GUTTER outside each
 * rectangle's edges, and a Dijkstra search over those lines charges a fixed cost per bend. Undefined when none exists.
 */
function routeAround(a: [number, number], b: [number, number], obs: ObstacleGrid, fromId: string, toId: string): Array<[number, number]> | undefined {
  const M = 80;
  const minX = Math.min(a[0], b[0]) - M, maxX = Math.max(a[0], b[0]) + M;
  const minY = Math.min(a[1], b[1]) - M, maxY = Math.max(a[1], b[1]) + M;
  const near = obs.within(minX, maxX, minY, maxY, fromId, toId);
  const xs = [...new Set([a[0], b[0], ...near.flatMap((r) => [r.x - ROUTE_GUTTER, r.x + r.w + ROUTE_GUTTER])])].sort((p, q) => p - q);
  const ys = [...new Set([a[1], b[1], ...near.flatMap((r) => [r.y - ROUTE_GUTTER, r.y + r.h + ROUTE_GUTTER])])].sort((p, q) => p - q);
  const nx = xs.length, ny = ys.length;
  const si = xs.indexOf(a[0]), sj = ys.indexOf(a[1]), ti = xs.indexOf(b[0]), tj = ys.indexOf(b[1]);
  if (si < 0 || sj < 0 || ti < 0 || tj < 0) return undefined;
  const DX = [1, -1, 0, 0], DY = [0, 0, 1, -1];
  // Which lattice segments pass through a rectangle's interior, marked once per rectangle (a segment hits a rectangle when it passes strictly through its interior).
  // blockedH[j * nx + i] is the segment (i, j) -> (i + 1, j); blockedV[j * nx + i] is (i, j) -> (i, j + 1).
  const blockedH = new Uint8Array(nx * ny), blockedV = new Uint8Array(nx * ny);
  const firstGt = (arr: number[], v: number): number => {
    let lo = 0, hi = arr.length;
    while (lo < hi) {
      const m = (lo + hi) >> 1;
      if ((arr[m] as number) > v) hi = m;
      else lo = m + 1;
    }
    return lo;
  };
  for (const r of near) {
    const right = r.x + r.w, bottom = r.y + r.h;
    const i0 = firstGt(xs, r.x), j0 = firstGt(ys, r.y);
    for (let j = j0; j < ny && (ys[j] as number) < bottom; j++) {
      for (let i = Math.max(0, i0 - 1); i < nx - 1 && (xs[i] as number) < right; i++) blockedH[j * nx + i] = 1;
    }
    for (let i = i0; i < nx && (xs[i] as number) < right; i++) {
      for (let j = Math.max(0, j0 - 1); j < ny - 1 && (ys[j] as number) < bottom; j++) blockedV[j * nx + i] = 1;
    }
  }
  const NONE = 4, STATES = nx * ny * 5;
  const key = (i: number, j: number, d: number): number => (j * nx + i) * 5 + d;
  const dist = new Float64Array(STATES).fill(Infinity);
  const prev = new Int32Array(STATES).fill(-1);
  // Binary heap of (cost, state), in two parallel arrays so no tuple is allocated per push.
  const hc: number[] = [];
  const hk: number[] = [];
  const push = (c: number, k: number): void => {
    let i = hc.length;
    hc.push(c);
    hk.push(k);
    while (i > 0) {
      const par = (i - 1) >> 1;
      if ((hc[par] as number) <= c) break;
      hc[i] = hc[par] as number;
      hk[i] = hk[par] as number;
      i = par;
    }
    hc[i] = c;
    hk[i] = k;
  };
  let popC = 0, popK = 0;
  const pop = (): boolean => {
    if (hc.length === 0) return false;
    popC = hc[0] as number;
    popK = hk[0] as number;
    const lc = hc.pop() as number;
    const lk = hk.pop() as number;
    const n = hc.length;
    if (n > 0) {
      let i = 0;
      for (;;) {
        const l = 2 * i + 1, r = l + 1;
        let m = i;
        let mc = lc;
        if (l < n && (hc[l] as number) < mc) { m = l; mc = hc[l] as number; }
        if (r < n && (hc[r] as number) < mc) { m = r; mc = hc[r] as number; }
        if (m === i) break;
        hc[i] = hc[m] as number;
        hk[i] = hk[m] as number;
        i = m;
      }
      hc[i] = lc;
      hk[i] = lk;
    }
    return true;
  };
  const start = key(si, sj, NONE);
  dist[start] = 0;
  push(0, start);
  let goal = -1;
  while (pop()) {
    const c = popC, k = popK;
    if (c > (dist[k] as number)) continue;
    const d = k % 5;
    const cell = (k - d) / 5;
    const i = cell % nx, j = Math.floor(cell / nx);
    if (i === ti && j === tj) { goal = k; break; }
    for (let nd = 0; nd < 4; nd++) {
      const ni = i + (DX[nd] as number), nj = j + (DY[nd] as number);
      if (ni < 0 || nj < 0 || ni >= nx || nj >= ny) continue;
      const x0 = xs[i] as number, y0 = ys[j] as number, x1 = xs[ni] as number, y1 = ys[nj] as number;
      if (nd === 0 ? blockedH[j * nx + i] : nd === 1 ? blockedH[j * nx + ni] : nd === 2 ? blockedV[j * nx + i] : blockedV[nj * nx + i]) continue;
      const turn = d !== NONE && d !== nd ? 80 : 0;
      const nc = c + Math.abs(x1 - x0) + Math.abs(y1 - y0) + turn;
      const nk = key(ni, nj, nd);
      if (nc < (dist[nk] as number)) {
        dist[nk] = nc;
        prev[nk] = k;
        push(nc, nk);
      }
    }
  }
  if (goal < 0) return undefined;
  const cells: Array<[number, number]> = [];
  for (let k = goal; k !== -1; k = prev[k] as number) {
    const cell = (k - (k % 5)) / 5;
    cells.push([xs[cell % nx] as number, ys[Math.floor(cell / nx)] as number]);
  }
  cells.reverse();
  // Drop repeated points and interior points on a straight run.
  const out: Array<[number, number]> = [];
  for (const q of cells) {
    const last = out[out.length - 1];
    if (last !== undefined && last[0] === q[0] && last[1] === q[1]) continue;
    out.push(q);
    if (out.length >= 3) {
      const u = out[out.length - 3] as [number, number], v = out[out.length - 2] as [number, number];
      if ((u[0] === v[0] && v[0] === q[0]) || (u[1] === v[1] && v[1] === q[1])) out.splice(out.length - 2, 1);
    }
  }
  return out;
}

/** Points along a polyline, eight per leg, for pill placement and the edge test. */
function polyline(pts: Array<[number, number]>): Array<{ x: number; y: number }> {
  const out: Array<{ x: number; y: number }> = [];
  for (let i = 0; i + 1 < pts.length; i++) {
    const [ax, ay] = pts[i] as [number, number];
    const [bx, by] = pts[i + 1] as [number, number];
    for (let j = 0; j < 8; j++) out.push({ x: ax + ((bx - ax) * j) / 8, y: ay + ((by - ay) * j) / 8 });
  }
  const last = pts[pts.length - 1] as [number, number];
  out.push({ x: last[0], y: last[1] });
  return out;
}
function bezierSamples(p: number[]): Array<{ x: number; y: number }> {
  const out: Array<{ x: number; y: number }> = [];
  for (let j = 0; j <= 24; j++) {
    const t = j / 24;
    const u = 1 - t;
    const a = u * u * u;
    const b = 3 * u * u * t;
    const c = 3 * u * t * t;
    const d = t * t * t;
    out.push({
      x: a * (p[0] as number) + b * (p[2] as number) + c * (p[4] as number) + d * (p[6] as number),
      y: a * (p[1] as number) + b * (p[3] as number) + c * (p[5] as number) + d * (p[7] as number),
    });
  }
  return out;
}

function arcAt(pts: Array<{ x: number; y: number }>): (t: number) => { x: number; y: number } {
  const cum = [0];
  for (let i = 1; i < pts.length; i++) {
    const p = pts[i] as { x: number; y: number };
    const q = pts[i - 1] as { x: number; y: number };
    cum.push((cum[i - 1] as number) + Math.hypot(p.x - q.x, p.y - q.y));
  }
  const total = cum[cum.length - 1] as number;
  return (t) => {
    const target = total * t;
    let i = 1;
    while (i < cum.length - 1 && (cum[i] as number) < target) i++;
    const span = (cum[i] as number) - (cum[i - 1] as number);
    const f = span === 0 ? 0 : (target - (cum[i - 1] as number)) / span;
    const p = pts[i - 1] as { x: number; y: number };
    const q = pts[i] as { x: number; y: number };
    return { x: p.x + (q.x - p.x) * f, y: p.y + (q.y - p.y) * f };
  };
}

function overlaps(a: { x: number; y: number; w: number; h: number }, b: { x: number; y: number; w: number; h: number }): boolean {
  return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
}
