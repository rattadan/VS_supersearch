import * as vscode from 'vscode';
import { spawn, ChildProcess } from 'node:child_process';
import { createInterface } from 'node:readline';
import { platform } from 'node:process';

export interface SearchCandidate {
  uri: vscode.Uri;
  filePath: string;
  line: number; // 0-based line of the match
  column: number;
  contextStart: number; // 0-based, inclusive
  contextEnd: number; // 0-based, inclusive
  snippet: string; // full snippet incl. line numbers, match marked with '>>>'
  preview: string; // the matched line text, trimmed
}

const HARD_MATCH_CAP = 500;

interface RipgrepMatch {
  type?: string;
  data?: {
    path?: { text?: string };
    line_number?: number;
    submatches?: Array<{ start?: number }>;
  };
}

function ripgrepCommand(): string {
  return platform === 'win32' ? 'rg.exe' : 'rg';
}

function parseExcludeGlobs(excludeGlob: string): string[] {
  return excludeGlob
    .split(',')
    .map(glob => glob.trim())
    .filter(Boolean);
}

function buildRipgrepArgs(query: string, excludeGlob: string): string[] {
  const args = [
    '--json',
    '--line-number',
    '--column',
    '--no-heading',
    '--color=never',
    '--fixed-strings',
    '--ignore-case',
    '--hidden',
    '--glob', '!.git',
    '--glob', '!node_modules'
  ];
  for (const glob of parseExcludeGlobs(excludeGlob)) {
    args.push('--glob', `!${glob}`);
  }
  return [...args, '--', query, '.'];
}

function contextCandidate(
  uri: vscode.Uri,
  text: string,
  line: number,
  column: number,
  contextLines: number
): SearchCandidate {
  const lines = text.split(/\r?\n/);
  const safeLine = Math.min(Math.max(0, line), Math.max(0, lines.length - 1));
  const start = Math.max(0, safeLine - contextLines);
  const end = Math.min(lines.length - 1, safeLine + contextLines);
  const width = String(end + 1).length;
  const snippetLines: string[] = [];
  for (let j = start; j <= end; j++) {
    const marker = j === safeLine ? '>>>' : '   ';
    snippetLines.push(`${marker} ${String(j + 1).padStart(width)} | ${lines[j]}`);
  }
  return {
    uri,
    filePath: vscode.workspace.asRelativePath(uri),
    line: safeLine,
    column,
    contextStart: start,
    contextEnd: end,
    snippet: snippetLines.join('\n'),
    preview: lines[safeLine]?.trim() ?? ''
  };
}

async function searchRoot(
  root: vscode.Uri,
  query: string,
  contextLines: number,
  excludeGlob: string,
  candidates: SearchCandidate[],
  fileCache: Map<string, Promise<string>>,
  isCancelled: () => boolean,
  onProgress?: (scanned: number, found: number) => void
): Promise<void> {
  const rootPath = root.fsPath;
  const child: ChildProcess = spawn(
    ripgrepCommand(),
    buildRipgrepArgs(query, excludeGlob),
    { cwd: rootPath, stdio: ['ignore', 'pipe', 'pipe'] }
  );
  if (!child.stdout || !child.stderr) {
    child.kill();
    return;
  }
  const output = createInterface({ input: child.stdout });
  const terminate = () => {
    if (!child.killed) {
      child.kill();
    }
  };
  const cancellationTimer = setInterval(() => {
    if (isCancelled() || candidates.length >= HARD_MATCH_CAP) {
      terminate();
    }
  }, 50);
  let scannedFiles = 0;

  try {
    for await (const rawLine of output) {
      if (isCancelled() || candidates.length >= HARD_MATCH_CAP) {
        terminate();
        break;
      }
      let match: RipgrepMatch;
      try {
        match = JSON.parse(rawLine) as RipgrepMatch;
      } catch {
        continue;
      }
      if (match.type !== 'match' || !match.data?.path?.text || !match.data.line_number) {
        continue;
      }

      const absolutePath = vscode.Uri.joinPath(root, match.data.path.text).fsPath;
      const uri = vscode.Uri.file(absolutePath);
      const line = match.data.line_number - 1;
      const column = Math.max(0, match.data.submatches?.[0]?.start ?? 0);
      let fileText = fileCache.get(absolutePath);
      if (!fileText) {
        fileText = Promise.resolve(vscode.workspace.fs.readFile(uri))
          .then(bytes => Buffer.from(bytes).toString('utf8'));
        fileCache.set(absolutePath, fileText);
        scannedFiles++;
      }
      try {
        const text = await fileText;
        if (text.includes('\0')) {
          continue;
        }
        candidates.push(contextCandidate(uri, text, line, column, contextLines));
        onProgress?.(scannedFiles, candidates.length);
      } catch {
        // The file may have changed or become inaccessible while rg was running.
      }
    }
    await new Promise<void>(resolve => child.once('close', () => resolve()));
  } finally {
    clearInterval(cancellationTimer);
    output.close();
    child.stderr.resume();
    if (!child.killed && (isCancelled() || candidates.length >= HARD_MATCH_CAP)) {
      terminate();
    }
  }
}

export async function searchWorkspace(
  query: string,
  contextLines: number,
  excludeGlob: string,
  isCancelled: () => boolean,
  onProgress?: (scanned: number, found: number) => void
): Promise<SearchCandidate[]> {
  const candidates: SearchCandidate[] = [];
  const fileCache = new Map<string, Promise<string>>();
  for (const folder of vscode.workspace.workspaceFolders ?? []) {
    if (isCancelled() || candidates.length >= HARD_MATCH_CAP) {
      break;
    }
    await searchRoot(folder.uri, query, contextLines, excludeGlob, candidates, fileCache, isCancelled, onProgress);
  }
  return candidates;
}

/** Trim a candidate's snippet around the match line to at most maxChars. */
export function snippetForModel(c: SearchCandidate, maxChars: number): string {
  if (c.snippet.length <= maxChars) {
    return c.snippet;
  }
  const lines = c.snippet.split('\n');
  const matchIdx = lines.findIndex(l => l.startsWith('>>>'));
  const head = '… (truncated) …';
  // Keep a symmetric window of lines around the match that fits the budget.
  let lo = matchIdx;
  let hi = matchIdx;
  let size = lines[matchIdx].length + head.length * 2;
  while (size < maxChars && (lo > 0 || hi < lines.length - 1)) {
    if (lo > 0) {
      size += lines[--lo].length + 1;
    }
    if (size >= maxChars) {
      break;
    }
    if (hi < lines.length - 1) {
      size += lines[++hi].length + 1;
    }
  }
  const kept = lines.slice(lo, hi + 1);
  if (lo > 0) {
    kept.unshift(head);
  }
  if (hi < lines.length - 1) {
    kept.push(head);
  }
  return kept.join('\n');
}
