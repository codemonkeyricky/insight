import { describe, expect, it } from "vitest";
import { CPP_INCLUDE_ALIASES, externalForInclude, externalsForInclude, type CppExternal } from "../src/index.js";

const externals: CppExternal[] = [
  { id: "@abseil-cpp", name: "abseil-cpp" },
  { id: "@boost.asio", name: "boost.asio" },
  { id: "@boost", name: "boost" },
  { id: "@com_google_googletest", name: "googletest", repoName: "com_google_googletest" },
  { id: "@zlib", name: "zlib", repoName: "zlib_repo" },
  { id: "@fmt", name: "fmt" },
];

describe("CPP_INCLUDE_ALIASES", () => {
  it("maps well-known include prefixes to registry names", () => {
    expect(CPP_INCLUDE_ALIASES.get("absl")).toBe("abseil-cpp");
    expect(CPP_INCLUDE_ALIASES.get("google/protobuf")).toBe("protobuf");
    expect(CPP_INCLUDE_ALIASES.get("gmock")).toBe("googletest");
  });
});

describe("externalForInclude", () => {
  it("never matches a single-segment include", () => {
    expect(externalForInclude("zlib.h", externals)).toBeUndefined();
    expect(externalForInclude("fmt", externals)).toBeUndefined();
    expect(externalsForInclude("abseil-cpp", externals)).toEqual([]);
  });

  it("matches an alias prefix to the external of the aliased name", () => {
    expect(externalForInclude("absl/strings/str_cat.h", externals)).toEqual({ id: "@abseil-cpp", via: "alias" });
  });

  it("matches boost.* externals as well as boost itself through the boost alias", () => {
    expect(externalsForInclude("boost/asio.hpp", externals)).toEqual([
      { id: "@boost", via: "alias" },
      { id: "@boost.asio", via: "alias" },
    ]);
    expect(externalForInclude("boost/asio.hpp", externals)).toEqual({ id: "@boost", via: "alias" });
  });

  it("matches google/protobuf as one alias key", () => {
    const protobuf: CppExternal[] = [{ id: "@protobuf", name: "protobuf" }];
    expect(externalForInclude("google/protobuf/message.h", protobuf)).toEqual({ id: "@protobuf", via: "alias" });
  });

  it("falls back to the first segment matching a name or repoName", () => {
    expect(externalForInclude("gtest/gtest.h", externals)).toEqual({ id: "@com_google_googletest", via: "alias" });
    expect(externalForInclude("zlib/zlib.h", externals)).toEqual({ id: "@zlib", via: "name" });
    expect(externalForInclude("com_google_googletest/x.h", externals)).toEqual({ id: "@com_google_googletest", via: "name" });
  });

  it("returns undefined when no external matches", () => {
    expect(externalForInclude("net/socket.h", externals)).toBeUndefined();
    expect(externalsForInclude("net/socket.h", externals)).toEqual([]);
  });

  it("sorts multiple name matches by id", () => {
    const dup: CppExternal[] = [
      { id: "@z", name: "lib", repoName: "x" },
      { id: "@a", name: "x" },
    ];
    expect(externalsForInclude("x/y.h", dup)).toEqual([
      { id: "@a", via: "name" },
      { id: "@z", via: "name" },
    ]);
  });
});
