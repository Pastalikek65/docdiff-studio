import { describe, expect, it } from 'vitest';
import { alignBlocks, findExactMoves, type ComparableBlock } from '../../src/core/block-alignment';

describe('logical block move matching', () => {
  it('does not call compatibility-normalized text an exact move', () => {
    const before: ComparableBlock[] = [{ kind: 'paragraph', text: 'Ａlpha' }];
    const after: ComparableBlock[] = [{ kind: 'paragraph', text: 'Alpha' }];

    expect(findExactMoves(before, after, [
      { before: 0, after: null },
      { before: null, after: 0 },
    ])).toEqual([]);
  });

  it('never pairs different block kinds in the bounded greedy fallback', () => {
    const before: ComparableBlock[] = Array.from({ length: 500 }, () => ({ kind: 'paragraph', text: 'Section label repeated' }));
    const after: ComparableBlock[] = Array.from({ length: 500 }, () => ({ kind: 'table-row', text: 'Section label repeated' }));

    const alignments = alignBlocks(before, after);
    expect(alignments.some((pair) => pair.before !== null && pair.after !== null
      && before[pair.before].kind !== after[pair.after].kind)).toBe(false);
    expect(alignments.filter((pair) => pair.before !== null && pair.after === null)).toHaveLength(500);
    expect(alignments.filter((pair) => pair.before === null && pair.after !== null)).toHaveLength(500);
  });
});
