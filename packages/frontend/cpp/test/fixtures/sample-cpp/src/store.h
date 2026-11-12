#pragma once
#include <mutex>
#include <string>

namespace app {

class Store {
 public:
  void put(const std::string& key, int value);
  int get(const std::string& key);
  void flush();

 private:
  std::mutex mu_;
  int hits_ = 0;
};

}  // namespace app
