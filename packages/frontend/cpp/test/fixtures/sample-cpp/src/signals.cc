#include <csignal>
#include <sys/types.h>
#include <unistd.h>

namespace app {

// The project's kill is in os.cc and is static there, so this call still names the system call.
void stop_child(pid_t pid) { kill(pid, SIGTERM); }

void interrupt(pid_t pid, int sig) {
  kill(pid, sig);
  raise(SIGINT);
  signal(SIGHUP, nullptr);
  struct sigaction sa;
  sigaction(SIGUSR1, &sa, nullptr);
}

}  // namespace app
