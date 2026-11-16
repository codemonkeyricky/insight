// The link and kind tag of a reference row, shared by the reverse lists and the caller chain. Kept apart from both so
// neither imports the other.
import { hrefFlow, hrefView } from "../../router";

/** The link of a reverse reference row or a caller row: a function opens in its scope, or its file's scope when outside it; a file opens its flow. */
export function refHref(
  id: string,
  scope: string,
  row: { id: string; file: string; isFunction: boolean; inScope: boolean },
  trace?: string,
): string {
  return row.isFunction
    ? hrefView(id, "flow", { scope: row.inScope ? scope : row.file, fn: row.id, ...(trace ? { trace } : {}) })
    : hrefFlow(id, row.file);
}

/** The kind tag of a reference: its kind, or "message" for a message dispatch. Call is the default and is not tagged. */
export function KindTag({ kind, how }: { kind: string; how?: string | undefined }) {
  if (kind === "call") return null;
  return (
    <>
      {" "}
      <span className={`kind ${kind}`}>{kind === "dispatch" && how === "message" ? "message" : kind}</span>
    </>
  );
}
