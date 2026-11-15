export enum S {
  Idle = "Idle",
  A = "A",
  B = "B",
  C = "C",
  D = "D",
  X = "X",
  Y = "Y",
}

declare const f: boolean;
declare const xs: S[];
declare function a(): Promise<void>;
declare function log(): void;
declare function gen(): AsyncIterable<number>;

/** Round 2 item 1: abrupt exits flow into the finally entry. */
export class Fin {
  s: S = S.Idle;
  thrown() {
    this.s = S.Idle;
    try {
      this.s = S.A;
    } catch (e) {
      this.s = S.B;
      throw e;
    } finally {
      this.s = S.Y;
    }
  }
  returned() {
    this.s = S.Idle;
    try {
      if (f) {
        this.s = S.C;
        return;
      }
      log();
    } finally {
      this.s = S.D;
    }
  }
  broken() {
    this.s = S.Idle;
    while (f) {
      try {
        this.s = S.A;
        if (f) break;
      } finally {
        this.s = S.B;
      }
    }
    this.s = S.X;
  }
}

/** Round 2 item 2: widening is re-checked. */
export class Wide {
  s: S = S.A;
  t: S = S.Idle;
  drive() {
    this.t = S.Idle;
    this.s = S.A;
    while (f) {
      switch (this.s) {
        case S.A:
          this.s = S.B;
          break;
        case S.B:
          this.s = S.C;
          break;
        case S.C:
          this.s = S.D;
          break;
        case S.D:
          this.s = S.X;
          break;
        case S.X:
          this.t = S.C;
          break;
      }
    }
    this.t = S.Y;
  }
}

/** Round 2 item 3: a write is followed by a throw through the loop back edge. */
export class Poll {
  s: S = S.Idle;
  w() {
    this.s = S.Idle;
    try {
      while (f) {
        log();
        this.s = S.A;
        log();
      }
    } catch {
      this.s = S.Y;
    }
  }
  wAwait() {
    this.s = S.Idle;
    try {
      while (true) {
        a();
        this.s = S.A;
      }
    } catch {
      this.s = S.Y;
    }
  }
  fr() {
    this.s = S.Idle;
    try {
      for (;;) {
        log();
        this.s = S.A;
      }
    } catch {
      this.s = S.Y;
    }
  }
  fo() {
    this.s = S.Idle;
    try {
      for (const x of xs) {
        log();
        this.s = S.A;
      }
    } catch {
      this.s = S.Y;
    }
  }
  fa() {
    this.s = S.Idle;
    try {
      for await (const x of gen()) {
        this.s = S.A;
      }
    } catch {
      this.s = S.Y;
    }
  }
}

/** Round 2 item 4: the parameter default is not the definite value. */
export class PP {
  constructor(private s: S = S.A) {
    this.s = S.B;
  }
}

/** Round 2 item 8: a plain getter maps to its backing field. */
export class Get {
  _s: S = S.Idle;
  get s(): S {
    return this._s;
  }
  set s(v: S) {
    this._s = v;
  }
  go() {
    if (this.s !== S.A) return;
    this.s = S.B;
  }
}

/** Round 2 item 9: a negated test on an entry set does not keep the entry marker. */
export class Neg {
  s: S = S.Idle;
  go() {
    if (this.s === S.A) return;
    this.s = S.A;
  }
}

/** Round 2 item 10: a call to a same-class method that writes the holder resets the set. */
export class Reset {
  s: S = S.Idle;
  reset() {
    this.s = S.Idle;
  }
  deep() {
    this.reset();
  }
  go() {
    this.reset();
    this.s = S.B;
  }
  go2() {
    this.deep();
    this.s = S.B;
  }
  plain() {
    log();
    this.s = S.B;
  }
}
