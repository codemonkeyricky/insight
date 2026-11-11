# System view

The System view is a mode of the Arch tab (the System / Packages toggle, System by default). It answers "what does this
code talk to?" for the current explorer scope: the components inside the scope, the routes they serve, the outside
systems they reach and the verbs between them.

![The hosted package at packages/hosted/src](screenshots/system-view/07-edge-selected.png)

## What it shows

- **Components** are the children of the scope: packages when the scope holds `package.json` roots, else its folders and
  files. A card shows the file and function counts and up to four route chips (`POST /api/index`, then "+N more").
- **Columns** run left to right by stage: entries first, then what they call, and so on. The last column holds the
  **outside systems**, grouped by category (Services, Stores, This app's API, Processes, Filesystem, Config, Workers).
- **Edges** are curves from a card side to a card side, with a verb pill (`writes · PUT ×2`, `runs · git`). Writes are
  accent coloured, runs and spawns dashed, inferred edges dotted and faded. Hover a card or an edge to light its neighbours;
  click to open the side panel with the sites (`file:line`, each with a link to the code and to the function's Flow chart).
  Double-click a component, or press Open in the panel, to make it the scope.
- The scope is computed in the page from the project model (`api.getSystem`), so the demo and hosted builds show it too.

## Fact rules

The model is `systemModel(model, scope, { tests })` in `packages/model/src/system.ts`. A scope is a closed world: a fact
that leaves it is not drawn.

| Fact (IR kind) | Becomes |
| --- | --- |
| `effects.net.connect` (fetch, http requests) | A request to a host. A known host is a catalog service, an unknown host is its own service named by the host. A relative URL is matched to a route served inside the scope first (same method, `:param` as a wildcard) and then draws a `requests` edge to that component. The verb follows the method: GET and HEAD read, the rest write. |
| `effects.net.serve` (routes) | A route chip on the component that serves it, and the target of matching relative requests. Frameworks and exported Vercel-style handlers are both routes. |
| `effects.fs.read`, `effects.fs.write` | `reads` or `writes` to the Filesystem external. |
| `effects.proc.exec` | `runs` to a Process external named by the program (`git`, `tar`) or "dynamic command". |
| `effects.env.read` | `reads` to the Config external, labelled with the variable count, the names in its sub line. |
| `effects.message.post` | A `posts` edge (`postMessage`) to the "Peer (postMessage)" worker external. |
| calls, references, spawns | Edges between components, with candidates counted as inferred. Imports with no call joining the two components draw an inferred edge. |

Edges are one per pair of nodes and verb: facts are merged and the label counts them (`PUT ×5`). The edge keeps up to 20
sites and the full count. An edge is exact unless any of its facts is inferred.

### Services catalog

`packages/model/src/services.ts` maps hosts to named services: GitHub API, GitHub codeload, GitHub raw, Cloudflare API
(with path rules: `/storage/kv/` is Cloudflare KV, `/r2/` is Cloudflare R2), Cloudflare R2 (`*.r2.cloudflarestorage.com`),
Cloudflare Worker (`*.workers.dev`), Vercel API and the npm registry. A host matches exactly or by suffix. Add a row to
`SERVICES` to name another one.

### Stages and entries

An entry is a component that serves a route or holds a program entry (a function named `main`, or a CLI or main file).
Another component that nothing calls starts column 0 only when it has facts going out. Columns come from a breadth-first
walk over calls, requests and spawns from those entries. A component none of them reaches goes in a last column.
Components with no functions, route or fact (a lone `package.json`, lockfiles) are dropped.

### Tests hidden by default

Tests, fixtures and samples follow the Flow tab's noise rule and are left out. Turn on "Show tests" in the toolbar to
include them. A scope that is itself inside a test folder shows its tests without the switch.

### Pass-through descend

When a scope holds exactly one folder of code (`packages/hosted` holds `src`), the view shows that folder's children and
the toolbar notes `via src`. It repeats for up to eight levels, so a chain of single folders does not give a one-card view.

## Layout

The geometry is `layoutSystem` in `apps/web/src/arch/system-layout.ts`, pure and deterministic.

- Cards stack in columns. A short edge is one cubic curve inside the gap between two columns. An edge that spans more than
  one column and whose straight curve would cross a card instead leaves into the gap, runs along a lane above or below all
  the cards and enters the gap before its target, so no edge goes through a card that is not one of its ends.
- Verb pills sit on their curve, slid along it (0.3 to 0.7 of its length) and then offset until they touch no card and no
  other pill. Above 30 edges the pills are shown only for the hovered or selected node's edges (the others are lines).
- The first view is fitted to the stage but never smaller than 0.56, so a card title (18 px) renders at 10 px or more. A
  wider graph is panned (drag, wheel zoom, `-`/`+`, Fit). Expand fills the window (Esc leaves). The stage is as tall as the
  window leaves room for, at least 60vh.

Tests: `apps/web/test/systemLayout.test.tsx` (no pill overlaps another pill or a card, no edge sample point inside a
non-endpoint card, for a hosted-like and a dense 20-component, 60-edge fixture) and `packages/model/test/system*.test.ts`.

## Known limits

- Exported Vercel handlers (`export async function POST`) have no path in code, so the route chip reads `POST handler`.
- A `fetch` matched to a route by name only (no URL to match) is inferred and drawn faded.
- A dynamic host is followed through one `const` hop (same file or enclosing scope). A host built further away is an
  unknown service.
- The hosted featured index holds the snapshot it was seeded from. New facts show in the hosted site only after a
  re-index (`scripts/hosted-seed.mjs`, or the index action) following the deploy.
- Components far apart still draw dense bundles of edges at root scope. Pick a narrower scope or hover a card to read them.
