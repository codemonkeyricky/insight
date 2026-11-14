import fs from "node:fs";
import fsp from "node:fs/promises";
import http from "node:http";
import https from "node:https";
import os from "node:os";

// Signals: literal signal names, the default, and a dynamic one.
export function stopChild(pid: number): void {
  process.kill(pid, "SIGINT");
}

export function stopDefault(pid: number): void {
  process.kill(pid);
}

export function stopDynamic(pid: number, sig: string): void {
  process.kill(pid, sig);
}

// Signal handlers: a SIG name is a signal. Other events are not, and neither is a name held in a variable.
export function onSignals(eventName: string): void {
  process.on("SIGINT", () => undefined);
  process.once("SIGTERM", () => undefined);
  process.on("exit", () => undefined);
  process.on(eventName, () => undefined);
}

export function leave(code: number): void {
  process.exit(code);
}

export function crash(): void {
  process.abort();
}

// Host facts.
export function hostFacts(): unknown[] {
  return [
    os.cpus(),
    os.networkInterfaces(),
    os.userInfo(),
    os.hostname(),
    [os.totalmem(), os.freemem()],
    os.loadavg(),
    os.uptime(),
  ];
}

// File descriptors: a literal path, and a dynamic one.
export function rawIO(): void {
  const fd = fs.openSync("/var/log/app.log", "a");
  const buf = Buffer.alloc(16);
  fs.readSync(fd, buf, 0, 16, 0);
  fs.writeSync(fd, "line\n");
  fs.fstatSync(fd);
  fs.closeSync(fd);
}

export function openDynamic(path: string): number {
  return fs.openSync(path, "r");
}

export function openAsync(): void {
  fs.open("/etc/hosts", "r", () => undefined);
}

// Streams: a literal path, and a dynamic one.
export function streams(outPath: string): void {
  fs.createReadStream("/data/in.csv");
  fs.createWriteStream("/data/out.csv");
  fs.createWriteStream(outPath);
}

// One-to-one wrappers carry a syscall. A high-level read does not.
export function plainWrappers(from: string, to: string): void {
  fs.unlinkSync("/tmp/stale");
  fs.renameSync(from, to);
  fs.mkdirSync("/tmp/dir");
  fs.statSync("/tmp/dir");
  fs.readFileSync("/etc/hosts");
}

// The callback forms of the same calls, on a literal descriptor and paths.
export function callbackForms(buf: Buffer): void {
  fs.read(3, buf, 0, 16, 0, () => undefined);
  fs.write(3, "x", () => undefined);
  fs.close(3, () => undefined);
  fs.fstat(3, () => undefined);
  fs.unlink("/tmp/a", () => undefined);
  fs.rename("/tmp/a", "/tmp/b", () => undefined);
  fs.mkdir("/tmp/c", () => undefined);
  fs.stat("/tmp/c", () => undefined);
}

export async function makeDir(): Promise<void> {
  await fsp.mkdir("/tmp/promised");
}

// Servers: the port is never a literal here, so each listens on a dynamic port.
export function serve(port: number): void {
  http.createServer(() => undefined).listen(port);
  https.createServer(() => undefined);
}

// Negative: a project function named kill is not process.kill.
function kill(pid: number): number {
  return pid;
}

export function callLocalKill(): number {
  return kill(1);
}

// Negative: a project class with a postMessage method is not a message channel.
export class Pinger {
  postMessage(msg: string): string {
    return msg;
  }
}

export function ping(): string {
  return new Pinger().postMessage("hi");
}
