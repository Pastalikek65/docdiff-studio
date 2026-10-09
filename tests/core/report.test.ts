import { describe, expect, it } from 'vitest';
import { renderHtmlReport, serializeReport } from '../../src/core/report';
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
});
