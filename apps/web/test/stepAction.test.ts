import { describe, expect, it } from "vitest";
import { stepAction, type StepContext } from "../src/zoom/stepAction";

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
  it("opens a side box for a thread or process step", () => {
    expect(stepAction(call, "open", ctx({ runtime: "thread" }))).toBe("side");
    expect(stepAction(call, "open", ctx({ runtime: "process" }))).toBe("side");
  });
  it("highlights a lambda, unless it is a handler", () => {
    expect(stepAction(call, "open", ctx({ isLambda: true }))).toBe("lambda");
    expect(stepAction({ shape: "step", handler: true }, "open", ctx({ isLambda: true }))).toBe("inline");
  });
  it("does nothing on a row with no callee", () => expect(stepAction(call, "open", ctx({ hasCallee: false }))).toBe("none"));
});
