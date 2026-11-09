import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { parseArgs } from "../src/command.js";
import { openCommand, parseServeArgs, shouldOpenBrowser } from "../src/serve.js";

describe("parseServeArgs", () => {
  it("uses 127.0.0.1:4317 and opens the browser by default", () => {
    const args = parseServeArgs([]);
    expect(args).toEqual({ paths: [], port: 4317, host: "127.0.0.1", open: true });
  });

  it("reads --port, --host, --home and --no-open", () => {
    const args = parseServeArgs(["--port", "4500", "--host", "0.0.0.0", "--home", "/tmp/h", "--no-open"]);
    expect(args).toMatchObject({ port: 4500, host: "0.0.0.0", home: "/tmp/h", open: false });
  });

  it("resolves each path to an absolute path, and keeps the order", () => {
    const args = parseServeArgs(["/abs/one", "rel/two"]);
    expect(args.paths).toEqual(["/abs/one", resolve("rel/two")]);
  });

  it("rejects a port that is not a number in range", () => {
    expect(() => parseServeArgs(["--port", "abc"])).toThrow(/port number/);
    expect(() => parseServeArgs(["--port", "70000"])).toThrow(/port number/);
    expect(() => parseServeArgs(["--port", "0"])).toThrow(/port number/);
  });

  it("rejects a flag without a value, and an unknown flag", () => {
    expect(() => parseServeArgs(["--host"])).toThrow(/needs a value/);
    expect(() => parseServeArgs(["--home", "--no-open"])).toThrow(/needs a value/);
    expect(() => parseServeArgs(["--bogus"])).toThrow(/unknown option --bogus/);
  });
});

describe("browser opening", () => {
  it("never opens a browser when the output is not a terminal", () => {
    expect(shouldOpenBrowser({ DISPLAY: ":0" }, "linux", false)).toBe(false);
  });

  it("on Linux, opens only when a display is set", () => {
    expect(shouldOpenBrowser({}, "linux", true)).toBe(false);
    expect(shouldOpenBrowser({ DISPLAY: ":0" }, "linux", true)).toBe(true);
    expect(shouldOpenBrowser({ WAYLAND_DISPLAY: "wayland-0" }, "linux", true)).toBe(true);
  });

  it("names the opener for each platform", () => {
    expect(openCommand("http://x", "darwin")).toEqual({ cmd: "open", args: ["http://x"] });
    expect(openCommand("http://x", "linux")).toEqual({ cmd: "xdg-open", args: ["http://x"] });
    expect(openCommand("http://x", "win32")?.cmd).toBe("cmd");
    expect(openCommand("http://x", "freebsd")).toBeUndefined();
  });
});

describe("index --state", () => {
  it("leaves the state folder unset by default, which keeps <path>/.insight", () => {
    expect(parseArgs(["index", "/proj"]).state).toBeUndefined();
  });

  it("reads the folder given to --state", () => {
    expect(parseArgs(["index", "/proj", "--state", "/tmp/st"]).state).toBe("/tmp/st");
  });

  it("rejects --state without a folder", () => {
    expect(() => parseArgs(["index", "/proj", "--state"])).toThrow(/--state needs a folder/);
  });
});
