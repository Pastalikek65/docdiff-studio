export interface PageFeatures {
  text: string;
  /** Grayscale sample values in reading order, normalized to 0..255. */
  visualSample: number[];
}

export type PageAlignment =
  | { before: number; after: number }
  | { before: number; after: null }
  | { before: null; after: number };

const GAP_SCORE = -0.75;
const MIN_PAIR_SIMILARITY = 0.25;

/**
 * Globally aligns two ordered page sequences. A pair is only considered when
 * its content has a minimum similarity, so a newly inserted page does not
 * consume the next page and shift every later match.
 */
export function alignPages(before: PageFeatures[], after: PageFeatures[]): PageAlignment[] {
  const preparedBefore = before.map((page) => preparePage(page));
  const preparedAfter = after.map((page) => preparePage(page));
  const rows = before.length + 1;
  const columns = after.length + 1;
  const scores = Array.from({ length: rows }, () => new Float64Array(columns));
  const moves = Array.from({ length: rows }, () => new Uint8Array(columns));

  for (let i = 1; i < rows; i += 1) {
    scores[i][0] = scores[i - 1][0] + GAP_SCORE;
    moves[i][0] = 1; // before-only
  }
  for (let j = 1; j < columns; j += 1) {
    scores[0][j] = scores[0][j - 1] + GAP_SCORE;
    moves[0][j] = 2; // after-only
  }

  for (let i = 1; i < rows; i += 1) {
    for (let j = 1; j < columns; j += 1) {
      const similarity = preparedPageSimilarity(preparedBefore[i - 1], preparedAfter[j - 1]);
      const pair = similarity >= MIN_PAIR_SIMILARITY
        ? scores[i - 1][j - 1] + 6 * similarity - 3
        : Number.NEGATIVE_INFINITY;
      const beforeGap = scores[i - 1][j] + GAP_SCORE;
      const afterGap = scores[i][j - 1] + GAP_SCORE;

      // Prefer a real content match on ties, then keep the left side stable.
      if (pair >= beforeGap && pair >= afterGap) {
        scores[i][j] = pair;
        moves[i][j] = 3;
      } else if (beforeGap >= afterGap) {
        scores[i][j] = beforeGap;
        moves[i][j] = 1;
      } else {
        scores[i][j] = afterGap;
        moves[i][j] = 2;
      }
    }
  }

  const reversed: PageAlignment[] = [];
  let i = before.length;
  let j = after.length;
  while (i > 0 || j > 0) {
    const move = moves[i][j];
    if (move === 3) {
      reversed.push({ before: i - 1, after: j - 1 });
      i -= 1;
      j -= 1;
    } else if (move === 1 || j === 0) {
      reversed.push({ before: i - 1, after: null });
      i -= 1;
    } else {
      reversed.push({ before: null, after: j - 1 });
      j -= 1;
    }
  }
  return reversed.reverse();
}

export function pageSimilarity(before: PageFeatures, after: PageFeatures): number {
  return preparedPageSimilarity(preparePage(before), preparePage(after));
}

interface PreparedPage {
  page: PageFeatures;
  tokenCounts: Map<string, number>;
  tokenCount: number;
}

function preparePage(page: PageFeatures): PreparedPage {
  const tokenCounts = new Map<string, number>();
  let tokenCount = 0;
  for (const token of tokens(page.text)) {
    tokenCounts.set(token, (tokenCounts.get(token) ?? 0) + 1);
    tokenCount += 1;
  }
  return { page, tokenCounts, tokenCount };
}

function preparedPageSimilarity(before: PreparedPage, after: PreparedPage): number {
  const textBefore = preparedTokenSimilarity(before, after);
  const visual = sampleSimilarity(before.page.visualSample, after.page.visualSample);
  if (!before.page.text.trim() && !after.page.text.trim()) return visual;
  if (!before.page.text.trim() || !after.page.text.trim()) return visual * 0.9;
  return Math.min(1, textBefore * 0.86 + visual * 0.14);
}

function preparedTokenSimilarity(before: PreparedPage, after: PreparedPage): number {
  if (before.tokenCount === 0 || after.tokenCount === 0) return before.tokenCount === after.tokenCount ? 1 : 0;
  const smaller = before.tokenCounts.size <= after.tokenCounts.size ? before.tokenCounts : after.tokenCounts;
  const larger = smaller === before.tokenCounts ? after.tokenCounts : before.tokenCounts;
  let common = 0;
  for (const [token, count] of smaller) common += Math.min(count, larger.get(token) ?? 0);
  return (2 * common) / (before.tokenCount + after.tokenCount);
}

export function tokenSimilarity(before: string, after: string): number {
  return preparedTokenSimilarity(
    preparePage({ text: before, visualSample: [] }),
    preparePage({ text: after, visualSample: [] }),
  );
}

function sampleSimilarity(left: number[], right: number[]): number {
  if (left.length === 0 || right.length === 0) return 0;
  const length = Math.min(left.length, right.length);
  let absoluteDifference = 0;
  for (let index = 0; index < length; index += 1) {
    absoluteDifference += Math.abs(left[index] - right[index]);
  }
  const average = absoluteDifference / length;
  const sizePenalty = Math.abs(left.length - right.length) / Math.max(left.length, right.length);
  return Math.max(0, 1 - average / 255 - sizePenalty * 0.25);
}

function tokens(value: string): string[] {
  return value.normalize('NFKC').toLocaleLowerCase('und').match(/[\p{L}\p{N}]+/gu) ?? [];
}
