export enum ActivationState {
  ACTIVE,
  DEACTIVATING,
  INACTIVE,
}

/** The stompjs shape: a numeric enum written through a setter helper. */
export class Activator {
  state: ActivationState = ActivationState.INACTIVE;
  private _ticks = 0;

  /** A predicate getter: its use in a condition is a test of `state`. */
  get active(): boolean {
    return this.state === ActivationState.ACTIVE;
  }

  private _changeState(state: ActivationState): void {
    this.state = state;
    this._ticks++;
  }

  activate(): void {
    if (this.active) return;
    this._changeState(ActivationState.ACTIVE);
  }

  deactivate(): void {
    if (this.state === ActivationState.INACTIVE) return;
    this._changeState(ActivationState.DEACTIVATING);
    this._ticks = 0;
    this._changeState(ActivationState.INACTIVE);
  }

  onClose(): void {
    if (this.state === ActivationState.DEACTIVATING) {
      this._changeState(ActivationState.INACTIVE);
    }
  }
}
