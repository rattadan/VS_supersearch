export type Grade = 'A' | 'B' | 'C' | 'D' | 'E';

const GRADES: Grade[] = ['A', 'B', 'C', 'D', 'E'];

export interface OllamaConfig {
  baseUrl: string;
  model: string;
  numCtx: number;
}

export class OllamaUnavailableError extends Error { }

export async function listModels(baseUrl: string): Promise<string[]> {
  let res: Response;
  try {
    res = await fetch(`${baseUrl.replace(/\/$/, '')}/api/tags`);
  } catch (err) {
    throw new OllamaUnavailableError(
      `Cannot reach Ollama at ${baseUrl}: ${err instanceof Error ? err.message : String(err)}`
    );
  }
  if (!res.ok) {
    throw new Error(`Ollama returned HTTP ${res.status}: ${await res.text()}`);
  }
  const data = (await res.json()) as { models?: Array<{ name?: string }> };
  return (data.models ?? []).map(model => model.name).filter((name): name is string => Boolean(name));
}

interface ChatResponse {
  message?: { content?: string };
  error?: string;
}

/**
 * Ask the decision model to grade how well one code snippet matches the
 * user's described context. Returns a single letter grade A-E:
 *   A perfect match, B likely, C possible, D probably not, E definitely not.
 */
export async function gradeCandidate(
  cfg: OllamaConfig,
  query: string,
  context: string,
  filePath: string,
  snippet: string,
  signal?: AbortSignal
): Promise<Grade> {
  const prompt = [
    `Task: The user searches the codebase for "${query}" and describes the intended context as: "${context}".`,
    '',
    'Grade how well the code snippet below matches that described context.',
    '',
    '<state>',
    `File: ${filePath}`,
    snippet,
    '</state>',
    '',
    'Options:',
    'A) The snippet is exactly the kind of code described',
    'B) The snippet is very likely the code described',
    'C) The snippet might be the code described',
    'D) The snippet is probably not the code described',
    'E) The snippet is unrelated to the description'
  ].join('\n');

  let res: Response;
  try {
    res = await fetch(`${cfg.baseUrl}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal,
      body: JSON.stringify({
        model: cfg.model,
        stream: false,
        think: false,
        keep_alive: '10m',
        options: { num_ctx: cfg.numCtx, temperature: 0 },
        messages: [{ role: 'user', content: prompt }]
      })
    });
  } catch (err) {
    throw new OllamaUnavailableError(
      `Cannot reach Ollama at ${cfg.baseUrl}: ${err instanceof Error ? err.message : String(err)}`
    );
  }
  if (!res.ok) {
    throw new Error(`Ollama returned HTTP ${res.status}: ${await res.text()}`);
  }
  const data = (await res.json()) as ChatResponse;
  if (data.error) {
    throw new Error(`Ollama error: ${data.error}`);
  }
  const content = data.message?.content?.trim() ?? '';
  const letter = content.match(/[A-E]/i)?.[0]?.toUpperCase() as Grade | undefined;
  if (!letter || !GRADES.includes(letter)) {
    return 'E'; // unparsable answer -> treat as no match
  }
  return letter;
}

/** Run tasks with a bounded concurrency pool. */
export async function mapPool<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
  isCancelled: () => boolean,
  onEach?: () => void
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length && !isCancelled()) {
      const i = next++;
      results[i] = await fn(items[i]);
      onEach?.();
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}
