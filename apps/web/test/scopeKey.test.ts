import { describe, expect, it } from "vitest";
import { ROOT_KEY, canonicalScope, scopeKey, scopeProblem } from "../src/scopeKey.js";

describe("scopeKey", () => {
  it("names the project scope with the root key", () => {
    expect(scopeKey("")).toBe(ROOT_KEY);
    expect(() => scopeKey("/")).toThrow("scope must be relative to the project");
  });

  it("keeps a folder or file path as its segments", () => {
    expect(scopeKey("src/core")).toBe("src/core");
    expect(scopeKey("src/core/index.ts")).toBe("src/core/index.ts");
  });

  it("canonicalises before naming, so equal scopes share one key", () => {
    expect(canonicalScope("src//core/")).toBe("src/core");
    expect(canonicalScope("./src/./core")).toBe("src/core");
    expect(canonicalScope("src\\core")).toBe("src/core");
    expect(scopeKey("src\\core")).toBe(scopeKey("src/core"));
    expect(scopeKey("src//core/")).toBe(scopeKey("src/core"));
  });

  it("encodes each segment, so a name with spaces or # cannot change the path", () => {
    expect(scopeKey("my dir/a#b.ts")).toBe("my%20dir/a%23b.ts");
  });

  it("cannot collide with the root key, because every key escapes the @", () => {
    expect(scopeKey("@root")).toBe("%40root");
    expect(scopeKey("@root")).not.toBe(ROOT_KEY);
  });

  it("does not collide with a real top-level folder named like the old sentinel", () => {
    expect(scopeKey("_root")).toBe("_root");
    expect(scopeKey("_root")).not.toBe(ROOT_KEY);
  });

  it("refuses a path that leaves the project, so no file is named from ..", () => {
    expect(() => scopeKey("../secret")).toThrow("scope must not leave the project: ../secret");
    expect(() => scopeKey("a/../../b")).toThrow("scope must not leave the project");
    expect(() => scopeKey("/etc")).toThrow("scope must be relative to the project: /etc");
  });

  it("reports the server's messages for a refused scope and nothing for a fine one", () => {
    expect(scopeProblem("../x")).toBe("scope must not leave the project: ../x");
    expect(scopeProblem("/abs")).toBe("scope must be relative to the project: /abs");
    expect(scopeProblem("src/core")).toBeUndefined();
    expect(scopeProblem("")).toBeUndefined();
  });
});
