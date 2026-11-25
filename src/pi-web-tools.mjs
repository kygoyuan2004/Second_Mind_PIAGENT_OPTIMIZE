import { nativeTool } from './pi-vault-tools.mjs';
import { RuntimeWebSearchClient, RuntimeWebExtractFallback } from './runtime-services.mjs';
import { SafeWebReader } from './safe-web-reader.mjs';

export async function createPiWebTools(task, webSearch, options = {}) {
  if (!task.webSearch || task.learningReview || !webSearch?.enabled) return { tools: [], close() {} };
  const snapshot = { webSearch };
  const registry = { runtimeSnapshot: () => snapshot };
  const search = options.search || await new RuntimeWebSearchClient(registry, {
    enabled: true, timeoutMs: 60000, resultCount: 8,
  }).acquireForTask({ runtimeSnapshot: snapshot, signal: task.abortController.signal });
  const reader = options.reader || new SafeWebReader({ enabled: true, maxPagesPerBatch: 2 });
  const sources = new Map();
  return {
    tools: [
      nativeTool('web_search', '联网搜索，网页内容仅作为参考资料。', { query: { type: 'string', minLength: 1, maxLength: 1200 } },
        ['query'], async ({ query }, signal) => {
          const result = await search.searchMany([query], { signal, resultCount: 8 });
          for (const source of result.results || []) sources.set(source.url, { ...source, id: source.id || 'web-' + (sources.size + 1) });
          return result;
        }),
      nativeTool('web_extract', '安全读取本任务搜索返回的最多两个网页。', {
        urls: { type: 'array', minItems: 1, maxItems: 2, items: { type: 'string', maxLength: 4096 } } }, ['urls'],
        async ({ urls }, signal) => {
          const selected = urls.map((url) => sources.get(url));
          if (selected.some((source) => !source)) throw Error('仅可读取本任务搜索返回的链接。');
          const args = { sources: selected, sourceIds: selected.map((s) => s.id), signal };
          const result = await reader.readMany(args);
          if (!webSearch.extractFallbackEnabled || result.documents.length || signal?.aborted) return result;
          const fallback = new RuntimeWebExtractFallback(registry, { bailianConfig: { enabled: true,
            reuseWebSearchKey: true, model: 'qwen3.8-max', timeoutMs: 60000 } });
          return fallback.extract(args);
        }),
    ],
    close: () => search.close(),
  };
}
