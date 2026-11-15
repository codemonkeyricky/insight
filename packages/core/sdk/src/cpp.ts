/**
 * Maps a C++ include path to the external package (a third-party dependency) it names. Build-system
 * frontends share these rules, so every build system answers an include the same way.
 */

/**
 * Include path prefixes that name a well-known package, with every name the package goes by: the Bazel registry
 * name first, then the CMake package name. Names compare case-insensitively.
 */
export const CPP_INCLUDE_ALIAS_NAMES: ReadonlyMap<string, readonly string[]> = new Map<string, readonly string[]>([
  ["absl", ["abseil-cpp", "absl"]],
  ["gtest", ["googletest", "GTest"]],
  ["gmock", ["googletest", "GTest"]],
  ["benchmark", ["google_benchmark", "benchmark"]],
  ["google/protobuf", ["protobuf", "Protobuf"]],
  ["grpc", ["grpc", "gRPC"]],
  ["grpcpp", ["grpc", "gRPC"]],
  ["fmt", ["fmt"]],
  ["spdlog", ["spdlog"]],
  ["nlohmann", ["nlohmann_json"]],
  ["boost", ["boost", "Boost"]],
  ["re2", ["re2"]],
  ["glog", ["glog"]],
  ["gflags", ["gflags"]],
]);

/** Include path prefixes that name a well-known package, mapped to the package's name in the Bazel registry. */
export const CPP_INCLUDE_ALIASES: ReadonlyMap<string, string> = new Map<string, string>(
  [...CPP_INCLUDE_ALIAS_NAMES].map(([prefix, names]) => [prefix, names[0] ?? prefix]),
);

/** An external package, by id, with the name and repository name that an include path can match. */
export interface CppExternal {
  id: string;
  name: string;
  repoName?: string;
}

/** One external package that an include names, and how it was matched: through an alias, or by its name. */
export interface CppExternalMatch {
  id: string;
  via: "alias" | "name";
}

/**
 * Every external package an include path names, sorted by id. A path with one segment names none, so
 * `<string>` and `"foo.h"` are never external. A path whose first segment (or `google/protobuf`) is a known
 * alias matches an external of any of the aliased names (boost also matches boost.*). Otherwise the first
 * segment matches an external's name or repoName. Names compare case-insensitively.
 */
export function externalsForInclude(text: string, externals: CppExternal[]): CppExternalMatch[] {
  const parts = text.split("/");
  if (parts.length < 2) return [];
  const key = parts[0] === "google" && parts[1] === "protobuf" ? "google/protobuf" : (parts[0] ?? "");
  const names = CPP_INCLUDE_ALIAS_NAMES.get(key);
  if (names !== undefined) {
    const lowered = names.map((n) => n.toLowerCase());
    const boost = lowered[0] === "boost";
    const found = externals.filter((e) => {
      const n = e.name.toLowerCase();
      return lowered.includes(n) || (boost && n.startsWith("boost."));
    });
    if (found.length > 0) return found.map((e) => ({ id: e.id, via: "alias" as const })).sort(byId);
  }
  const first = (parts[0] ?? "").toLowerCase();
  return externals
    .filter((e) => e.name.toLowerCase() === first || e.repoName?.toLowerCase() === first)
    .map((e) => ({ id: e.id, via: "name" as const }))
    .sort(byId);
}

/** The external package an include path names: the first of `externalsForInclude`, or undefined. */
export function externalForInclude(text: string, externals: CppExternal[]): CppExternalMatch | undefined {
  return externalsForInclude(text, externals)[0];
}

function byId(a: CppExternalMatch, b: CppExternalMatch): number {
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}
