import { Emitter } from "./emitter";
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

/** Deferred callbacks do not run in the method that creates them. */
export class Defer {
  s: S = S.Idle;
  t: { onclose?: () => void } = {};
  async start() {
    try {
      this.wire();
      await a();
    } catch {
      this.s = S.F;
    }
  }
  wire() {
    this.t.onclose = () => this.stop();
  }
  stop() {
    this.s = S.D;
  }
}

/** Round 4 item 1: members from a .d.ts base and overloads with a body do not wipe the holders. */
export class Em extends Emitter {
  s: S = S.Idle;
  go() {
    if (this.s !== S.A) return;
    this.emit("x");
    this.s = S.B;
  }
}
export class Ov {
  s: S = S.Idle;
  note(x: string): void;
  note(x: number): void;
  note(x: string | number): void {
    log();
  }
  go() {
    if (this.s !== S.A) return;
    this.note("x");
    this.s = S.B;
  }
}

/** Round 4 item 2: synchronously invoked callbacks count; stored ones do not. */
export class Cb {
  s: S = S.Idle;
  each() {
    [1].forEach(() => {
      this.s = S.Idle;
    });
  }
  exec() {
    new Promise<void>((r) => {
      this.s = S.Idle;
      r();
    });
  }
  iife() {
    (() => {
      this.s = S.Idle;
    })();
  }
  later() {
    setTimeout(() => {
      this.s = S.Idle;
    }, 1);
  }
  goEach() {
    this.each();
    this.s = S.B;
  }
  goExec() {
    this.exec();
    this.s = S.B;
  }
  goIife() {
    this.iife();
    this.s = S.B;
  }
  goLater() {
    this.later();
    this.s = S.B;
  }
}
