import { describe, expect, it } from "vitest";
import { openDb } from "../src/db.js";

describe("openDb", () => {
  it("creates the items table", () => {
    const db = openDb();
    expect(db.prepare("select count(*) as n from items").get()).toBeTruthy();
  });
});
