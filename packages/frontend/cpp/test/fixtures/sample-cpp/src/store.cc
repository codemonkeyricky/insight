#include "store.h"
#include <stdexcept>
#include <thread>
#include "util/log.h"

namespace app {

void Store::put(const std::string& key, int value) {
  std::lock_guard<std::mutex> guard(mu_);
  if (value < 0) {
    throw std::invalid_argument(key);
  }
  log_line(key);
  hits_ += value;
}

int Store::get(const std::string& key) {
  std::lock_guard<std::mutex> guard(mu_);
  for (int i = 0; i < 3; ++i) {
    if (key.empty()) continue;
  }
  return hits_;
}

void Store::flush() {
  mu_.lock();
  std::thread worker(log_line, std::string("flush"));
  worker.join();
  mu_.unlock();
}

}  // namespace app
