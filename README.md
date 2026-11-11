# Insight

Insight shows how code runs. It indexes a project's source (its functions, types, calls, threads and coroutines,
and its package layout), then serves the result in a web app with a flow view, an architecture view, findings,
and a comparison between two commits. Everything runs on your machine. Projects are read from disk, and nothing
is sent anywhere.

## Requirements

- Node.js 22 or later (see `engines` in `package.json` and `.nvmrc`)
- pnpm

## Run offline

```sh
pnpm install
pnpm -r --workspace-concurrency=1 build
pnpm insight serve /path/to/project
```

The server listens on `http://127.0.0.1:4317` and the browser opens on it. Use `--port`, `--host`, `--home` and
`--no-open` to change that. `pnpm start` starts the server with no project, so you can add projects in the UI.

## Adding projects

In the Projects page, add a local folder by its path, or a git URL. A folder is indexed in place and is never
written to. A git URL is cloned into the Insight home, and each later run fetches it. If the fetch fails, for
example offline, the last clone is indexed and a warning appears in the run log.

Indexing is on demand. A project is indexed when you add it and when you press Re-index. The server does not
re-index on its own: nothing runs at startup or on a timer.

## Where data lives

- `INSIGHT_HOME` (default `~/.insight`) holds `projects.json`, the git clones, and the state of each project
  under `projects/<id>/`.
- A local folder that was indexed before this layout keeps its state in `<folder>/.insight`.
- Per-project plugins (`<folder>/.insight/plugins`) and lens settings (`<folder>/.insight/lenses`) are read from the folder.

## CLI

```sh
pnpm insight index /path/to/project [--state <dir>] [--full] [--allow-build-tools] [--json] [--quiet]
```

`index` writes the state to `<path>/.insight`, or to `--state <dir>` when given.

## Supported languages

TypeScript and JavaScript, C and C++, Bazel (`BUILD`, `.bzl`), and CMake.

## Demo

A static demo of the web app, with captured data, is at https://arch-insight.vercel.app.
