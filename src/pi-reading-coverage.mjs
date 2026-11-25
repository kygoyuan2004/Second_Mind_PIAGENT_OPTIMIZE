// A sparse segment tree over 1-based line numbers. A covered subtree collapses
// to true; an absent subtree represents a contiguous unread interval.
export function mergeIntervals(node, lo, hi, start, end) {
  if (node === true || end < lo || hi < start) return node;
  if (start <= lo && hi <= end) return true;
  const mid = Math.floor((lo + hi) / 2);
  const left = mergeIntervals(node?.left, lo, mid, start, end);
  const right = mergeIntervals(node?.right, mid + 1, hi, start, end);
  return left === true && right === true ? true : { left, right };
}

function gaps(node, lo, hi, result) {
  if (node === true || hi < lo) return;
  if (!node) {
    const last = result.at(-1);
    if (last?.[1] === lo - 1) last[1] = hi;
    else result.push([lo, hi]);
    return;
  }
  const mid = Math.floor((lo + hi) / 2);
  gaps(node.left, lo, mid, result);
  gaps(node.right, mid + 1, hi, result);
}

export class ReadingCoverage {
  entries = new Map();
  revision = 0;
  checked = -1;

  candidate(path) {
    if (!this.entries.has(path)) {
      this.entries.set(path, { path, totalLines: null, tree: null });
      this.revision++;
    }
    return this.entries.get(path);
  }

  observe(path, totalLines, version) {
    const file = this.candidate(path);
    if (file.version !== version) {
      Object.assign(file, { version, totalLines, tree: null, failed: false });
      this.revision++;
    }
    return file;
  }

  read(file, start, end) {
    file.tree = file.totalLines ? mergeIntervals(file.tree, 1, file.totalLines, start, end) : true;
    file.failed = false;
    this.revision++;
    return this.describe(file);
  }

  fail(path) {
    this.candidate(path).failed = true;
    this.revision++;
  }

  describe(file) {
    const remainingRanges = [];
    if (file.totalLines !== null) gaps(file.tree, 1, file.totalLines, remainingRanges);
    const status = file.failed ? 'failed' : file.tree === true ? 'full' : file.tree ? 'partial' : 'unread';
    return { path: file.path, totalLines: file.totalLines, complete: status === 'full', remainingRanges, status };
  }

  snapshot() {
    const files = [...this.entries.values()].map((file) => this.describe(file)).sort((a, b) => a.path.localeCompare(b.path));
    const counts = { full: 0, partial: 0, unread: 0, failed: 0 };
    for (const file of files) counts[file.status]++;
    return { candidateCount: files.length, fullReadCount: counts.full, partialReadCount: counts.partial,
      unreadCount: counts.unread, failedCount: counts.failed, files };
  }
}
