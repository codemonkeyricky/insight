import { describe, expect, it } from "vitest";
import { lineClass, runtimeLine } from "../src/zoom/source.js";

describe("runtimeLine", () => {
  it("gives a program a process line, a thread a thread line and a coroutine a coroutine line", () => {
    expect(runtimeLine("program")).toBe("process");
    expect(runtimeLine("thread")).toBe("thread");
    expect(runtimeLine("coroutine")).toBe("coroutine");
  });

  it("gives a function the line of the container it sits in", () => {
    expect(runtimeLine("function", "thread")).toBe("thread");
    expect(runtimeLine("function", "coroutine")).toBe("coroutine");
    expect(runtimeLine("function")).toBe("none");
  });

  it("gives any other kind no runtime", () => {
    expect(runtimeLine("file", "process")).toBe("none");
    expect(runtimeLine("group")).toBe("none");
  });

  it("names the class of a line", () => {
    expect(lineClass("thread")).toBe("zm-line-thread");
    expect(lineClass("none")).toBe("zm-line-none");
  });
});
