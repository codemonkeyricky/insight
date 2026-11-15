# A macro that wraps cc_library: the BUILD files call it, and the frontend reads its calls as C++ targets.
def my_cc_library(name, srcs = [], hdrs = [], deps = []):
    native.cc_library(name = name, srcs = srcs, hdrs = hdrs, deps = deps)
