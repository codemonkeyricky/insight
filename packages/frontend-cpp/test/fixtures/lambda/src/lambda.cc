#include <functional>
#include <future>
#include <mutex>
#include <pthread.h>
#include <thread>
#include "task.h"

void work() {}
void worker(int n) { (void)n; }
Task<int> fetch(int key) { co_return Task<int>{key}; }

// A lambda at file scope: its parent is the file, and the closure edge starts at the file.
auto boot = [] { work(); };

namespace app {

void* pthread_body(void* arg) { return arg; }

void run(std::function<void()> fn) {
  std::thread t(fn);                                                    // a parameter: no edge
}

void start() {
  std::thread inline_one([] { work(); });                               // inline lambda
  auto task = [] { work(); };                                           // bound to a local
  std::thread bound(task);                                              // edge to task
  auto fut = std::async(std::launch::async, [] { work(); });            // async, inline lambda
  std::thread braced{worker, 1};                                        // brace-init, free function
  std::thread braced_lambda{[] { work(); }};                            // brace-init, inline lambda
  pthread_t tid;
  pthread_create(&tid, nullptr, pthread_body, nullptr);                 // named function: unchanged
  pthread_create(&tid, nullptr, +[](void*) -> void* { return nullptr; }, nullptr);
  auto outer = [] {                                                     // nested lambda
    auto inner = [] { work(); };
    std::thread nested(inner);
  };
  std::thread launched(outer);
  auto wait = []() -> Task<int> {                                       // a coroutine lambda
    int v = co_await fetch(1);
    co_return v;
  };
  (void)wait;
  (void)fut;
}

void other() {
  auto task = [] { worker(2); };
  std::thread t(task);
}

void scoped() {
  { auto gone = [] {}; }
  std::thread t(gone);                                                  // gone is out of scope: no edge
}

void assigns() {
  std::function<void()> later;
  later = [] { work(); };
  std::thread assigned(later);                                          // assignment: heuristic
}

}  // namespace app

class Gate {
 public:
  void open();

 private:
  std::mutex mu_;
};

void Gate::open() {
  auto locked = [this] { std::lock_guard<std::mutex> guard(mu_); };   // a lock taken inside a lambda
  locked();
}
