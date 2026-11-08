#include "work.h"
#include <thread>

namespace exec {

void worker(int n) { (void)n; }

int square(int x) { return x * x; }

void drain() {}

Task<int> fetch(int key) { co_return Task<int>{key}; }

Awaiter make_awaiter() { return Awaiter{}; }

void Foo::run() {}

void Foo::start() {
  std::thread t(&Foo::run, this);
  t.join();
}

}  // namespace exec
