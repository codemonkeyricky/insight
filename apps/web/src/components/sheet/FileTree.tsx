import type { FileEntry } from "../../api";
import { Explorer } from "../Explorer";

interface Props {
  id: string;
  tab: string;
  /** The tab a file opens in (the flow tab for a file), while folders stay on `tab`. */
  fileTab: string;
  scope: string;
  files: FileEntry[];
  /** Whether the pane shows. On a desktop it is the left column; on a phone it is the drawer over the page. */
  open: boolean;
  onClose: () => void;
}

/**
 * The source tree, the left pane of the workspace. On a desktop it is a column that stays put on every tab; on a phone the
 * same tree is a drawer from the left. Choosing a file or folder sets the scope, and a file also shows its code.
 */
export function FileTree({ id, tab, fileTab, scope, files, open, onClose }: Props) {
  return (
    <aside id="sh-files" className={`sh-tree sh-card${open ? " open" : ""}`} aria-label="Files" aria-hidden={!open} inert={!open}>
      <header className="sh-tree-head">
        <h2>Files</h2>
        <button type="button" className="sh-close" aria-label="Hide the files" onClick={onClose}>
          <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">
            <path d="M2 2l8 8M10 2l-8 8" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
          </svg>
        </button>
      </header>
      <div className="sh-tree-body">
        <Explorer id={id} tab={tab} fileTab={fileTab} scope={scope} files={files} />
      </div>
    </aside>
  );
}
