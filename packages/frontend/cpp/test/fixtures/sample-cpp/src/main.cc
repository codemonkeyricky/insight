#include <chrono>
#include <cstdlib>
#include "store.h"

static int load_limit() {
  const char* raw = std::getenv("LIMIT");
  return raw ? 10 : 3;
}

int main() {
  app::Store store;
  auto start = std::chrono::steady_clock::now();
  store.put("a", load_limit());
  store.flush();
  (void)start;
  return store.get("a") > 0 ? 0 : 1;
}
