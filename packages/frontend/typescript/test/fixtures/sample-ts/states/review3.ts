export enum S {
  Idle = "Idle",
  A = "A",
  B = "B",
  C = "C",
  D = "D",
  F = "F",
  X = "X",
  Y = "Y",
}

declare const f: boolean;
declare function a(): Promise<void>;
declare function log(): void;
declare const e: unknown;

/** Round 3 item 1: call invalidation reaches the try collector. */
export class I1 {
  s: S = S.Idle;
  reset() {
    this.s = S.Idle;
  }
  async go() {
    try {
      this.reset();
      await a();
    } catch {
      this.s = S.F;
    }
  }
}

/** Item 2: a cycle among methods does not cache a partial write set. */
export class I2 {
  s: S = S.Idle;
  pre() {
    this.a();
  }
  a() {
    this.b();
    this.s = S.Idle;
  }
  b() {
    if (f) this.a();
  }
  go() {
    this.b();
    this.s = S.B;
  }
}

/** Items 3, 5, 8: every try is a phase. */
export class I3 {
  s: S = S.Idle;
  nestedFinally() {
    this.s = S.Idle;
    try {
      log();
    } catch {
      try {
        this.s = S.F;
        throw e;
      } finally {
        this.s = S.C;
      }
    } finally {
      this.s = S.Y;
    }
  }
  innerCatch() {
    this.s = S.Idle;
    try {
      log();
    } catch {
      try {
        this.s = S.X;
        throw e;
      } catch {
        this.s = S.A;
      }
    } finally {
      this.s = S.Y;
    }
  }
  implicit() {
    this.s = S.Idle;
    try {
      log();
    } catch {
      this.s = S.F;
      log();
      this.s = S.A;
    } finally {
      this.s = S.Y;
    }
  }
}

/** Item 4: a setter helper's other holders are invalidated. */
export class I4 {
  s: S = S.Idle;
  t: S = S.Idle;
  setS(v: S) {
    this.s = v;
    this.t = S.X;
  }
  go() {
    this.setS(S.A);
    this.t = S.B;
  }
}

/** Item 6: an unresolvable this.x() drops every holder to plain unknown. */
export abstract class I6 {
  s: S = S.Idle;
  abstract hook(): void;
  go() {
    this.hook();
    this.s = S.B;
  }
}
