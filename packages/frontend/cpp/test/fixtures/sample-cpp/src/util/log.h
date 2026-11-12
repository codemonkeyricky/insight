#pragma once
#include <cstdio>
#include <string>

namespace app {

inline void log_line(const std::string& s) { std::fputs(s.c_str(), stderr); }

}  // namespace app
