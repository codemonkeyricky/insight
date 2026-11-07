import { mkdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  addAnnotation,
  checklist,
  clearDecision,
  deleteAnnotation,
  InputError,
  listAnnotations,
  NOTE_LIMIT,
  projectPaths,
  readAnnotations,
  readReview,
  setDecision,
  updateAnnotation,
} from "../src/index.js";

const here = dirname(fileURLToPath(import.meta.url));
const SCRATCH = join(here, "..", ".insight-test", `review-${process.pid}`);
const paths = projectPaths(join(SCRATCH, "project"));

beforeAll(() => {
  rmSync(SCRATCH, { recursive: true, force: true });
  mkdirSync(paths.state, { recursive: true });
});

afterAll(() => {
  rmSync(SCRATCH, { recursive: true, force: true });
});

const KEY = "lens-lock-order#cycle:accounts_mu|audit_mu";
const OTHER = "lens-complexity#complexity:f";

describe("review decisions", () => {
  it("refuses a dismissal without a note, and a blank note counts as none", () => {
    expect(() => setDecision(paths, KEY, "dismissed", undefined)).toThrow(InputError);
    expect(() => setDecision(paths, KEY, "dismissed", "   ")).toThrow(InputError);
    expect(readReview(paths).decisions).toEqual({});
  });

  it("refuses a bad key, a bad status and an over-long note", () => {
    expect(() => setDecision(paths, "", "accepted", "")).toThrow(InputError);
    expect(() => setDecision(paths, KEY, "maybe", "x")).toThrow(InputError);
    expect(() => setDecision(paths, KEY, "accepted", "x".repeat(NOTE_LIMIT + 1))).toThrow(InputError);
  });

  it("stores a dismissal with its note and an accept without one", () => {
    const at = new Date("2026-01-02T03:04:05.000Z");
    expect(setDecision(paths, KEY, "dismissed", " intentional lock order, guarded by a single caller ", at)).toEqual({
      status: "dismissed",
      note: "intentional lock order, guarded by a single caller",
      updatedAt: "2026-01-02T03:04:05.000Z",
    });
    setDecision(paths, OTHER, "accepted", "", at);
    expect(readReview(paths).decisions[OTHER]).toMatchObject({ status: "accepted", note: "" });
  });

  it("puts each finding in the checklist with its decision, and lists decisions whose finding is gone as stale", () => {
    const findings = [
      { key: KEY, lens: "lens-lock-order", id: "cycle:accounts_mu|audit_mu", severity: "error", message: "cycle" },
      { key: "lens-calls#unreachable:g", lens: "lens-calls", id: "unreachable:g", severity: "info", message: "g unreachable" },
    ];
    const { items, stale } = checklist(findings, readReview(paths));
    expect(items.map((i) => [i.key, i.status])).toEqual([
      [KEY, "dismissed"],
      ["lens-calls#unreachable:g", "open"],
    ]);
    expect(items[0]?.note).toMatch(/guarded/);
    expect(stale.map((s) => s.key)).toEqual([OTHER]);
  });

  it("reopens a finding when its decision is cleared", () => {
    clearDecision(paths, KEY);
    expect(readReview(paths).decisions[KEY]).toBeUndefined();
    clearDecision(paths, "never-there");
    const { items } = checklist([{ key: KEY, lens: "lens-lock-order", id: "cycle:accounts_mu|audit_mu", severity: "error", message: "cycle" }], readReview(paths));
    expect(items[0]?.status).toBe("open");
  });

  it("keeps the review file's schema and decisions after a fresh read", () => {
    expect(readReview(paths)).toMatchObject({ schema: 1, decisions: { [OTHER]: { status: "accepted" } } });
  });
});

describe("annotations", () => {
  let first: string;

  it("adds a note to a node, an edge or a finding and lists it back", () => {
    const a = addAnnotation(paths, { type: "node", key: "src/ledger.cc#transfer", text: "  holds two locks on purpose  " });
    first = a.id;
    expect(a).toMatchObject({ target: { type: "node", key: "src/ledger.cc#transfer" }, text: "holds two locks on purpose" });
    addAnnotation(paths, { type: "edge", key: "e:1", text: "unresolved in the build" });
    addAnnotation(paths, { type: "finding", key: KEY, text: "tracked in ticket 42" });
    expect(listAnnotations(paths).length).toBe(3);
    expect(listAnnotations(paths, { type: "finding" }).map((x) => x.target.key)).toEqual([KEY]);
    expect(listAnnotations(paths, { type: "node", key: "src/ledger.cc#transfer" }).map((x) => x.id)).toEqual([first]);
    expect(readAnnotations(paths).annotations.length).toBe(3);
  });

  it("refuses an unknown target type, a missing key and empty text", () => {
    expect(() => addAnnotation(paths, { type: "file", key: "a", text: "x" })).toThrow(InputError);
    expect(() => addAnnotation(paths, { type: "node", key: "", text: "x" })).toThrow(InputError);
    expect(() => addAnnotation(paths, { type: "node", key: "a", text: "  " })).toThrow(InputError);
  });

  it("updates text in place and keeps the id", () => {
    const updated = updateAnnotation(paths, first, "holds two locks on purpose, see review", new Date("2026-02-01T00:00:00.000Z"));
    expect(updated).toMatchObject({ id: first, text: "holds two locks on purpose, see review", updatedAt: "2026-02-01T00:00:00.000Z" });
    expect(updateAnnotation(paths, "missing-id", "x")).toBeUndefined();
  });

  it("deletes one annotation and reports a second delete as not found", () => {
    expect(deleteAnnotation(paths, first)).toBe(true);
    expect(deleteAnnotation(paths, first)).toBe(false);
    expect(listAnnotations(paths).some((x) => x.id === first)).toBe(false);
    expect(listAnnotations(paths).length).toBe(2);
  });
});
