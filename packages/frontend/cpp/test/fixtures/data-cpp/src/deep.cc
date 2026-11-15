struct Inner {
  int n;
};

struct Outer {
  Inner inner;
  Inner log;
  int cache[4];
};

Outer state;
Inner rows[4];

void deep_set() { state.inner.n = 2; }
void deep_cache(int i) { state.cache[i] = 3; }
void deep_log() { state.log.n++; }
void deep_row(int i) { rows[i].n = 4; }

static const char* const kNames[] = {"a", "b"};
static const char* names[] = {"a"};

const char* first_name() {
  names[0] = "x";
  return kNames[0];
}
