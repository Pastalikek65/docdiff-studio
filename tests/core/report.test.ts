import { describe, expect, it } from 'vitest';
import { COMPARISON_LIMITS } from '../../src/core/limits';
import { preflightReportOutputs, renderHtmlReport, serializeReport } from '../../src/core/report';
import type { ComparisonResult } from '../../src/core/types';

function maliciousResult(): ComparisonResult {
  return {
    schemaVersion: 1,
    documents: {
      before: { name: 'C:\\private\\before <script>.pdf', format: 'pdf', sha256: 'a'.repeat(64), pageCount: 1 },
      after: { name: '/Users/alex/after.pdf', format: 'pdf', sha256: 'b'.repeat(64), pageCount: 1 },
    },
    options: { ignoreWhitespace: false, ignoreHeaderLines: 0, ignoreFooterLines: 0, visualThreshold: 24 },
    rows: [{
      id: 'page-1',
      status: 'changed',
      beforePage: 0,
      afterPage: 0,
      beforeText: '<script>alert("x")</script> & source body',
      afterText: 'replacement <img src=x onerror=alert(1)>',
      changes: [
        { kind: 'removed', text: '<script>alert("x")</script>' },
        { kind: 'added', text: '<img src=x onerror=alert(1)>' },
      ],
      beforeImageDataUrl: 'javascript:alert(1)',
      afterImageDataUrl: 'data:image/png;base64,AAAA',
      visual: { diffImageDataUrl: 'data:image/png;base64,AAAA', changedPixels: 1, totalPixels: 100, ratio: 0.01 },
    }],
    summary: { unchanged: 0, changed: 1, added: 0, removed: 0 },
    warnings: ['<svg onload=alert(1)>'],
    outcome: 'changed',
  };
}

describe('offline report generation', () => {
  it('escapes untrusted document text and warnings and only embeds vetted data images', () => {
    const html = renderHtmlReport(maliciousResult());
    expect(html).toContain('&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;');
    expect(html).toContain('&lt;svg onload=alert(1)&gt;');
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;');
    expect(html).toContain('src="data:image/png;base64,AAAA"');
    expect(html).not.toContain('<script>');
    expect(html).not.toContain('javascript:');
    expect(html).not.toContain('C:\\private\\');
    expect(html).not.toMatch(/<(?:script|iframe|object)\b/iu);
    expect(html).not.toMatch(/<img\b[^>]*\bonerror=/iu);
    expect(html).not.toMatch(/(?:src|href)="https?:/iu);
  });

  it('serializes only the versioned report fields and does not include source bytes or raw filesystem paths', () => {
    const result = Object.assign(maliciousResult(), {
      sourceBytes: 'RAW_SOURCE_BYTES_SENTINEL',
      localPath: 'C:\\private\\customer.pdf',
    });
    const json = serializeReport(result);
    const parsed = JSON.parse(json) as Record<string, unknown>;
    expect(parsed.schemaVersion).toBe(1);
    expect(json).toContain('"name": "before <script>.pdf"');
    expect(json).not.toContain('RAW_SOURCE_BYTES_SENTINEL');
    expect(json).not.toContain('localPath');
    expect(json).not.toContain('C:\\private\\');
  });

  it('withholds completion when bounded JSON fits but escaped standalone HTML exceeds the same output cap', () => {
    const beforeText = '&'.repeat(COMPARISON_LIMITS.maxPageTextCharacters);
    const afterText = '<'.repeat(COMPARISON_LIMITS.maxPageTextCharacters);
    const imagePrefix = 'data:image/png;base64,';
    const rowCount = COMPARISON_LIMITS.maxTextCharactersTotal / (beforeText.length + afterText.length);
    const imageCount = rowCount * 3;
    const basePayloadCharacters = Math.floor(
      (COMPARISON_LIMITS.maxImageOutputCharacters - imageCount * imagePrefix.length) / imageCount / 4,
    ) * 4;
    const makeImageDataUrl = () => imagePrefix + 'A'.repeat(basePayloadCharacters);
    const rows = Array.from({ length: rowCount }, (_, index) => ({
      id: `page-${index + 1}`,
      status: 'changed' as const,
      beforePage: index,
      afterPage: index,
      beforeText,
      afterText,
      changes: [
        { kind: 'removed' as const, text: beforeText },
        { kind: 'added' as const, text: afterText },
      ],
      beforeImageDataUrl: makeImageDataUrl(),
      afterImageDataUrl: makeImageDataUrl(),
      visual: { diffImageDataUrl: makeImageDataUrl(), changedPixels: 1, totalPixels: 100, ratio: 0.01 },
    }));
    const result: ComparisonResult = {
      schemaVersion: 1,
      documents: {
        before: { name: 'before.pdf', format: 'pdf', sha256: 'a'.repeat(64), pageCount: rowCount },
        after: { name: 'after.pdf', format: 'pdf', sha256: 'b'.repeat(64), pageCount: rowCount },
      },
      options: { ignoreWhitespace: false, ignoreHeaderLines: 0, ignoreFooterLines: 0, visualThreshold: 24 },
      rows,
      summary: { unchanged: 0, changed: rowCount, added: 0, removed: 0 },
      warnings: [],
      outcome: 'changed',
    };

    const sourceTextCharacters = rows.reduce((sum, row) => sum + row.beforeText.length + row.afterText.length, 0);
    const imageDataUrlCharacters = rows.reduce((sum, row) => sum + row.beforeImageDataUrl.length
      + row.afterImageDataUrl.length + row.visual.diffImageDataUrl.length, 0);
    expect(rowCount).toBe(10);
    expect(imageCount).toBe(30);
    expect(rows.every((row) => row.beforeText.length <= COMPARISON_LIMITS.maxPageTextCharacters
      && row.afterText.length <= COMPARISON_LIMITS.maxPageTextCharacters)).toBe(true);
    expect(sourceTextCharacters).toBe(COMPARISON_LIMITS.maxTextCharactersTotal);
    expect(rows.every((row) => [row.beforeImageDataUrl, row.afterImageDataUrl, row.visual.diffImageDataUrl]
      .every((dataUrl) => (dataUrl.length - imagePrefix.length) % 4 === 0))).toBe(true);
    expect(imageDataUrlCharacters).toBeLessThanOrEqual(COMPARISON_LIMITS.maxImageOutputCharacters);
    {
      const json = serializeReport(result);
      expect(new TextEncoder().encode(json).byteLength).toBeLessThan(COMPARISON_LIMITS.maxSerializedReportBytes);
    }
    const completionNotifications: string[] = [];
    expect(() => preflightReportOutputs(result, () => completionNotifications.push('Comparison complete'))).toThrowError(
      expect.objectContaining({ code: 'OUTPUT_LIMIT_EXCEEDED' }),
    );
    expect(completionNotifications).toEqual([]);
  });
});
