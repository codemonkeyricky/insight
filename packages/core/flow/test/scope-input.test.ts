import { describe, expect, it } from "vitest";
import { normalizeScopeInput, ScopeInputError } from "../src/index.js";

describe("normalizeScopeInput", () => {
  it("canonicalizes separators, empty segments and dots, and keeps the project scope empty", () => {
    expect(normalizeScopeInput("")).toBe("");
    expect(normalizeScopeInput(".")).toBe("");
    expect(normalizeScopeInput("./")).toBe("");
    expect(normalizeScopeInput("apps//app/./src/")).toBe("apps/app/src");
    expect(normalizeScopeInput("apps\\app\\src")).toBe("apps/app/src");
    expect(normalizeScopeInput("apps/app/src/main.ts")).toBe("apps/app/src/main.ts");
  });

  it("refuses an absolute path instead of stripping its leading slash", () => {
    expect(() => normalizeScopeInput("/apps")).toThrow(ScopeInputError);
    expect(() => normalizeScopeInput("/apps")).toThrow(/must be relative to the project/);
    expect(() => normalizeScopeInput("\\apps")).toThrow(/must be relative to the project/);
  });

  it("refuses a path that leaves the project", () => {
    for (const scope of ["..", "../outside", "apps/../../outside", "apps/.."]) {
      expect(() => normalizeScopeInput(scope)).toThrow(ScopeInputError);
      expect(() => normalizeScopeInput(scope)).toThrow(/must not leave the project/);
    }
  });
});
