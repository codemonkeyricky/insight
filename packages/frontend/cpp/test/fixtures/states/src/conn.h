#pragma once

namespace net {

enum class ConnState { Idle, Connecting, Connected, Closed };

class Conn {
 public:
  Conn();
  void start();
  void onConnected();
  void close();
  int pump();

 private:
  ConnState state_;
  ConnState prev_ = ConnState::Idle;
  int retries_;
};

}  // namespace net
