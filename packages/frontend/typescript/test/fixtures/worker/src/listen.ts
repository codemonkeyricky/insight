import { verify } from "./verify";

function onMessage(e: MessageEvent): void {
  verify(e.data);
}

window.addEventListener("message", onMessage);
