#include <map>
#include <string>
#include "a.h"

// a: a file-static counter bumped with ++ by one function and read by another.
static int counter = 0;
void bump() { ++counter; }
int peek() { return counter; }

// b: a variable in an anonymous namespace.
namespace {
int hidden = 0;
}
void touch() { hidden = 2; }

// c: the definition of the global declared extern in a.h.
int g;

// h: taking the address of a global.
void take(int* p) { *p = 1; }
void addr() { take(&g); }

// d: a function-local static map, mutated by subscript and by insert.
int cached(const std::string& k, int v) {
  static std::map<std::string, int> cache;
  cache[k] = v;
  return static_cast<int>(cache.size());
}
void put(int k) {
  static std::map<int, int> m;
  m.insert({k, k});
}

// e: a static data member incremented in a method.
struct Meter {
  static int count;
  void tick() { ++count; }
};
int Meter::count = 0;

// f: a constexpr constant that is only read.
constexpr int kMax = 4;
int limit() { return kMax; }

// g: a local that shadows the global counter produces no edge.
int shadowed() {
  int counter = 5;
  counter++;
  return counter;
}
