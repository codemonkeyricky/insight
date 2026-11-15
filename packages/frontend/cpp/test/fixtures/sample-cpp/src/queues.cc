#include "queues.h"

namespace app {

boost::lockfree::queue<int> g_jobs(16);

void Pipeline::send_lockfree(int v) { lf_.push(v); }
void Pipeline::send_this(int v) { this->lf_.push(v); }
int Pipeline::recv_lockfree() {
  int v = 0;
  lf_.pop(v);
  return v;
}
void Pipeline::send_spsc(int v) { spsc_.push(v); }
void Pipeline::send_mc(int v) {
  mc_.enqueue(v);
  mc_.try_enqueue(v);
}
int Pipeline::recv_mc() {
  int v = 0;
  mc_.try_dequeue(v);
  return v;
}
void Pipeline::send_folly(int v) {
  folly_.write(v);
  folly_.blockingWrite(v);
}
void Pipeline::send_tbb(int v) { tbb_.push(v); }
int Pipeline::recv_tbb() {
  int v = 0;
  tbb_.try_pop(v);
  return v;
}

// A lock-free queue that is a local variable, so its channel is dynamic.
void local_queue() {
  boost::lockfree::queue<int> local_q(4);
  local_q.push(1);
}

// A namespace-scope lock-free queue, named by its qualified name.
void touch_global(int v) { g_jobs.push(v); }

// Guarded: pushed and popped under the same mutex, so the facts are inferred.
void Pipeline::publish(int v) {
  std::lock_guard<std::mutex> guard(mu_);
  guarded_.push(v);
}
int Pipeline::take() {
  std::unique_lock<std::mutex> lk(mu_);
  int v = guarded_.front();
  guarded_.pop();
  return v;
}

// Unguarded: no lock on either side, so nothing is emitted.
void Pipeline::enqueue_unguarded(int v) { unguarded_.push(v); }
int Pipeline::drain_unguarded() {
  int v = unguarded_.front();
  unguarded_.pop();
  return v;
}

// Split: pushed under one mutex and popped under another, so nothing is emitted.
void Pipeline::split_push(int v) {
  std::lock_guard<std::mutex> g(mu_);
  split_.push(v);
}
int Pipeline::split_pop() {
  std::lock_guard<std::mutex> g(other_);
  int v = split_.front();
  split_.pop();
  return v;
}

void Pipeline::read_side() { std::shared_lock<std::shared_mutex> r(rw_); }
void Pipeline::write_side() { std::unique_lock<std::shared_mutex> w(rw_); }

}  // namespace app
