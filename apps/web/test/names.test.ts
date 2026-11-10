import { describe, expect, it } from "vitest";
import { displayName } from "../src/zoom/names.js";

describe("displayName", () => {
  it("shows a named function by its name", () => {
    expect(displayName("planAssembly", "scripts/assemblyplancheck.ts#planAssembly")).toBe("planAssembly");
    expect(displayName("Counter.increment")).toBe("Counter.increment");
  });

  it("shows module-level code by its file's base name without the last extension", () => {
    expect(displayName("(module)", "src/main.tsx#(module)")).toBe("main");
    expect(displayName("slice.worker.ts", "src/verify/slice.worker.ts#(module)")).toBe("slice.worker");
    expect(displayName("assemblyplancheck.ts", "scripts/assemblyplancheck.ts#(module)")).toBe("assemblyplancheck");
  });

  it("shows a top-level chart name by its file, with no folder", () => {
    expect(displayName("assemblyplancheck.ts · top level")).toBe("assemblyplancheck");
    expect(displayName("src/main.tsx · top level")).toBe("main");
    expect(displayName("(module)", "src/main.tsx")).toBe("main");
  });

  it("shows a folded handler by its event", () => {
    expect(displayName("verify.worker.ts · on message")).toBe("on message");
    expect(displayName("verify.worker.ts · on message", "src/verify.worker.ts#λ16")).toBe("on message");
  });

  it("leaves a name that holds no file alone", () => {
    expect(displayName("(module)")).toBe("(module)");
    expect(displayName("start")).toBe("start");
  });
});
