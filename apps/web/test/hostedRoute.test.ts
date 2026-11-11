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

  it("keeps a dotted and hyphenated repository name whole", () => {
    expect(parseRoute("#/gh/my-org/socket.io")).toEqual({ name: "hosted", owner: "my-org", repo: "socket.io" });
    expect(parseRoute(`#/gh/my-org/node-red.js@${SHA}`)).toEqual({ name: "hosted", owner: "my-org", repo: "node-red.js", sha: SHA });
  });

  it("lowercases the names it reads", () => {
    expect(parseRoute("#/gh/Owner/Repo")).toEqual({ name: "hosted", owner: "owner", repo: "repo" });
  });

  it("refuses a malformed sha, an empty sha, or a missing repository", () => {
    expect(parseRoute("#/gh/o/r@abc")).toEqual({ name: "unknown" });
    expect(parseRoute("#/gh/o/r@")).toEqual({ name: "unknown" });
    expect(parseRoute("#/gh/o")).toEqual({ name: "unknown" });
    expect(parseRoute("#/gh/o/r/extra")).toEqual({ name: "unknown" });
  });

  it("leaves the project routes as they were", () => {
    expect(parseRoute("#/projects/gh~o~r~" + SHA + "/view/flow")).toMatchObject({ name: "workspace", id: `gh~o~r~${SHA}`, tab: "flow" });
  });
});
