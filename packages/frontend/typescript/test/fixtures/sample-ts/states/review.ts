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
declare function a(): Promise<void>;
declare function log(): void;

/** Entry-set contract: fromEntry on writes, knownEntry on calls. */
export class Entry {
  s: S = S.Idle;
  step() {
    if (f) this.s = S.B;
    this.s = S.C;
  }
  go() {
    this.s = S.X;
  }
  async goAwait() {
    await a();
    this.s = S.X;
  }
  outer(cond: boolean) {
    if (cond) return;
    this.inner();
    this.s = S.Y;
  }
  outerTested() {
    if (this.s === S.A) this.inner();
  }
  inner() {}
}

/** Review bug 1: what follows a finally block comes from the normal paths only. */
export class Fin {
  s: S = S.Idle;
  async run() {
    this.s = S.Idle;
    try {
      this.s = S.A;
      await a();
      this.s = S.B;
    } catch {
      this.s = S.C;
    } finally {
      log();
    }
    this.s = S.D;
  }
}

/** Review bug 2: an early exit before the assignment makes a setter conditional. */
export class Guarded {
  s: S = S.Idle;
  set(v: S) {
    if (v === this.s) return;
    this.s = v;
  }
  caller() {
    if (this.s === S.Idle) this.set(S.Idle);
  }
}

/** Review bug 4: writes through a set accessor. */
export class Acc {
  private _s: S = S.Idle;
  get s(): S {
    return this._s;
  }
  set s(v: S) {
    this._s = v;
  }
  go() {
    this.s = S.B;
  }
}

/** Review bug 5: `case A: default:` is reached by everything but the other groups' values. */
export class Sw {
  s: S = S.Idle;
  run() {
    switch (this.s) {
      case S.A:
      default:
        this.s = S.C;
        break;
      case S.B:
        break;
    }
  }
}

/** Review bug 6: labelled blocks and labelled switches are break targets. */
export class Lbl {
  s: S = S.Idle;
  blk() {
    lbl: {
      if (this.s === S.A) break lbl;
      this.s = S.B;
    }
    this.s = S.C;
  }
  sw() {
    out: switch (this.s) {
      case S.A:
        if (f) break out;
        this.s = S.B;
        break;
    }
    this.s = S.D;
  }
}

/** Review bug 7: for await awaits (stale) and can throw. */
export class FA {
  s: S = S.Idle;
  async run(src: AsyncIterable<number>) {
    this.s = S.A;
    for await (const x of src) void x;
    this.s = S.B;
  }
  async guarded(src: AsyncIterable<number>) {
    this.s = S.Idle;
    try {
      this.s = S.A;
      for await (const x of src) void x;
    } catch {
      this.s = S.C;
    }
  }
}

/** Review bug 8: a parameter-property initializer writes the field. */
export class PP {
  constructor(private s: S = S.A) {}
}

/** Review gaps: a while loop with writes, and nested try. */
export class Loops {
  s: S = S.Idle;
  w() {
    this.s = S.A;
    while (f) {
      this.s = S.B;
      if (f) break;
      this.s = S.A;
    }
    this.s = S.C;
  }
  async nt() {
    this.s = S.Idle;
    try {
      try {
        this.s = S.A;
        await a();
      } catch {
        this.s = S.B;
      }
      this.s = S.C;
      await a();
    } catch {
      this.s = S.D;
    }
  }
}
