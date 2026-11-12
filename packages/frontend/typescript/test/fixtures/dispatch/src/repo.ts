export interface Repo {
  save(): void;
}

export interface Store extends Repo {
  close(): void;
}

export class SqlRepo implements Repo {
  save(): void {}
}

export class MemRepo implements Repo {
  save(): void {}
}

// Implements the extended interface, so it implements Repo as well.
export class Cache implements Store {
  save(): void {}
  close(): void {}
}

// A subclass of an implementer that overrides save: its own save is a candidate.
export class FastMem extends MemRepo {
  save(): void {}
}

// A subclass of an implementer that keeps the inherited save: the base's save is the candidate, once.
export class PlainMem extends SqlRepo {}
