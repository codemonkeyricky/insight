// Generates TypeScript types from the JSON Schema files in ../schema.
// Output is committed under src/generated. Run with: pnpm --filter @insight/ir gen
import { compileFromFile } from "json-schema-to-typescript";
import { readdirSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join, basename } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = join(root, "src", "generated");
mkdirSync(outDir, { recursive: true });

const sources = [
  join(root, "schema", "core.schema.json"),
  join(root, "schema", "kind-definition.schema.json"),
  ...readdirSync(join(root, "schema", "facets"))
    .filter((f) => f.endsWith(".schema.json"))
    .map((f) => join(root, "schema", "facets", f)),
];

for (const src of sources) {
  const name = basename(src).replace(/\.schema\.json$/, "");
  const ts = await compileFromFile(src, {
    bannerComment: "/* Generated from the JSON Schema by scripts/generate-types.mjs. Do not edit. */",
    additionalProperties: true,
    unknownAny: true,
    strictIndexSignatures: false,
    $refOptions: {
      resolve: {
        // Map the published $id namespace onto local files so generation never hits the network.
        insight: {
          order: 1,
          canRead: /^https:\/\/insight\.dev\/ir\//,
          read: (file) => readFileSync(join(root, "schema", new URL(file.url).pathname.replace(/^\/ir\//, "").replace(/\.json$/, ".schema.json")), "utf8"),
        },
      },
    },
  });
  writeFileSync(join(outDir, `${name}.ts`), ts);
  console.log(`generated src/generated/${name}.ts`);
}
