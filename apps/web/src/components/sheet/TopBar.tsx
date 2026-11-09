import { ThemeSwitch } from "../ThemeSwitch";

export interface Crumb {
  label: string;
  href: string;
  current: boolean;
}

interface Props {
  crumbs: Crumb[];
  filesOpen: boolean;
  codeOpen: boolean;
  onFiles: () => void;
  onCode: () => void;
  onFind: () => void;
}

/**
 * The one glass bar over the workspace: the app mark, the project and scope crumbs, then the pane toggles (Files and Code
 * show or hide their pane), Find and the theme.
 */
export function TopBar({ crumbs, filesOpen, codeOpen, onFiles, onCode, onFind }: Props) {
  return (
    <header className="sh-top">
      <a className="sh-mark" href="#/" aria-label="Insight, all projects">
        <svg width="24" height="24" viewBox="0 0 24 24" aria-hidden="true">
          <rect width="24" height="24" rx="6.5" fill="var(--accent)" />
          <rect x="5.5" y="5.5" width="13" height="13" rx="4" fill="none" stroke="var(--on-accent)" strokeWidth="1.6" strokeOpacity=".55" />
          <circle cx="12" cy="12" r="2.6" fill="var(--on-accent)" />
        </svg>
        <span className="sh-mark-name">Insight</span>
      </a>
      <nav className="sh-crumbs" aria-label="Project and scope">
        {crumbs.map((c, i) => (
          <span key={`${i}\0${c.href}`} className="sh-crumb">
            {i > 0 && <span className="sh-sep" aria-hidden="true">/</span>}
            <a href={c.href} aria-current={c.current ? "page" : undefined}>
              {c.label}
            </a>
          </span>
        ))}
      </nav>
      <div className="sh-spacer" />
      <div className="sh-tools">
        <button type="button" className="sh-tool" aria-expanded={filesOpen} aria-controls="sh-files" onClick={onFiles}>
          <svg width="15" height="15" viewBox="0 0 15 15" aria-hidden="true">
            <path d="M1.5 3.5h4l1.5 1.5h6.5v7.5h-12z" fill="none" stroke="currentColor" strokeWidth="1.3" />
          </svg>
          <span className="sh-lbl">Files</span>
        </button>
        <button type="button" className="sh-tool" aria-expanded={codeOpen} aria-controls="sh-code" onClick={onCode}>
          <svg width="15" height="15" viewBox="0 0 15 15" aria-hidden="true">
            <path d="M5 4L1.5 7.5 5 11M10 4l3.5 3.5L10 11" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" />
          </svg>
          <span className="sh-lbl">Code</span>
        </button>
        <button type="button" className="sh-tool" aria-keyshortcuts="Meta+K Control+K" onClick={onFind}>
          <svg width="15" height="15" viewBox="0 0 15 15" aria-hidden="true">
            <circle cx="6.5" cy="6.5" r="4.5" fill="none" stroke="currentColor" strokeWidth="1.4" />
            <path d="M10 10l3.5 3.5" stroke="currentColor" strokeWidth="1.4" />
          </svg>
          <span className="sh-lbl">Find</span>
          <kbd>⌘K</kbd>
        </button>
        <ThemeSwitch />
      </div>
    </header>
  );
}
