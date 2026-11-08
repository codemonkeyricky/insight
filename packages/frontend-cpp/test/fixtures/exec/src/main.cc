#include <future>
#include <pthread.h>
#include <thread>
#include "work.h"

namespace exec {

void* pthread_body(void* arg) { return arg; }

void* launch(Foo& foo) {
  std::thread solo(worker);                          // declaration, free function
  std::thread pair(worker, 1);                       // declaration, free function and argument
  auto made = std::thread(worker, 2);                // expression form
  std::thread member(&Foo::run, &foo);               // member function pointer
  auto fut = std::async(std::launch::async, square, 5);
  pthread_t tid;
  pthread_create(&tid, nullptr, pthread_body, nullptr);
  std::thread lambda([] { worker(3); });             // lambda: no edge
  std::thread gone(unknown_fn);                      // not defined in the project: no edge
  std::thread shared(drain);                         // two definitions: candidates
  return nullptr;
}

Task<int> pipeline(int key) {
  int v = co_await fetch(key);                       // awaits a coroutine: await
  co_await make_awaiter();                           // awaits a plain call: no edge
  co_return v;
}

void kick() {
  Task<int> t = fetch(7);                            // calls a coroutine without awaiting: start
  (void)t;
}

}  // namespace exec
