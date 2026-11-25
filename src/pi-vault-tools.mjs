import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { RE2JS } from 're2js';
import { VaultPathPolicy, pathError } from './path-policy.mjs';
import { resolveSource } from './source-resolver.mjs';
import { confirmPassage, registerEvidence } from './original/knowledge-evidence.mjs';
import { ReadingCoverage } from './pi-reading-coverage.mjs';

const string = (maxLength) => ({ type: 'string', minLength: 1, maxLength });
const integer = (minimum, maximum) => ({ type: 'integer', minimum, maximum });
const notePath = string(4096);
const directory = { type: 'string', maxLength: 4096 };
const offset = integer(0, 1000000);

export function nativeTool(name, description, properties, required, action) {
  return { name, label: name, description, parameters: { type: 'object', properties, required, additionalProperties: false },
    async execute(_id, input, signal) {
      signal?.throwIfAborted();
      const value = await action(input, signal);
      signal?.throwIfAborted();
      return { content: [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value) }], details: value };
    } };
}

function relative(value, policy) {
  if (path.posix.isAbsolute(value) || path.win32.isAbsolute(value) || /^[a-z]:/iu.test(value)) throw pathError(400, '请输入库内相对路径。');
  if (value) return policy.assertAllowed(value).relative;
  return '';
}

const isNote = (name) => /\.(?:txt|md)$/iu.test(name);
const versionOf = (stat) => [stat.dev, stat.ino, stat.size, stat.ctimeMs].join('/');

async function inspectNote(policy, name, signal, options, inspect) {
  if (!isNote(name)) throw Error('请指定 Markdown 或文本笔记。');
  const file = await policy.existingFile(relative(name, policy), options);
  const handle = await fs.open(file.target, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
  try {
    signal?.throwIfAborted();
    const version = versionOf(file.stat);
    if (versionOf(await handle.stat()) !== version) throw Error('笔记已变化，请重试。');
    const value = await inspect(handle, file);
    if (versionOf(await handle.stat()) !== version) throw Error('笔记已变化，请重试。');
    return { file, version, value };
  } finally { await handle.close(); }
}

// Count every line, retaining at most 32 KiB of a single line. The selected
// byte range is fixed by the opening stat so an actively growing file cannot
// keep a tool running indefinitely.
async function scanNote(policy, name, signal, visit) {
  return inspectNote(policy, name, signal, {}, async (handle, file) => {
    const buffer = Buffer.allocUnsafe(65536);
    const line = Buffer.allocUnsafe(32769);
    let size = 0, totalLines = 0, position = 0;
    function finishLine() {
      const length = size && size <= line.length && line[size - 1] === 13 ? size - 1 : size;
      visit(++totalLines, line.toString('utf8', 0, Math.min(length, 32768)), length > 32768);
      size = 0;
    }
    while (position < file.stat.size) {
      signal?.throwIfAborted();
      const { bytesRead } = await handle.read(buffer, 0, Math.min(buffer.length, file.stat.size - position), position);
      if (!bytesRead) throw Error('笔记已变化，请重试。');
      position += bytesRead;
      const chunk = buffer.subarray(0, bytesRead);
      let start = 0;
      while (start < bytesRead) {
        const newline = chunk.indexOf(10, start);
        const end = newline < 0 ? bytesRead : newline;
        if (size < line.length) chunk.copy(line, size, start, Math.min(end, start + line.length - size));
        size += end - start;
        if (newline >= 0) finishLine();
        start = end + 1;
      }
    }
    if (size) finishLine();
    return totalLines;
  });
}

export async function safeSearchResults(policy, results, signal) {
  const allowed = new Map();
  async function accessible(name) {
    signal?.throwIfAborted();
    if (allowed.has(name)) return allowed.get(name);
    try {
      await policy.existingFile(relative(name, policy));
      allowed.set(name, true);
    } catch (error) {
      if (!error.status) throw error;
      allowed.set(name, false);
    }
    return allowed.get(name);
  }
  const safe = [];
  for (const item of results || []) {
    if (!await accessible(item.path)) continue;
    const relatedPaths = [];
    for (const name of item.relatedPaths || []) {
      if (await accessible(name)) relatedPaths.push(name);
    }
    safe.push({ path: item.path, heading: item.heading, headings: item.headings || (item.heading ? [item.heading] : []),
      startLine: item.startLine, endLine: item.endLine, lineNumbers: item.lineNumbers, snippet: item.snippet, relatedPaths,
      passages: (item.passages || []).filter((p) => p.path === item.path).map(({ path, line, quote, headings }) =>
        ({ path, line, quote, headings: headings || [] })) });
  }
  return safe;
}

async function readOutline(scan, name, signal) {
  const headings = [], stack = [];
  let fence = '', frontmatter = false;
  const { totalLines } = await scan(name, signal, (number, line) => {
    if (number === 1 && line.trim() === '---') { frontmatter = true; return; }
    if (frontmatter) {
      if (/^(---|\.\.\.)\s*$/u.test(line)) frontmatter = false;
      return;
    }
    const delimiter = /^ {0,3}(\x60{3,}|~{3,})(.*)$/u.exec(line);
    if (fence) {
      if (delimiter?.[1].startsWith(fence) && !delimiter[2].trim()) fence = '';
      return;
    }
    if (delimiter) { fence = delimiter[1]; return; }
    const match = /^ {0,3}(#{1,6})\s+(.+)$/u.exec(line);
    if (!match) return;
    const level = match[1].length;
    while (stack.length && stack.at(-1).level >= level) stack.pop().endLine = number - 1;
    const heading = { level, title: match[2].trim(), startLine: number, endLine: number, children: [] };
    (stack.at(-1)?.children || headings).push(heading);
    stack.push(heading);
  });
  for (const heading of stack) heading.endLine = totalLines;
  return { path: name, totalLines, headings };
}

export async function createVaultTools(store, task, { onRetrieval } = {}) {
  const policy = task.pathPolicy ||= await new VaultPathPolicy(store.root, store.config?.excludedPaths).initialize();
  const ledger = task.coverage ||= new ReadingCoverage();
  for (const item of task.candidates || []) ledger.candidate(item.path);
  const scan = async (name, signal, visit) => {
    name = relative(name, policy);
    try {
      const { value: totalLines, version } = await scanNote(policy, name, signal, visit);
      return { totalLines, entry: ledger.observe(name, totalLines, version) };
    } catch (error) {
      signal?.throwIfAborted();
      if (ledger.entries.has(name) || error.status === 413) ledger.fail(name);
      throw error;
    }
  };
  const list = async function* (directory, signal) {
    for await (const name of policy.walk(relative(directory, policy))) {
      signal?.throwIfAborted();
      if (isNote(name)) yield name;
    }
  };
  return [
    nativeTool('knowledge_search', '检索知识库，返回检索路线和可引用的命中段落。', { query: string(500), offset, limit: integer(1, 50) }, ['query'],
      async ({ query, offset = 0, limit = 20 }, signal) => {
        const options = { taskMode: task.taskMode.id, allowLongQuery: true, signal };
        const result = task.hybridSearchEnabled === false ? { route: 'legacy', results: await store.search(query, options) }
          : await store.hybridSearch(query, options);
        onRetrieval?.(result);
        const hits = await safeSearchResults(policy, result.results, signal);
        for (const item of hits) ledger.candidate(item.path);
        const items = hits.slice(offset, offset + limit).map((item) => ({ ...item,
          passages: item.passages.map((p) => ({ ...p, citation: registerEvidence(task, p) })) }));
        return { route: result.route, exhaustive: Boolean(result.exhaustive), complete: Boolean(result.complete),
          offset, total: hits.length, nextOffset: offset + limit < hits.length ? offset + limit : null, items };
      }),
    nativeTool('read_note_outline', '读取 Markdown 标题层级、起止行和总行数。', { path: notePath }, ['path'], ({ path }, signal) =>
      readOutline(scan, path, signal)),
    nativeTool('read_note_lines', '按 1-based 行号阅读原文，每批至多 200 行、32 KiB。', {
      path: notePath, startLine: integer(1, 2147483647), limit: integer(1, 200) }, ['path'],
      async ({ path, startLine = 1, limit = 160 }, signal) => {
        let bytes = 0, full = false;
        const output = [];
        const { totalLines, entry } = await scan(path, signal, (number, text, oversized) => {
          if (full || number < startLine || number >= startLine + limit) return;
          const line = String(number) + '│ ' + text;
          const size = Buffer.byteLength(line) + 1;
          if (oversized || bytes + size > 32768) { full = true; return; }
          bytes += size;
          output.push(line);
        });
        if (startLine > Math.max(1, totalLines)) throw Error('起始行超过笔记总行数。');
        if (full && !output.length) { ledger.fail(entry.path); throw Error('该行超过 32 KiB，未计入已读。'); }
        const end = startLine + output.length - 1;
        return { ...ledger.read(entry, startLine, end), readRange: output.length ? [startLine, end] : null, text: output.join('\n') };
      }),
    nativeTool('glob_notes', '按 glob 分页枚举库内笔记。', { pattern: string(256), path: directory, offset, limit: integer(1, 500) }, [],
      async ({ pattern = '**/*.md', path: dir = '', offset = 0, limit = 100 }, signal) => {
        if (path.win32.isAbsolute(pattern) || /^[a-z]:/iu.test(pattern) || pattern.includes('\\') ||
          pattern.includes('\0') || pattern.split('/').includes('..')) throw Error('请输入库内 glob 表达式。');
        let total = 0;
        const paths = [];
        for await (const file of list(dir, signal)) {
          if (!path.posix.matchesGlob(dir ? file.slice(dir.length + 1) : file, pattern)) continue;
          ledger.candidate(file);
          if (total >= offset && paths.length < limit) paths.push(file);
          total++;
        }
        return { paths, total, nextOffset: offset + limit < total ? offset + limit : null };
      }),
    nativeTool('grep_notes', '搜索匹配行，返回相对路径、行号和摘要。', {
      pattern: string(256), path: directory, isRegex: { type: 'boolean' }, limit: integer(1, 200) }, ['pattern'],
      async ({ pattern, path = '', isRegex = false, limit = 50 }, signal) => {
        let regex;
        try { if (isRegex) regex = RE2JS.compile(pattern); } catch { throw Error('正则表达式无效或包含不支持的语法。'); }
        const matches = [];
        for await (const name of list(path, signal)) {
          try {
            const found = [];
            await scanNote(policy, name, signal, (number, line, oversized) => {
              if (oversized || matches.length + found.length >= limit) return;
              if (regex ? regex.test(line) : line.includes(pattern)) found.push({ path: name, line: number, snippet: line.slice(0, 360) });
            });
            if (found.length) { ledger.candidate(name); matches.push(...found); }
          } catch (error) { signal?.throwIfAborted(); if (error.status) continue; throw error; }
          if (matches.length >= limit) return matches;
        }
        return matches;
      }),
    nativeTool('resolve_wikilink', '解析 Obsidian 双链或 Markdown 相对链接。', { reference: string(4096), fromPath: notePath }, ['reference'],
      async ({ reference, fromPath }) => {
        const wiki = /^\[\[(.+)\]\]$/u.exec(reference);
        const ref = (wiki?.[1] || /^\[[^\]]*\]\((.+)\)$/u.exec(reference)?.[1] || reference).split(/[|#]/u)[0];
        const name = decodeURIComponent(ref);
        if (path.win32.isAbsolute(name) || path.posix.isAbsolute(name) || name.includes('\\') || /^[a-z][\w+.-]*:/iu.test(name)) throw Error('链接须指向库内笔记。');
        const access = { existingFile: (f) => policy.existingFile(relative(f, policy)), walk: () => policy.walk() };
        if (fromPath) {
          const base = relative(fromPath, policy);
          const local = path.posix.join(path.posix.dirname(base), name || path.posix.basename(base));
          try { return { path: (await access.existingFile(path.posix.extname(local) ? local : local + '.md')).relative }; }
          catch (error) { if (error.status !== 404) throw error; }
        }
        return resolveSource(relative(name, policy), access);
      }),
    nativeTool('cite_passage', '逐字核验连续原文与起始行，返回依据标识。不匹配时请重新读行并重试。',
      { path: notePath, quote: string(640), line: integer(1, 2147483647) }, ['path', 'quote'], async (input, signal) => {
        const { file, value: text } = await inspectNote(policy, input.path, signal, { maxBytes: 2 * 1024 * 1024 },
          async (handle) => (await handle.readFile({ encoding: 'utf8', signal })).replace(/\r\n/g, '\n'));
        return confirmPassage({ existingFile: () => file }, task, input, text);
      }),
    nativeTool('get_reading_coverage', '核对服务端当前候选、完整、部分、未读和失败文件数。', {}, [], () => {
      ledger.checked = ledger.revision;
      return ledger.snapshot();
    }),
  ];
}
