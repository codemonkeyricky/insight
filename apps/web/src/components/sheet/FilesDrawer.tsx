import type { FileEntry } from "../../api";
import { Explorer } from "../Explorer";

interface Props {
  id: string;
  tab: string;
  /** The tab a file opens in (the source panel), while folders stay on `tab`. */
  fileTab: string;
  scope: string;
  files: FileEntry[];
  onClose: () => void;
}

/** The source tree as a floating glass card from the left. It wraps the same Explorer the pages used to have on the left. */
export function FilesDrawer({ id, tab, fileTab, scope, files, onClose }: Props) {
  return (
    <aside id="sh-files" className="sh-card sh-files" aria-label="Files">
      <header className="sh-files-head">
        <h2>Files</h2>
        <button type="button" className="sh-close" aria-label="Close the files" onClick={onClose}>
          <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">
            <path d="M2 2l8 8M10 2l-8 8" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
          </svg>
        </button>
      </header>
      <div className="sh-files-body">
        <Explorer id={id} tab={tab} fileTab={fileTab} scope={scope} files={files} />
      </div>
    </aside>
  );
}
