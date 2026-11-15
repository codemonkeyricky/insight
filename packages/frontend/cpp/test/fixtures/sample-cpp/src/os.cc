#include <csignal>
#include <cstdio>
#include <cstdlib>
#include <fcntl.h>
#include <filesystem>
#include <fstream>
#include <string>
#include <sys/ioctl.h>
#include <sys/mman.h>
#include <sys/socket.h>
#include <sys/syscall.h>
#include <unistd.h>

// A function the project defines with the name of a system call. Calls to it in this file are not system calls.
static void kill(int pid) { (void)pid; }

void self_kill() { kill(3); }

void spawn_children() {
  pid_t child = fork();
  pid_t other = vfork();
  (void)child;
  (void)other;
}

void map_memory(size_t n) {
  void* p = mmap(nullptr, n, PROT_READ | PROT_WRITE, MAP_PRIVATE, -1, 0);
  mprotect(p, n, PROT_READ);
  munmap(p, n);
}

void open_literal() {
  int fd = open("/etc/hostname", O_RDONLY);
  char buf[16];
  read(fd, buf, sizeof buf);
  write(fd, buf, 1);
  close(fd);
  int pipefd[2];
  pipe(pipefd);
  dup(fd);
  dup2(pipefd[0], 9);
}

void open_dynamic(const char* path) {
  int fd = open(path, O_RDONLY);
  close(fd);
}

void device_and_raw(int fd, unsigned long req) {
  ioctl(fd, FIONREAD, &req);
  ioctl(fd, req, nullptr);
  syscall(SYS_gettid);
  syscall(req);
}

void paths(const char* p) {
  FILE* a = fopen("/etc/passwd", "r");
  FILE* b = fopen(p, "r");
  unlink("/tmp/insight-x");
  rename("/tmp/insight-a", "/tmp/insight-b");
  remove(p);
  std::filesystem::exists("/etc");
  std::filesystem::create_directory(p);
  (void)a;
  (void)b;
}

void streams(const std::string& name) {
  std::ifstream in("/etc/hosts");
  std::ofstream out("/tmp/insight-out.txt");
  std::fstream both("/tmp/insight-rw.txt");
  std::ifstream dyn(name);
  std::ifstream none;
}

void sockets(int s, const sockaddr* a, socklen_t n) {
  connect(s, a, n);
  bind(s, a, n);
  listen(s, 8);
}

void exec_it(const char* path, char* const argv[], char* const envp[]) { execve(path, argv, envp); }

// A member call named like a system call. The receiver is a stream, so nothing is emitted.
int member_read(std::ifstream& f, char* buf) { return f.read(buf, 4) ? 1 : 0; }
