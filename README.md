# SuperSearch

A VS Code extension that combines classic workspace text search with a local
Ollama decision model to find the match you *actually* meant.

Many matches may contain your search string — SuperSearch sends each match
(with ±50 lines of surrounding code) to a local decision model
(`tev1:0.8b` by default) which grades how well it fits the context you
described. Results are filtered and ranked by grade.

## How it works

1. You provide two inputs in the sidebar panel:
   - **Search string** — the literal text to find (e.g. `Liq`)
   - **Context description** — what you're looking for (e.g. `A button with label`)
2. SuperSearch does a classic case-insensitive substring search across the
   workspace and captures ±`contextLines` (default 50) around every match.
3. Each candidate is sent to the Ollama decision model, which returns a
   letter grade:
   - **A** — exactly the kind of code described
   - **B** — very likely
   - **C** — possible
   - **D** — probably not
   - **E** — unrelated
4. Results are shown ranked by grade (A/B/C by default). Click a result to
   open the file at that line; click the card body to expand the full snippet.

## Requirements

- [Ollama](https://ollama.com) running locally (default `http://localhost:11434`)
- A decision model, e.g. `tev1:0.8b` — check with `ollama list`
- VS Code ≥ 1.85

## Install

### Option 1 — Extension Development Host (development)

```bash
cd supersearch
npm install
npm run compile
code --extensionDevelopmentPath=$PWD <folder-you-want-to-search>
```

Or open this folder in VS Code and press **F5**.

In the new window, click the **SuperSearch** icon in the activity bar.

### Option 2 — Package and install as .vsix (permanent)

```bash
cd supersearch
npm install
npm install -g @vscode/vsce   # or: npx @vscode/vsce package
vsce package                  # produces supersearch-0.0.1.vsix
```

Then install it:

```bash
# VS Code
code --install-extension supersearch-0.0.1.vsix


Or in the UI: Extensions view → `⋯` menu → **Install from VSIX…**

### Option 3 — Symlink into the extensions directory

```bash
cd supersearch
npm install && npm run compile
ln -s "$PWD" ~/.vscode/extensions/local.supersearch-0.0.1


Restart the editor.

## Usage

1. Open a workspace folder.
2. Click the **SuperSearch** icon in the activity bar (or run
   `SuperSearch: Open Panel` from the command palette).
3. Enter the search string and a context description, press **Search**
   (or Enter in the context field).
4. Wait while matches are graded — progress is shown in the panel.
5. Click a result to jump to it.

## Settings

| Setting | Default | Description |
|---|---|---|
| `supersearch.ollamaUrl` | `http://localhost:11434` | Ollama server URL |
| `supersearch.model` | `tev1:0.8b` | Decision model name |
| `supersearch.contextLines` | `50` | Context lines captured around each match |
| `supersearch.modelContextChars` | `3500` | Max snippet chars sent to the model (match-centered) |
| `supersearch.maxCandidates` | `40` | Max raw matches sent to the model |
| `supersearch.concurrency` | `2` | Parallel decision requests |
| `supersearch.excludeGlob` | `**/{node_modules,.git,…}/**` | Files excluded from search |
| `supersearch.acceptGrades` | `["A","B","C"]` | Grades shown in results |

## Tips

- Be specific in the context description: `"React component rendering a table"`
  filters better than `"table"`.
- If grading feels slow on large result sets, lower `maxCandidates`.
- The first grading call loads the model into memory (~few seconds); later
  calls reuse it for 10 minutes.
