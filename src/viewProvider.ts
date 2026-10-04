import * as vscode from 'vscode';
import { searchWorkspace, snippetForModel, SearchCandidate } from './search';
import { gradeCandidate, mapPool, OllamaUnavailableError, Grade } from './ollama';

interface GradedCandidate extends SearchCandidate {
  grade: Grade;
}

export class SuperSearchViewProvider implements vscode.WebviewViewProvider {
  private view?: vscode.WebviewView;
  private generation = 0;

  constructor(private readonly extensionUri: vscode.Uri) {}

  resolveWebviewView(webviewView: vscode.WebviewView): void {
    this.view = webviewView;
    webviewView.webview.options = { enableScripts: true };
    webviewView.webview.html = this.renderHtml(webviewView.webview);

    webviewView.webview.onDidReceiveMessage(msg => {
      if (msg.type === 'search') {
        void this.runSearch(String(msg.query ?? ''), String(msg.context ?? ''));
      } else if (msg.type === 'cancel') {
        this.generation++;
        this.postStatus('Cancelled.');
      } else if (msg.type === 'open') {
        void this.openAt(String(msg.file), Number(msg.line));
      }
    });
  }

  private cfg() {
    const c = vscode.workspace.getConfiguration('supersearch');
    return {
      baseUrl: c.get<string>('ollamaUrl', 'http://localhost:11434').replace(/\/$/, ''),
      model: c.get<string>('model', 'tev1:0.8b'),
      numCtx: 8192,
      contextLines: c.get<number>('contextLines', 50),
      modelContextChars: c.get<number>('modelContextChars', 3500),
      maxCandidates: c.get<number>('maxCandidates', 40),
      concurrency: Math.max(1, c.get<number>('concurrency', 2)),
      excludeGlob: c.get<string>('excludeGlob', ''),
      acceptGrades: new Set(c.get<string[]>('acceptGrades', ['A', 'B', 'C']))
    };
  }

  private async runSearch(query: string, context: string): Promise<void> {
    if (!query.trim()) {
      this.postStatus('Enter a search string.');
      return;
    }
    if (!context.trim()) {
      this.postStatus('Enter a context description.');
      return;
    }
    if (!vscode.workspace.workspaceFolders?.length) {
      this.postStatus('No workspace folder open.');
      return;
    }

    const gen = ++this.generation;
    const cancelled = () => gen !== this.generation;
    const cfg = this.cfg();

    try {
      this.postResults([], true);
      this.postStatus(`Searching workspace for "${query}"…`);

      const all = await searchWorkspace(query, cfg.contextLines, cfg.excludeGlob, cancelled,
        (scanned, found) => !cancelled() && this.postStatus(`Scanning… ${scanned} files, ${found} matches`));

      if (cancelled()) { return; }
      if (!all.length) {
        this.postStatus(`No matches for "${query}".`);
        return;
      }

      const candidates = all.slice(0, cfg.maxCandidates);
      this.postStatus(
        `${all.length} matches found — grading ${candidates.length} with ${cfg.model}…`
      );

      let done = 0;
      const grades = await mapPool(
        candidates,
        cfg.concurrency,
        c => gradeCandidate(cfg, query, context, c.filePath,
          snippetForModel(c, cfg.modelContextChars)),
        cancelled,
        () => {
          done++;
          if (!cancelled()) {
            this.postStatus(`${all.length} matches — grading ${done}/${candidates.length}…`);
          }
        }
      );

      if (cancelled()) { return; }

      const graded: GradedCandidate[] = candidates
        .map((c, i) => ({ ...c, grade: grades[i] }))
        .filter(c => cfg.acceptGrades.has(c.grade))
        .sort((a, b) => a.grade.localeCompare(b.grade));

      this.postStatus(
        `${graded.length} relevant of ${all.length} matches ` +
        `(graded A–E, showing ${[...cfg.acceptGrades].join('/')}).`
      );
      this.postResults(graded);
    } catch (err) {
      if (cancelled()) { return; }
      if (err instanceof OllamaUnavailableError) {
        this.postStatus(`Ollama unavailable — is it running? ${err.message}`);
      } else {
        this.postStatus(`Error: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  private async openAt(file: string, line: number): Promise<void> {
    const folders = vscode.workspace.workspaceFolders;
    if (!folders) { return; }
    const uri = vscode.Uri.joinPath(folders[0].uri, file);
    const doc = await vscode.workspace.openTextDocument(uri);
    const editor = await vscode.window.showTextDocument(doc);
    const pos = new vscode.Position(line, 0);
    editor.selection = new vscode.Selection(pos, pos);
    editor.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.InCenter);
  }

  private postStatus(text: string): void {
    this.view?.webview.postMessage({ type: 'status', text });
  }

  private postResults(items: GradedCandidate[], clear = false): void {
    this.view?.webview.postMessage({
      type: 'results',
      clear,
      items: items.map(c => ({
        file: c.filePath,
        line: c.line,
        grade: c.grade,
        preview: c.preview,
        snippet: c.snippet
      }))
    });
  }

  private renderHtml(webview: vscode.Webview): string {
    const nonce = String(Date.now());
    const csp = `default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';`;
    return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<style>
  body { font-family: var(--vscode-font-family); padding: 8px; color: var(--vscode-foreground); }
  label { display:block; font-size: 11px; margin: 8px 0 3px; opacity: .8; }
  input {
    width: 100%; box-sizing: border-box; padding: 5px 7px;
    background: var(--vscode-input-background); color: var(--vscode-input-foreground);
    border: 1px solid var(--vscode-input-border, transparent); border-radius: 2px;
  }
  input:focus { outline: 1px solid var(--vscode-focusBorder); }
  .row { display: flex; gap: 6px; margin-top: 10px; }
  button {
    flex: 1; padding: 6px; border: none; cursor: pointer;
    background: var(--vscode-button-background); color: var(--vscode-button-foreground);
  }
  button.secondary { background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); }
  button:hover { filter: brightness(1.1); }
  #status { font-size: 11px; opacity: .8; margin: 10px 0; min-height: 14px; white-space: pre-wrap; }
  .hit {
    border: 1px solid var(--vscode-panel-border, transparent); border-radius: 3px;
    margin-bottom: 6px; cursor: pointer; overflow: hidden;
  }
  .hit:hover { border-color: var(--vscode-focusBorder); }
  .hit-head { display: flex; align-items: center; gap: 6px; padding: 4px 7px; font-size: 11px; }
  .grade {
    flex: none; width: 16px; height: 16px; border-radius: 3px; text-align: center;
    line-height: 16px; font-weight: bold; font-size: 10px; color: #fff;
  }
  .gA { background: #2da44e; } .gB { background: #54ae4f; } .gC { background: #bf8700; }
  .gD { background: #d4a72c; } .gE { background: #888; }
  .loc { color: var(--vscode-textLink-foreground); }
  .preview { opacity: .7; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .hit pre {
    margin: 0; padding: 6px 8px; font-size: 11px; max-height: 140px; overflow: auto;
    background: var(--vscode-textCodeBlock-background, rgba(128,128,128,.1));
    border-top: 1px solid var(--vscode-panel-border, transparent);
    display: none; white-space: pre;
  }
  .hit.expanded pre { display: block; }
</style>
</head>
<body>
  <label for="q">Search string</label>
  <input id="q" type="text" placeholder='e.g. Liq' autofocus>
  <label for="ctx">Context description</label>
  <input id="ctx" type="text" placeholder='e.g. A button with label'>
  <div class="row">
    <button id="go">Search</button>
    <button id="stop" class="secondary">Cancel</button>
  </div>
  <div id="status"></div>
  <div id="results"></div>
<script nonce="${nonce}">
  const vscode = acquireVsCodeApi();
  const $ = id => document.getElementById(id);
  const esc = s => s.replace(/[&<>]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;'}[c]));

  function submit() {
    vscode.postMessage({ type: 'search', query: $('q').value, context: $('ctx').value });
  }
  $('go').onclick = submit;
  $('stop').onclick = () => vscode.postMessage({ type: 'cancel' });
  $('ctx').addEventListener('keydown', e => { if (e.key === 'Enter') submit(); });
  $('q').addEventListener('keydown', e => { if (e.key === 'Enter') $('ctx').focus(); });

  window.addEventListener('message', e => {
    const m = e.data;
    if (m.type === 'status') { $('status').textContent = m.text; }
    if (m.type === 'results') {
      if (m.clear) { $('results').innerHTML = ''; }
      for (const it of m.items) {
        const div = document.createElement('div');
        div.className = 'hit';
        div.innerHTML =
          '<div class="hit-head">' +
            '<span class="grade g' + it.grade + '">' + it.grade + '</span>' +
            '<span class="loc">' + esc(it.file) + ':' + (it.line + 1) + '</span>' +
          '</div>' +
          '<div class="hit-head preview">' + esc(it.preview) + '</div>' +
          '<pre>' + esc(it.snippet) + '</pre>';
        div.querySelector('.loc').onclick = ev => {
          ev.stopPropagation();
          vscode.postMessage({ type: 'open', file: it.file, line: it.line });
        };
        div.onclick = () => div.classList.toggle('expanded');
        $('results').appendChild(div);
      }
    }
  });
</script>
</body>
</html>`;
  }
}
