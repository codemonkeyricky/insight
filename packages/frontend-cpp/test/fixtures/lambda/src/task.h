#pragma once

// A stand-in for a coroutine return type. The frontend reads names, not semantics.
template <typename T>
struct Task {
  T value;
};
