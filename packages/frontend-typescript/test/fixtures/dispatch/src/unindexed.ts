import type { Repo } from "./repo.js";

// Implements Repo, but the test does not index this file, so it is never a candidate.
export class Stray implements Repo {
  save(): void {}
}
