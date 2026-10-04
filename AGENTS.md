# SuperSearch — VS Code extension

Workspace text search refined by a local Ollama decision model.

## Build / run

- `npm install` — dev deps only (`typescript`, `@types/vscode`, `@types/node`)
- `npm run compile` — TypeScript → `out/`
- `npm run watch` — incremental compile
- Debug: open folder in VS Code/Windsurf, press **F5** (Extension Development Host),
  or run `windsurf --extensionDevelopmentPath=<repo> <workspace-folder>`
- Package + install: `npx --yes @vscode/vsce package --allow-missing-repository`
  then `windsurf --install-extension supersearch-<version>.vsix` (vsce is not a devDep)

## Architecture

- `src/extension.ts` — registers the `supersearch.view` sidebar webview + `supersearch.open` command.
- `src/viewProvider.ts` — sidebar UI (2 inputs: search string + context description),
  orchestrates the pipeline, renders graded results, opens matches at line.
- `src/search.ts` — classic case-insensitive substring search via streaming `ripgrep` JSON,
  reads only files with matches, captures ±`contextLines` (default 50) per match;
  `snippetForModel` trims to fit the model. Searches each workspace root independently.
- `src/ollama.ts` — calls `POST /api/chat` on the decision model; grades each candidate
  A–E (one call per candidate, bounded concurrency). Results are filtered/ranked by grade.

## Ollama decision model (tev1:0.8b)

- Trained decision model: system prompt says "Select exactly one listed option.
  Return only its letter." Baked `num_ctx` is 2050 — we override `options.num_ctx` per request
  and char-cap snippets (`modelContextChars`, default 3500) centered on the match line.
- Grading options presented to it: A exact match … E unrelated.
  `acceptGrades` (default A/B/C) controls which grades appear as results.
- Requests send `think: false`, `temperature: 0`, `keep_alive: 10m` for low latency.

## Gotchas

- Literal NUL bytes cannot be written via the file-edit tools — they arrive as
  raw 0x00. Use `'\0'` escape written via perl/sed if needed (done in `search.ts`).
- `windsurf` CLI accepts `--extensionDevelopmentPath` like `code`.
