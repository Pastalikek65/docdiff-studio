import { describe, expect, it } from 'vitest';
import { strToU8, zipSync } from 'fflate';
import { compareDocumentsV2, DEFAULT_COMPARE_OPTIONS_V2, renderHtmlReportV2, serializeReportV2 } from '../../src/core';
import type { ComparisonResultV2 } from '../../src/core/types';

const wordNamespace = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
const packageNamespace = 'http://schemas.openxmlformats.org/package/2006/relationships';
const typesNamespace = 'http://schemas.openxmlformats.org/package/2006/content-types';
const documentContentType = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml';

function docxRow(cells: string[]): Uint8Array {
  const cellXml = cells.map((text) => `<w:tc><w:p>${text ? `<w:r><w:t>${text}</w:t></w:r>` : ''}</w:p></w:tc>`).join('');
  const body = `<w:tbl><w:tr>${cellXml}</w:tr></w:tbl>`;
  return zipSync({
    '[Content_Types].xml': strToU8(`<Types xmlns="${typesNamespace}"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="${documentContentType}"/></Types>`),
    '_rels/.rels': strToU8(`<Relationships xmlns="${packageNamespace}"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`),
    'word/document.xml': strToU8(`<w:document xmlns:w="${wordNamespace}"><w:body>${body}<w:sectPr/></w:body></w:document>`),
  });
}

describe('DOCX empty table-cell structure acceptance', () => {
  it('preserves trailing empty-cell additions and removals when whitespace is ignored', async () => {
    const before = docxRow(['Account', '742']);
    const after = docxRow(['Account', '742', '']);
    for (const [beforeBytes, afterBytes, expectedCells, expectedStructuralChange, expectedHtmlLabel] of [
      [before, after, [['Account', '742'], ['Account', '742', '']], { beforeCellIndex: null, afterCellIndex: 2 }, 'Added · after position 3'],
      [after, before, [['Account', '742', ''], ['Account', '742']], { beforeCellIndex: 2, afterCellIndex: null }, 'Removed · before position 3'],
    ] as const) {
      const result = await compareDocumentsV2({
        schemaVersion: 2,
        before: { format: 'docx', name: 'before.docx', bytes: beforeBytes },
        after: { format: 'docx', name: 'after.docx', bytes: afterBytes },
        options: { ...DEFAULT_COMPARE_OPTIONS_V2, ignoreWhitespace: true },
      });

      expect(result.outcome).toBe('changed');
      expect(result.certainty).toBe('complete');
      expect(result.summary).toMatchObject({ unchanged: 0, changed: 1, added: 0, removed: 0 });
      expect(result.rows).toHaveLength(1);
      expect(result.rows[0].status).toBe('changed');
      expect(result.rows[0].changes.every(({ kind }) => kind === 'equal')).toBe(true);
      expect([result.rows[0].beforeCells, result.rows[0].afterCells]).toEqual(expectedCells);
      expect(result.rows[0].cellChanges).toContainEqual(expect.objectContaining(expectedStructuralChange));

      const serialized = JSON.parse(serializeReportV2(result)) as ComparisonResultV2;
      expect(serialized.rows[0].cellChanges).toContainEqual(expect.objectContaining(expectedStructuralChange));
      const html = renderHtmlReportV2(result);
      expect(html).toContain('<h2>changed block</h2>');
      expect(htmlCellCount(html, 'Before')).toBe(expectedCells[0].length);
      expect(htmlCellCount(html, 'After')).toBe(expectedCells[1].length);
      expect(html).toContain(expectedHtmlLabel);
      expect(html).toContain('Empty cell');
    }
  });
});

function htmlCellCount(html: string, side: 'Before' | 'After'): number {
  const sideSection = html.split(`<h3>${side} cells</h3>`)[1]?.split('</section>')[0] ?? '';
  return [...sideSection.matchAll(/class="cell"/gu)].length;
}
