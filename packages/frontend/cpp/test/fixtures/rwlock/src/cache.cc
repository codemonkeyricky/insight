#include <mutex>
#include <shared_mutex>

// A shared_lock on a shared_mutex is held while a second lock is taken. The guard must give one acquire node, so the
// lock-order lens records rw_ then b_ and no rw_ -> rw_ self edge.
class Cache {
 public:
  void refresh();

 private:
  std::shared_mutex rw_;
  std::mutex b_;
  int value_ = 0;
};

void Cache::refresh() {
  std::shared_lock g(rw_);
  std::lock_guard h(b_);
  value_ = 2;
}
