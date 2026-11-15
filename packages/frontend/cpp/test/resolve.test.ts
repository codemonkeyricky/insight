import { describe, expect, it } from "vitest";
import { resolver } from "../src/resolve.js";

/** A resolver context over a file list, asked from one file, with the edge's attributes. */
function ctx(fromFile: string, files: string[], system: boolean) {
  return { root: { path: "/unused", name: "t", allowBuildTools: false }, fromFile, attrs: { system }, hasFile: (p: string) => files.includes(p), hasNode: () => true, listFiles: () => files };
}

const PROJECT = ["absl/random/internal/nanobenchmark.cc", "absl/random/internal/time.h", "absl/time/time.h", "absl/time/internal/cctz/src/time_zone_format.cc", "lib/util/log.h"];

describe("cpp.include resolver: system includes", () => {
  it("does not look for an angle-bracket include beside the including file", async () => {
    // <time.h> from a file in absl/random/internal must not match absl/random/internal/time.h.
    expect(await resolver.resolve({ scheme: "cpp.include", text: "time.h" }, ctx("absl/random/internal/nanobenchmark.cc", PROJECT, true))).toBeNull();
  });

  it("still finds a quoted include beside the including file", async () => {
    const answer = await resolver.resolve({ scheme: "cpp.include", text: "time.h" }, ctx("absl/random/internal/nanobenchmark.cc", PROJECT, false));
    expect(answer?.targets).toEqual(["absl/random/internal/time.h"]);
  });

  it("does not match a bare system header name against a project header that ends with it", async () => {
    // absl/time/time.h is the only file ending in /time.h, but <time.h> names the C library header.
    expect(await resolver.resolve({ scheme: "cpp.include", text: "time.h" }, ctx("absl/time/internal/cctz/src/time_zone_format.cc", PROJECT, true))).toBeNull();
    expect((await resolver.resolve({ scheme: "cpp.include", text: "time.h" }, ctx("absl/time/internal/cctz/src/time_zone_format.cc", PROJECT, false)))?.targets).toContain("absl/time/time.h");
  });

  it("keeps the workspace-root lookup for an angle-bracket include with a directory part", async () => {
    const answer = await resolver.resolve({ scheme: "cpp.include", text: "absl/time/time.h" }, ctx("absl/random/internal/nanobenchmark.cc", PROJECT, true));
    expect(answer).toMatchObject({ targets: ["absl/time/time.h"], confidence: "inferred" });
    expect((await resolver.resolve({ scheme: "cpp.include", text: "util/log.h" }, ctx("x.cc", PROJECT, true)))?.targets).toEqual(["lib/util/log.h"]);
  });
});
