export class Base {
  protected shared(): number {
    return 14;
  }
}

export class Child extends Base {
  call(): number {
    return this.shared();
  }
}
