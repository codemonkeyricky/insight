#pragma once
#include <atomic>
#include <condition_variable>
#include <mutex>
#include <queue>
#include <semaphore>
#include <shared_mutex>
#include <string>

namespace app {

class Pipeline {
 public:
  void send_lockfree(int v);
  void send_this(int v);
  int recv_lockfree();
  void send_spsc(int v);
  void send_mc(int v);
  int recv_mc();
  void send_folly(int v);
  void send_tbb(int v);
  int recv_tbb();
  void publish(int v);
  int take();
  void enqueue_unguarded(int v);
  int drain_unguarded();
  void split_push(int v);
  int split_pop();
  void wait_ready();
  void signal_ready();
  void signal_dynamic(sem_t* gates[], pthread_cond_t* conds[], int i);
  void wait_for_work();
  void notify_work();
  void read_side();
  void write_side();
  void count();
  void stop_flag();
  void unknown_atomic_method();

 private:
  boost::lockfree::queue<int> lf_{128};
  boost::lockfree::spsc_queue<int> spsc_{64};
  moodycamel::ConcurrentQueue<int> mc_;
  folly::MPMCQueue<int> folly_{32};
  tbb::concurrent_queue<int> tbb_;
  std::queue<int> guarded_;
  std::queue<int> unguarded_;
  std::queue<int> split_;
  std::mutex mu_;
  std::mutex other_;
  std::shared_mutex rw_;
  std::counting_semaphore<8> slots_{8};
  std::binary_semaphore ready_{0};
  std::condition_variable cv_;
  std::atomic<int> hits_{0};
};

}  // namespace app
