export class Meter {
  static n = 0;
  static readonly LABEL = "m";
  tick(): void {
    Meter.n++;
  }
}
