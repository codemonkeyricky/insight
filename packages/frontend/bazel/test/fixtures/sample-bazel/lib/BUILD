load("@rules_cc//cc:defs.bzl", "cc_library", "cc_test")

# Public API: the header is exposed as acme/core/core.h.
cc_library(
    name = "core",
    srcs = glob(["src/*.cc"]),
    hdrs = ["include/core/core.h"],
    strip_include_prefix = "include",
    include_prefix = "acme",
    deps = [":util"],
)

cc_library(
    name = "util",
    hdrs = ["util/log.h"],
    includes = ["."],
)

cc_test(
    name = "core_test",
    srcs = ["test/core_test.cc"],
    deps = [
        ":core",
        "@googletest//:gtest_main",
    ],
)
