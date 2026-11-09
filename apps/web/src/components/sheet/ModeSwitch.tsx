import type { ShellMode } from "./shell";

const MODES: readonly [ShellMode, string][] = [
  ["flow", "Flow"],
  ["arch", "Arch"],
  ["findings", "Findings"],
];

interface Props {
  /** The mode the page is in. None of the three when the page is a lens, Compare or Triage. */
  mode?: ShellMode;
  /** The link of each mode, so a mode keeps the scope it is reached from. */
  links: Record<ShellMode, string>;
  /** Findings in the project, shown as a red count on the Findings mode. */
  findings: number;
}

/** The segmented control for the three modes. Each mode is a link, so it works from the keyboard and in a new tab. */
export function ModeSwitch({ mode, links, findings }: Props) {
  return (
    <nav className="sh-modes" aria-label="Mode">
      {MODES.map(([m, label]) => (
        <a key={m} href={links[m]} className="sh-mode" aria-current={mode === m ? "page" : undefined}>
          {label}
          {m === "findings" && findings > 0 && (
            <span className="sh-count" aria-label={`${findings} findings`}>
              {findings}
            </span>
          )}
        </a>
      ))}
    </nav>
  );
}
