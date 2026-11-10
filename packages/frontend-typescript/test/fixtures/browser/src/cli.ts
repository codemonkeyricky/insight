import { meshThickness } from "./verify/mesh.js";

function run(argv: string[]): number {
  return meshThickness(argv.length);
}

run(process.argv);
