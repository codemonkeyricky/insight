import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { api, type FileEntry } from "../../api";
import { hrefFlow, hrefView } from "../../router";
import { rankFuzzy } from "./fuzzy";

/** One thing Find can open: a page, a file, or a function. */
export interface FindItem {
  key: string;
  label: string;
  detail: string;
  href: string;
  kind: "page" | "file" | "function";
}

const KIND_LABEL: Record<FindItem["kind"], string> = { page: "Page", file: "File", function: "Function" };

/** The project's functions, fetched once per project for the Find palette. A failed fetch is retried the next time. */
const functionCache = new Map<string, Promise<FindItem[]>>();

function functionItems(id: string): Promise<FindItem[]> {
  let hit = functionCache.get(id);
  if (hit === undefined) {
    hit = api.getScopeExec(id, "").then((model) =>
      model.functions.map((f) => ({
        key: `fn:${f.id}`,
        label: f.name,
        detail: `${f.file}:${f.line}`,
        href: hrefView(id, "flow", { scope: f.file, fn: f.id }),
        kind: "function" as const,
      })),
    );
    functionCache.set(id, hit);
    hit.catch(() => functionCache.delete(id));
  }
  return hit;
}

function pageItems(id: string): FindItem[] {
  const page = (label: string, href: string): FindItem => ({ key: `page:${href}`, label, detail: "Page", href, kind: "page" });
  return [
    page("Overview", hrefView(id, "overview", { full: true })),
    page("Flow", hrefView(id, "flow")),
    page("Arch", hrefView(id, "arch")),
    page("Compare", hrefView(id, "compare")),
    page("Triage", hrefView(id, "review")),
  ];
}

interface Props {
  id: string;
  files: FileEntry[];
  onClose: () => void;
}

/**
 * The Find palette: one fuzzy box over the project's pages, files and functions. Enter opens the highlighted row, the arrow keys
 * move through the rows, and Escape closes it. Escape is prevented so the side panel does not also close.
 */
export function FindPalette({ id, files, onClose }: Props) {
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const [fns, setFns] = useState<FindItem[]>([]);
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => {
    input.current?.focus();
  }, []);

  useEffect(() => {
    let cancelled = false;
    functionItems(id).then(
      (rows) => {
        if (!cancelled) setFns(rows);
      },
      () => {
        // Functions are optional in Find: pages and files still work when the scope listing is unavailable.
      },
    );
    return () => {
      cancelled = true;
    };
  }, [id]);

  const items = useMemo<FindItem[]>(
    () => [
      ...pageItems(id),
      ...files.map((f) => ({
        key: `file:${f.path}`,
        label: f.path.slice(f.path.lastIndexOf("/") + 1),
        detail: f.path,
        href: hrefFlow(id, f.path),
        kind: "file" as const,
      })),
      ...fns,
    ],
    [id, files, fns],
  );
  const shown = useMemo(() => rankFuzzy(items, query, (it) => it.label, 50), [items, query]);

  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Escape") {
      e.preventDefault();
      onClose();
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      setActive((a) => Math.min(a + 1, Math.max(shown.length - 1, 0)));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((a) => Math.max(a - 1, 0));
    } else if (e.key === "Enter") {
      const row = shown[active];
      if (row) {
        e.preventDefault();
        window.location.hash = row.href;
        onClose();
      }
    }
  };

  return (
    <div className="sh-scrim" onMouseDown={onClose}>
      <div className="sh-card sh-palette" role="dialog" aria-modal="true" aria-label="Find" onMouseDown={(e) => e.stopPropagation()}>
        <input
          ref={input}
          className="sh-find-input"
          type="search"
          role="combobox"
          aria-expanded="true"
          aria-controls="sh-find-list"
          aria-activedescendant={shown[active] ? `sh-find-${active}` : undefined}
          aria-label="Find a function, file or page"
          placeholder="Find a function, file or page"
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setActive(0);
          }}
          onKeyDown={onKey}
          autoComplete="off"
          spellCheck={false}
        />
        <ul id="sh-find-list" role="listbox" className="sh-find-list">
          {shown.map((it, i) => (
            <li key={it.key} id={`sh-find-${i}`} role="option" aria-selected={i === active}>
              <a
                href={it.href}
                className={i === active ? "on" : undefined}
                onMouseEnter={() => setActive(i)}
                onClick={onClose}
              >
                <span className="sh-kind">{KIND_LABEL[it.kind]}</span>
                <span className="sh-find-label">{it.label}</span>
                <span className="sh-find-detail">{it.detail}</span>
              </a>
            </li>
          ))}
        </ul>
        {shown.length === 0 && <p className="sh-find-empty">Nothing matches “{query}”.</p>}
      </div>
    </div>
  );
}
