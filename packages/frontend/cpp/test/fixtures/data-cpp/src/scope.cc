int total = 0;
int hits = 0;

void block() {
  { int total = 1; }
  total++;
}

void lam() {
  hits++;
  auto f = [](int hits) { return hits; };
  (void)f;
}

void ranged(int (&v)[3]) {
  for (int& total : v) total += 1;
}
