import { alignPages, tokenSimilarity, type PageAlignment } from './alignment';

export interface ComparableBlock {
  text: string;
  kind: string;
  cells?: string[];
}

export type BlockAlignment = PageAlignment;

/** Ordered alignment with unique exact anchors and a strict DP work bound. */
export function alignBlocks(before: ComparableBlock[], after: ComparableBlock[]): BlockAlignment[] {
  const left = before.map(blockFingerprint);
  const right = after.map(blockFingerprint);
  const leftCounts = countFingerprints(left);
  const rightCounts = countFingerprints(right);
  const rightIndexes = new Map(right.map((key, index) => [key, index]));
  const candidates: Array<{ before: number; after: number }> = [];
  for (let index = 0; index < left.length; index += 1) {
    const key = left[index];
    if (leftCounts.get(key) === 1 && rightCounts.get(key) === 1) {
      const afterIndex = rightIndexes.get(key);
      if (afterIndex !== undefined) candidates.push({ before: index, after: afterIndex });
    }
  }
  const anchors = longestIncreasingAnchors(candidates);
  const aligned: BlockAlignment[] = [];
  let beforeStart = 0;
  let afterStart = 0;
  for (const anchor of anchors) {
    appendGap(before, after, left, right, beforeStart, anchor.before, afterStart, anchor.after, aligned);
    aligned.push(anchor);
    beforeStart = anchor.before + 1;
    afterStart = anchor.after + 1;
  }
  appendGap(before, after, left, right, beforeStart, before.length, afterStart, after.length, aligned);
  return aligned;
}

/** Move candidates must be unique across both entire documents, and unmatched. */
export function findExactMoves(
  before: ComparableBlock[],
  after: ComparableBlock[],
  alignments: BlockAlignment[],
): Array<{ before: number; after: number }> {
  const leftKeys = before.map(blockFingerprint);
  const rightKeys = after.map(blockFingerprint);
  const leftCounts = countFingerprints(leftKeys);
  const rightCounts = countFingerprints(rightKeys);
  const leftUnmatched = new Map<string, number>();
  const rightUnmatched = new Map<string, number>();
  for (const pair of alignments) {
    if (pair.before !== null && pair.after === null) leftUnmatched.set(leftKeys[pair.before], pair.before);
    if (pair.before === null && pair.after !== null) rightUnmatched.set(rightKeys[pair.after], pair.after);
  }
  const moves: Array<{ before: number; after: number }> = [];
  for (const [key, beforeIndex] of leftUnmatched) {
    const afterIndex = rightUnmatched.get(key);
    if (afterIndex !== undefined && leftCounts.get(key) === 1 && rightCounts.get(key) === 1) {
      moves.push({ before: beforeIndex, after: afterIndex });
    }
  }
  return moves.sort((a, b) => a.after - b.after || a.before - b.before);
}

export function blockFingerprint(block: ComparableBlock): string {
  const normalized = normalizeExactText(block.text);
  if (!block.cells) return `${block.kind}\u0000p${normalized.length}:` + normalized;
  const cells = block.cells.map(normalizeExactText);
  return `${block.kind}\u0000t${cells.length}:` + cells.map((cell) => `${cell.length}:${cell}`).join('');
}

export function normalizeExactText(text: string): string {
  // Move fingerprints must mean literal extracted-text equality. Compatibility
  // normalization belongs in fuzzy alignment, not exact move classification.
  return text;
}

function countFingerprints(keys: string[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const key of keys) counts.set(key, (counts.get(key) ?? 0) + 1);
  return counts;
}

function longestIncreasingAnchors(candidates: Array<{ before: number; after: number }>): Array<{ before: number; after: number }> {
  if (!candidates.length) return [];
  const tails: number[] = [];
  const tailCandidate: number[] = [];
  const previous = new Int32Array(candidates.length).fill(-1);
  for (let index = 0; index < candidates.length; index += 1) {
    const value = candidates[index].after;
    let low = 0;
    let high = tails.length;
    while (low < high) {
      const middle = (low + high) >>> 1;
      if (tails[middle] < value) low = middle + 1;
      else high = middle;
    }
    tails[low] = value;
    previous[index] = low > 0 ? tailCandidate[low - 1] : -1;
    tailCandidate[low] = index;
  }
  const result: Array<{ before: number; after: number }> = [];
  let index = tailCandidate[tails.length - 1] ?? -1;
  while (index >= 0) {
    result.push(candidates[index]);
    index = previous[index];
  }
  return result.reverse();
}

function appendGap(
  before: ComparableBlock[],
  after: ComparableBlock[],
  beforeKeys: string[],
  afterKeys: string[],
  beforeStart: number,
  beforeEnd: number,
  afterStart: number,
  afterEnd: number,
  target: BlockAlignment[],
): void {
  const leftLength = beforeEnd - beforeStart;
  const rightLength = afterEnd - afterStart;
  if (leftLength === 0) {
    for (let index = afterStart; index < afterEnd; index += 1) target.push({ before: null, after: index });
    return;
  }
  if (rightLength === 0) {
    for (let index = beforeStart; index < beforeEnd; index += 1) target.push({ before: index, after: null });
    return;
  }
  if (leftLength * rightLength <= 200_000) {
    const gap = alignPages(
      before.slice(beforeStart, beforeEnd).map((block) => ({ text: block.text, visualSample: block.text.length ? [] : [0] })),
      after.slice(afterStart, afterEnd).map((block) => ({ text: block.text, visualSample: block.text.length ? [] : [0] })),
    );
    for (const pair of gap) {
      const beforeIndex = pair.before === null ? null : beforeStart + pair.before;
      const afterIndex = pair.after === null ? null : afterStart + pair.after;
      if (beforeIndex === null && afterIndex !== null) target.push({ before: null, after: afterIndex });
      else if (afterIndex === null && beforeIndex !== null) target.push({ before: beforeIndex, after: null });
      else if (beforeIndex !== null && afterIndex !== null) {
        if (before[beforeIndex].kind === after[afterIndex].kind) target.push({ before: beforeIndex, after: afterIndex });
        else {
          target.push({ before: beforeIndex, after: null });
          target.push({ before: null, after: afterIndex });
        }
      }
    }
    return;
  }

  let left = beforeStart;
  let right = afterStart;
  const lookAhead = 16;
  while (left < beforeEnd && right < afterEnd) {
    if (beforeKeys[left] === afterKeys[right]) {
      target.push({ before: left, after: right });
      left += 1;
      right += 1;
      continue;
    }
    const next = findNearbyCommon(beforeKeys, afterKeys, left, beforeEnd, right, afterEnd, lookAhead);
    if (next) {
      while (left < next.before) target.push({ before: left++, after: null });
      while (right < next.after) target.push({ before: null, after: right++ });
      target.push({ before: left++, after: right++ });
      continue;
    }
    if (before[left].kind === after[right].kind && tokenSimilarity(before[left].text, after[right].text) >= 0.25) {
      target.push({ before: left, after: right });
    }
    else {
      target.push({ before: left, after: null });
      target.push({ before: null, after: right });
    }
    left += 1;
    right += 1;
  }
  while (left < beforeEnd) target.push({ before: left++, after: null });
  while (right < afterEnd) target.push({ before: null, after: right++ });
}

function findNearbyCommon(
  leftKeys: string[],
  rightKeys: string[],
  leftStart: number,
  leftEnd: number,
  rightStart: number,
  rightEnd: number,
  distance: number,
): { before: number; after: number } | undefined {
  const candidates = new Map<string, number>();
  for (let index = rightStart; index < Math.min(rightEnd, rightStart + distance); index += 1) {
    if (!candidates.has(rightKeys[index])) candidates.set(rightKeys[index], index);
  }
  let best: { before: number; after: number; cost: number } | undefined;
  for (let index = leftStart; index < Math.min(leftEnd, leftStart + distance); index += 1) {
    const after = candidates.get(leftKeys[index]);
    if (after === undefined) continue;
    const cost = index - leftStart + after - rightStart;
    if (cost > 0 && (!best || cost < best.cost)) best = { before: index, after, cost };
  }
  return best;
}
