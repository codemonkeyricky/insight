#include "conn.h"

namespace net {

static ConnState g_last = ConnState::Idle;

Conn::Conn() : state_(ConnState::Idle), retries_(0) {}

void Conn::start() {
  if (state_ == ConnState::Idle) {
    state_ = ConnState::Connecting;
  } else {
    retries_++;
  }
}

void Conn::onConnected() {
  if (state_ != ConnState::Connecting) return;
  state_ = ConnState::Connected;
}

void Conn::close() {
  this->state_ = ConnState::Closed;
  g_last = state_;
}

int Conn::pump() {
  switch (state_) {
    case ConnState::Idle:
    case ConnState::Closed:
      return 0;
    case ConnState::Connecting:
      state_ = ConnState::Connected;
      break;
    default:
      break;
  }
  return 1;
}

}  // namespace net
