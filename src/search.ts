import * as vscode from 'vscode';

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

const MAX_FILE_BYTES = 512 * 1024;
const HARD_MATCH_CAP = 500;

function isProbablyBinary(text: string): boolean {
  return text.includes('\0');
}

export async function searchWorkspace(
  query: string,
  contextLines: number,
  excludeGlob: string,
  isCancelled: () => boolean,
  onProgress?: (scanned: number, found: number) => void
): Promise<SearchCandidate[]> {
  const files = await vscode.workspace.findFiles('**/*', excludeGlob, 10000);
  const candidates: SearchCandidate[] = [];
  const needle = query.toLowerCase();

  for (const uri of files) {
    if (isCancelled() || candidates.length >= HARD_MATCH_CAP) {
      break;
    }
    let text: string;
    try {
      const stat = await vscode.workspace.fs.stat(uri);
      if (stat.size > MAX_FILE_BYTES) {
        continue;
      }
      const bytes = await vscode.workspace.fs.readFile(uri);
      text = Buffer.from(bytes).toString('utf8');
    } catch {
      continue;
    }
    if (isProbablyBinary(text)) {
      continue;
    }

    const lines = text.split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      const col = lines[i].toLowerCase().indexOf(needle);
      if (col === -1) {
        continue;
      }
      const start = Math.max(0, i - contextLines);
      const end = Math.min(lines.length - 1, i + contextLines);
      const width = String(end + 1).length;
      const snippetLines: string[] = [];
      for (let j = start; j <= end; j++) {
        const marker = j === i ? '>>>' : '   ';
        snippetLines.push(`${marker} ${String(j + 1).padStart(width)} | ${lines[j]}`);
      }
      candidates.push({
        uri,
        filePath: vscode.workspace.asRelativePath(uri),
        line: i,
        column: col,
        contextStart: start,
        contextEnd: end,
        snippet: snippetLines.join('\n'),
        preview: lines[i].trim()
      });
      if (candidates.length >= HARD_MATCH_CAP) {
        break;
      }
    }
    onProgress?.(files.indexOf(uri) + 1, candidates.length);
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
