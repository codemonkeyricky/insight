#pragma once

// Stand-ins for a coroutine return type and an awaitable. The frontend reads names, not semantics.
template <typename T>
struct Task {
  T value;
};

struct Awaiter {};
