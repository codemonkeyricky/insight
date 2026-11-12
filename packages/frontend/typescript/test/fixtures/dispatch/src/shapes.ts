export abstract class Shape {
  abstract area(): number;

  // `this.area()` names the abstract member through the class's own type.
  describe(): string {
    return `${this.area()}`;
  }
}

export class Square extends Shape {
  area(): number {
    return 1;
  }
}

export class Circle extends Shape {
  area(): number {
    return 2;
  }
}
