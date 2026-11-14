export enum ConnState {
  Disconnected = "Disconnected",
  Connecting = "Connecting",
  Connected = "Connected",
  Disconnecting = "Disconnecting",
  Reconnecting = "Reconnecting",
}

/** A cut-down connection with the shapes a real client has: guards, awaits, a catch and a shared helper. */
export class Connection {
  private _state: ConnState;
  private _notes: string[] = [];

  constructor() {
    this._state = ConnState.Disconnected;
  }

  public async start(): Promise<void> {
    if (this._state !== ConnState.Disconnected) {
      throw new Error("busy");
    }
    this._state = ConnState.Connecting;
    try {
      await this._open();
      this._state = ConnState.Connected;
      this._note("up");
    } catch (e) {
      this._state = ConnState.Disconnected;
      throw e;
    }
  }

  public async stop(): Promise<void> {
    if (this._state === ConnState.Disconnected) return;
    if (this._state === ConnState.Disconnecting) return;
    this._state = ConnState.Disconnecting;
    await this._close();
    this._complete();
  }

  /** No early exit: its entry state comes from its callers. */
  private _complete(): void {
    this._state = ConnState.Disconnected;
  }

  private _closed(): void {
    if (this._state === ConnState.Disconnecting) {
      this._complete();
      return;
    }
    void this._open().then(() => {
      this._complete();
    });
  }

  private async _reconnect(): Promise<void> {
    this._state = ConnState.Reconnecting;
    await this._open();
    // A write after the await is stale until this re-test.
    this._state = ConnState.Connected;
    await this._open();
    if ((this._state as any) !== ConnState.Connected) {
      return;
    }
    this._state = ConnState.Reconnecting;
  }

  private async _open(): Promise<void> {}
  private async _close(): Promise<void> {}
  private _note(text: string): void {
    this._notes.push(text);
  }
}
