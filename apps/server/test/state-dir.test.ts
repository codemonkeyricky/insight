import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { buildServer } from "../src/index.js";
import { chooseStateDir, ownsStateDir, ProjectRegistry } from "../src/registry.js";

const scratch = mkdtempSync(join(tmpdir(), "insight-state-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

function folder(name: string): string {
  const dir = join(scratch, name);
  mkdirSync(dir, { recursive: true });
  return dir;
}

describe("chooseStateDir", () => {
  it("puts a local folder's state under the home", () => {
    const home = join(scratch, "home-new");
    expect(chooseStateDir(home, "abc123", { kind: "path", path: folder("fresh") })).toBe(join(home, "projects", "abc123"));
  });

  it("keeps the legacy state in the folder when that folder already has an index", () => {
    const dir = folder("legacy");
    mkdirSync(join(dir, ".insight"), { recursive: true });
    writeFileSync(join(dir, ".insight", "index.sqlite"), "");
    expect(chooseStateDir(join(scratch, "home-x"), "id1", { kind: "path", path: dir })).toBe(join(dir, ".insight"));
  });

  it("puts a git project's state under the home, even when the checkout has a .insight folder", () => {
    const home = join(scratch, "home-git");
    const source = { kind: "git" as const, url: "https://example.com/r.git", checkout: join(home, "clones", "g1") };
    expect(chooseStateDir(home, "g1", source, () => true)).toBe(join(home, "projects", "g1"));
  });

  it("owns only folders under <home>/projects", () => {
    const home = join(scratch, "home-own");
    expect(ownsStateDir(home, join(home, "projects", "p1"))).toBe(true);
    expect(ownsStateDir(home, join(scratch, "proj", ".insight"))).toBe(false);
    expect(ownsStateDir(home, home)).toBe(false);
  });
});

describe("ProjectRegistry state folders", () => {
  it("gives a newly added folder a state folder under the home", () => {
    const home = join(scratch, "home-reg");
    const reg = new ProjectRegistry(home);
    const rec = reg.add({ path: folder("reg-proj") });
    expect(rec.stateDir).toBe(join(home, "projects", rec.id));
  });

  it("adds a state folder to records saved before the field existed, and keeps the choice", () => {
    const home = join(scratch, "home-old");
    mkdirSync(home, { recursive: true });
    const dir = folder("old-proj");
    writeFileSync(
      join(home, "projects.json"),
      JSON.stringify({
        schema: 1,
        projects: [{ id: "old1", name: "old", addedAt: "2026-01-01T00:00:00.000Z", source: { kind: "path", path: dir }, allowBuildTools: false, status: "idle" }],
      }),
    );
    const reg = new ProjectRegistry(home);
    expect(reg.get("old1")?.stateDir).toBe(join(home, "projects", "old1"));
    const saved = JSON.parse(readFileSync(join(home, "projects.json"), "utf8")) as { projects: { stateDir: string }[] };
    expect(saved.projects[0]?.stateDir).toBe(join(home, "projects", "old1"));
  });
});

describe("deleting a project", () => {
  it("removes its state folder under the home and never the user's folder", async () => {
    const home = join(scratch, "home-del");
    const dir = folder("del-proj");
    writeFileSync(join(dir, "keep.ts"), "export const x = 1;\n");
    const server = await buildServer({ home, autostart: false, webDist: null });
    const rec = server.registry.add({ path: dir });
    mkdirSync(rec.stateDir, { recursive: true });
    writeFileSync(join(rec.stateDir, "index.sqlite"), "");
    const res = await server.app.inject({ method: "DELETE", url: `/api/projects/${rec.id}` });
    expect(res.statusCode).toBe(204);
    expect(existsSync(rec.stateDir)).toBe(false);
    expect(existsSync(join(dir, "keep.ts"))).toBe(true);
    await server.close();
  });

  it("keeps a legacy state folder inside the user's folder", async () => {
    const home = join(scratch, "home-legacy-del");
    const dir = folder("legacy-del");
    mkdirSync(join(dir, ".insight"), { recursive: true });
    writeFileSync(join(dir, ".insight", "index.sqlite"), "");
    const server = await buildServer({ home, autostart: false, webDist: null });
    const rec = server.registry.add({ path: dir });
    const res = await server.app.inject({ method: "DELETE", url: `/api/projects/${rec.id}` });
    expect(res.statusCode).toBe(204);
    expect(existsSync(join(dir, ".insight", "index.sqlite"))).toBe(true);
    await server.close();
  });
});
