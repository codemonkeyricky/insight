#include "queues.h"
#include <chrono>
#include <pthread.h>
#include <semaphore.h>

namespace app {

sem_t gate;
pthread_cond_t pc_;
pthread_mutex_t pm_;

void Pipeline::wait_ready() {
  slots_.acquire();
  ready_.try_acquire_for(std::chrono::milliseconds(5));
  sem_wait(&gate);
  pthread_cond_wait(&pc_, &pm_);
}

void Pipeline::signal_ready() {
  ready_.release();
  slots_.release();
  sem_post(&gate);
  pthread_cond_signal(&pc_);
  pthread_cond_broadcast(&pc_);
}

// Dynamic semaphore and condition variable: the arguments are indexed, so they are not plain names.
void Pipeline::signal_dynamic(sem_t* gates[], pthread_cond_t* conds[], int i) {
  sem_post(gates[i]);
  pthread_cond_signal(conds[i]);
}

void Pipeline::wait_for_work() {
  std::unique_lock<std::mutex> lk(mu_);
  cv_.wait(lk);
  cv_.wait_for(lk, std::chrono::milliseconds(5));
}

void Pipeline::notify_work() {
  cv_.notify_one();
  cv_.notify_all();
}

void Pipeline::count() {
  hits_.fetch_add(1);
  hits_++;
  int now = hits_.load();
  hits_.store(now + 1);
  int expected = now;
  hits_.compare_exchange_strong(expected, 0);
}

void Pipeline::stop_flag() {
  std::atomic<bool> stop{false};
  stop.store(true);
}

// An object whose type is not known here, so its atomic-named method is not an atomic operation.
void Pipeline::unknown_atomic_method() {
  Unknown u;
  u.load();
}

}  // namespace app
