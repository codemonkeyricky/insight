import { useState, type Ref } from "react";
import type { FileView } from "../../api";
import { targetPath, type CodeTarget } from "../../codeTarget";
import type { ZoomStore } from "../../zoom/scene";
import { FileViewer } from "../FileViewer";
import { FunctionSource } from "../zoom/FunctionSource";
import { FunctionRefs } from "../zoom/RefLists";
import { SidePanel } from "./SidePanel";

interface Props {
  id: string;
  roots: boolean;
  store: ZoomStore;
  /** What the pane shows. Undefined before anything was picked. */
  target: CodeTarget | undefined;
  /** Whether the pane is shown (the column on a desktop, the drawer on a phone). */
  open: boolean;
  /** A docked pane is the desktop column; otherwise it is the phone's bottom sheet. */
  docked: boolean;
  onClose: () => void;
  /** Where the flow map draws the exec panel of the focused function or container. Set once, when the slot mounts. */
  onSlot: Ref<HTMLDivElement>;
}

/**
 * The code pane, the right of the workspace on every tab. It shows the file (or the function) last clicked. The header row
 * names it: the file's path, or a function's name and location. For a function, the callers and callees are pinned above its
 * source. The exec slot sits above the code, where the flow map draws the focused function's or container's panel.
 */
export function CodePane({ id, roots, store, target, open, docked, onClose, onSlot }: Props) {
  const fn = target?.kind === "function" ? target : undefined;
  const path = target ? targetPath(target) : "";
  // A file's facts (language, line count) come from its loaded source; they show only once it has loaded for this path.
  const [facts, setFacts] = useState<FileView>();
  const loaded = facts !== undefined && facts.file === path ? facts : undefined;
  const head = fn ? (
    <>
      <strong className="mono">{fn.sel.selected.name}</strong>
      <span className="muted small mono sh-dock-path">
        {fn.sel.selected.file ? `${fn.sel.selected.file}:${fn.sel.selected.line}` : "No source for this function"}
      </span>
    </>
  ) : target?.kind === "file" ? (
    <>
      <strong className="mono sh-dock-path sh-dock-file">{path}</strong>
      {loaded && (
        <span className="muted small sh-dock-facts">{[loaded.language, `${loaded.totalLines} lines`].filter(Boolean).join(" · ")}</span>
      )}
    </>
  ) : (
    <span className="muted small">Code</span>
  );
  return (
    <SidePanel
      open={open}
      docked={docked}
      label="Code"
      onClose={onClose}
      head={head}
      pinned={fn ? <FunctionRefs id={id} sel={fn.sel} roots={roots} /> : undefined}
    >
      <div className="sh-slot" ref={onSlot} />
      {target === undefined && <p className="muted">Click a file or function to see its code.</p>}
      {target?.kind === "file" && (
        <FileViewer
          key={path}
          id={id}
          path={path}
          hideHead
          onLoad={setFacts}
          {...(target.line !== undefined ? { line: target.line } : {})}
        />
      )}
      {fn && <FunctionSource id={id} store={store} sel={fn.sel} />}
    </SidePanel>
  );
}
