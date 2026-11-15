int total = 0;
int k = 0;
int count = 0;

struct Pair {
  int first;
  int second;
};

void guard() {
  try {
    throw 1;
  } catch (const int& total) {
    total++;
  }
}

void unpack(Pair p) {
  auto [k, count] = p;
  k++;
  count = 3;
}
