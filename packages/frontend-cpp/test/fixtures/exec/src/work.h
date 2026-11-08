#pragma once
#include "task.h"

namespace exec {

void worker(int n);
int square(int x);
Task<int> fetch(int key);
Awaiter make_awaiter();
void drain();

class Foo {
 public:
  void run();
  void start();
};

}  // namespace exec
