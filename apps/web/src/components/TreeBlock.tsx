import { hrefFile } from "../router";
import type { Span, TreeNode } from "../api";

const KIND_LABEL: Record<string, string> = {
  process: "process",
  thread: "thread",
  coroutine: "coroutine",
  module: "module",
  function: "function",
};

/** A lens tree: each node has a kind badge, an optional detail, and a link to its line. */
export function TreeBlock({ root, projectId, onShow }: { root: TreeNode; projectId: string; onShow: (span: Span, label: string) => void }) {
  return (
    <div className="tree" role="tree">
      <TreeItem node={root} depth={0} projectId={projectId} onShow={onShow} />
    </div>
  );
}

function TreeItem({ node, depth, projectId, onShow }: { node: TreeNode; depth: number; projectId: string; onShow: (span: Span, label: string) => void }) {
  const kids = node.children ?? [];
  const head = (
    <>
      {node.kind && <span className={`kind ${node.kind}`}>{KIND_LABEL[node.kind] ?? node.kind}</span>}
      <span className="tree-label">{node.label}</span>
      {node.detail && <span className="muted small tree-detail">{node.detail}</span>}
      {node.span && (
        <>
          {" "}
          <button type="button" className="link small" onClick={() => onShow(node.span as Span, node.label)}>
            {node.span.file}:{node.span.start[0] + 1}
          </button>{" "}
          <a className="small" href={hrefFile(projectId, node.span.file, node.span.start[0] + 1)}>
            open
          </a>
        </>
      )}
    </>
  );
  if (kids.length === 0) {
    return (
      <div className="tree-row leaf" role="treeitem">
        {head}
      </div>
    );
  }
  // Processes, threads and modules start open; function-level children can be many, so they start closed.
  const open = depth < 3;
  return (
    <details className="tree-branch" open={open} role="treeitem">
      <summary className="tree-row">
        {head} <span className="muted small">({kids.length})</span>
      </summary>
      <div className="tree-kids">
        {kids.map((c, i) => (
          <TreeItem key={`${c.label}-${i}`} node={c} depth={depth + 1} projectId={projectId} onShow={onShow} />
        ))}
      </div>
    </details>
  );
}
