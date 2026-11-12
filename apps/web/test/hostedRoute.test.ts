import { describe, expect, it } from "vitest";
import { parseRoute } from "../src/router";

const SHA = "c".repeat(40);

describe("hosted routes", () => {
  it("reads the latest index of a repository", () => {
    expect(parseRoute("#/gh/codemonkeyricky/insight")).toEqual({ name: "hosted", owner: "codemonkeyricky", repo: "insight" });
  });

  it("reads the index at one commit", () => {
    expect(parseRoute(`#/gh/codemonkeyricky/insight@${SHA}`)).toEqual({ name: "hosted", owner: "codemonkeyricky", repo: "insight", sha: SHA });
  });

  it("reads a branch as a ref, percent-decoded, and keeps the case", () => {
    expect(parseRoute("#/gh/o/r@main")).toEqual({ name: "hosted", owner: "o", repo: "r", ref: "main" });
    expect(parseRoute("#/gh/o/r@Release-1.2")).toEqual({ name: "hosted", owner: "o", repo: "r", ref: "Release-1.2" });
    expect(parseRoute("#/gh/o/r@build%2Finsight-plan")).toEqual({ name: "hosted", owner: "o", repo: "r", ref: "build/insight-plan" });
    expect(parseRoute("#/gh/o/r@build/insight-plan")).toEqual({ name: "hosted", owner: "o", repo: "r", ref: "build/insight-plan" });
    expect(parseRoute("#/gh/o/r@abc")).toEqual({ name: "hosted", owner: "o", repo: "r", ref: "abc" });
  });

  it("reads a 40-hex ref as a commit, in lowercase", () => {
    expect(parseRoute(`#/gh/o/r@${SHA.toUpperCase()}`)).toEqual({ name: "hosted", owner: "o", repo: "r", sha: SHA });
  });

  it("refuses a bad ref", () => {
    expect(parseRoute("#/gh/o/r@a/../b")).toEqual({ name: "unknown" });
    expect(parseRoute("#/gh/o/r@a%20b")).toEqual({ name: "unknown" });
    expect(parseRoute("#/gh/o/r@/x")).toEqual({ name: "unknown" });
  });

  it("keeps a dotted and hyphenated repository name whole", () => {
    expect(parseRoute("#/gh/my-org/socket.io")).toEqual({ name: "hosted", owner: "my-org", repo: "socket.io" });
    expect(parseRoute(`#/gh/my-org/node-red.js@${SHA}`)).toEqual({ name: "hosted", owner: "my-org", repo: "node-red.js", sha: SHA });
  });

  it("lowercases the names it reads", () => {
    expect(parseRoute("#/gh/Owner/Repo")).toEqual({ name: "hosted", owner: "owner", repo: "repo" });
  });

  it("refuses a malformed sha, an empty sha, or a missing repository", () => {
    expect(parseRoute("#/gh/o/r@a b")).toEqual({ name: "unknown" });
    expect(parseRoute("#/gh/o/r@")).toEqual({ name: "unknown" });
    expect(parseRoute("#/gh/o")).toEqual({ name: "unknown" });
    expect(parseRoute("#/gh/o/r/extra")).toEqual({ name: "unknown" });
  });

  it("leaves the project routes as they were", () => {
    expect(parseRoute("#/projects/gh~o~r~" + SHA + "/view/flow")).toMatchObject({ name: "workspace", id: `gh~o~r~${SHA}`, tab: "flow" });
  });
});
