import { describe, expect, it } from 'vitest';
import { alignPages, type PageFeatures } from '../../src/core/alignment';

function page(text: string, shade: number): PageFeatures {
  return { text, visualSample: Array.from({ length: 64 }, () => shade) };
}

describe('page alignment', () => {
  it('keeps later pages aligned when a new page is inserted between matches', () => {
    const before = [
      page('Quarterly report overview', 235),
      page('Revenue increased by 12 percent', 190),
      page('Prepared by finance team', 220),
    ];
    const after = [
      page('Quarterly report overview', 235),
      page('New appendix about the office move', 72),
      page('Revenue increased by 12 percent', 190),
      page('Prepared by finance team', 220),
    ];

    expect(alignPages(before, after)).toEqual([
      { before: 0, after: 0 },
      { before: null, after: 1 },
      { before: 1, after: 2 },
      { before: 2, after: 3 },
    ]);
  });

  it('aligns image-only pages by their visual signature while preserving order', () => {
    const before = [page('', 245), page('', 40), page('', 210)];
    const after = [page('', 245), page('', 128), page('', 40), page('', 210)];
    expect(alignPages(before, after)).toEqual([
      { before: 0, after: 0 },
      { before: null, after: 1 },
      { before: 1, after: 2 },
      { before: 2, after: 3 },
    ]);
  });
});
