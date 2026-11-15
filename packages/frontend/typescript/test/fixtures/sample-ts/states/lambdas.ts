export type Mode = "idle" | "open" | "closed";

export class Socket {
  mode: Mode = "idle";
  onclose: () => void = () => undefined;

  connect(): void {
    this.mode = "open";
    register({
      onWebSocketClose: () => {
        this.mode = "closed";
      },
    });
    this.onclose = () => {
      this.mode = "idle";
    };
    setTimeout(() => {
      this.mode = "closed";
    }, 1);
  }
}

declare function register(h: { onWebSocketClose: () => void }): void;
