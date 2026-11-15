import { describe, expect, it } from "vitest";
import { stepAction, stepCallee, type StepContext } from "../src/zoom/stepAction";

const ctx = (c: Partial<StepContext> = {}): StepContext => ({ hasCallee: true, isLambda: false, runtime: "same", ...c });
const call = { shape: "step" as const };

describe("stepAction click", () => {
  it("selects every row, calls and nest headers included", () => {
    expect(stepAction(call, "click", ctx())).toBe("select");
    expect(stepAction({ shape: "nest" }, "click", ctx())).toBe("select");
    expect(stepAction(call, "click", ctx({ runtime: "thread" }))).toBe("select");
    expect(stepAction(call, "click", ctx({ isLambda: true }))).toBe("select");
    expect(stepAction(call, "click", ctx({ hasCallee: false }))).toBe("select");
  });
  it("does nothing on a row with nothing to select", () => {
    expect(stepAction(call, "click", ctx({ selectable: false }))).toBe("none");
  });
});

describe("stepAction open", () => {
  it("nests a same-thread call", () => expect(stepAction(call, "open", ctx())).toBe("inline"));
  it("folds a nest header", () => expect(stepAction({ shape: "nest" }, "open", ctx({ hasCallee: false }))).toBe("fold"));
  it("folds a fork row", () => expect(stepAction({ shape: "fork" }, "open", ctx({ runtime: "thread" }))).toBe("fold"));
  it("opens a parallel line for a thread or process step", () => {
    expect(stepAction(call, "open", ctx({ runtime: "thread" }))).toBe("fork");
    expect(stepAction(call, "open", ctx({ runtime: "process" }))).toBe("fork");
  });
  it("highlights a lambda, unless it is a handler", () => {
    expect(stepAction(call, "open", ctx({ isLambda: true }))).toBe("lambda");
    expect(stepAction({ shape: "step", handler: true }, "open", ctx({ isLambda: true }))).toBe("inline");
  });
  it("does nothing on a row with no callee", () => expect(stepAction(call, "open", ctx({ hasCallee: false }))).toBe("none"));
});

describe("stepCallee", () => {
  it("is the target of a call row, and nothing for a state row, a row with no target, or a call into its own function", () => {
    expect(stepCallee({ role: "call", target: "src/a.ts#b" }, "src/a.ts#a")).toBe("src/a.ts#b");
    expect(stepCallee({ role: "state", target: "src/a.ts#var:x" }, "src/a.ts#a")).toBeUndefined();
    expect(stepCallee({ role: "call" }, "src/a.ts#a")).toBeUndefined();
    expect(stepCallee({ role: "call", target: "src/a.ts#a" }, "src/a.ts#a")).toBeUndefined();
  });

  it("a state row opens nothing: no callee, so Enter does not take the lambda, inline or load path", () => {
    const row = { shape: "step" as const };
    const noCallee = ctx({ hasCallee: stepCallee({ role: "state", target: "src/b.ts#var:x" }, "src/a.ts#a") !== undefined, isLambda: false });
    expect(stepAction(row, "open", noCallee)).toBe("none");
    expect(stepAction(row, "click", noCallee)).toBe("select");
  });
});

