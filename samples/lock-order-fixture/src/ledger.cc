// HAND-WRITTEN fixture for the lock-order lens only. It is not taken from any project.
// transfer() takes accounts_mu then audit_mu. reconcile(), reached from a second thread through
// helper(), takes them in the opposite order, so the lens should report one cycle between the locks.
#include <mutex>
#include <thread>

std::mutex accounts_mu;
std::mutex audit_mu;

void transfer() {
  std::lock_guard<std::mutex> a(accounts_mu);
  std::lock_guard<std::mutex> b(audit_mu);
}

void reconcile() {
  std::lock_guard<std::mutex> b(audit_mu);
  std::lock_guard<std::mutex> a(accounts_mu);
}

void helper() { reconcile(); }

int main() {
  std::thread t(transfer);
  std::thread u(helper);
  t.join();
  u.join();
  return 0;
}
