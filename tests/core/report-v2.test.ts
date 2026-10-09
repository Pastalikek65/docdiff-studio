import { strToU8, zipSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import { compareDocumentsV2, DEFAULT_COMPARE_OPTIONS_V2, renderHtmlReportV2, serializeReportV2 } from '../../src/core';

const wordNamespace = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
const packageNamespace = 'http://schemas.openxmlformats.org/package/2006/relationships';
const typesNamespace = 'http://schemas.openxmlformats.org/package/2006/content-types';
const documentContentType = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml';

function docxRow(cells: string[]): Uint8Array {
  const xmlText = (text: string) => text.replace(/&/gu, '&amp;').replace(/</gu, '&lt;').replace(/>/gu, '&gt;');
  const cellXml = cells.map((text) => `<w:tc><w:p>${text ? `<w:r><w:t>${xmlText(text)}</w:t></w:r>` : ''}</w:p></w:tc>`).join('');
  return zipSync({
    '[Content_Types].xml': strToU8(`<Types xmlns="${typesNamespace}"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="${documentContentType}"/></Types>`),
    '_rels/.rels': strToU8(`<Relationships xmlns="${packageNamespace}"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`),
    'word/document.xml': strToU8(`<w:document xmlns:w="${wordNamespace}"><w:body><w:tbl><w:tr>${cellXml}</w:tr></w:tbl><w:sectPr/></w:body></w:document>`),
  });
}

describe('version 2 HTML report', () => {
  it('labels structurally added and removed empty table cells without changing JSON projection', async () => {
    const common = ['<script>alert(1)</script>', '742'];
    const options = { ...DEFAULT_COMPARE_OPTIONS_V2, ignoreWhitespace: true };
    const added = await compareDocumentsV2({
      schemaVersion: 2,
      before: { format: 'docx', name: 'before.docx', bytes: docxRow(common) },
      after: { format: 'docx', name: 'after.docx', bytes: docxRow([...common, '']) },
      options,
    });
    const removed = await compareDocumentsV2({
      schemaVersion: 2,
      before: { format: 'docx', name: 'before.docx', bytes: docxRow([...common, '']) },
      after: { format: 'docx', name: 'after.docx', bytes: docxRow(common) },
      options,
    });

    const addedHtml = renderHtmlReportV2(added);
    const removedHtml = renderHtmlReportV2(removed);
    expect(addedHtml).toContain('<strong>Added · after position 3</strong>');
    expect(removedHtml).toContain('<strong>Removed · before position 3</strong>');
    expect(addedHtml).toContain('Empty cell');
    expect(removedHtml).toContain('Empty cell');
    expect(addedHtml).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(addedHtml).not.toContain('<script>');

    const projected = JSON.parse(serializeReportV2(added)) as { rows: Array<{ cellChanges: Array<unknown> }> };
    expect(projected.rows[0].cellChanges.at(-1)).toEqual({
      beforeCellIndex: null,
      afterCellIndex: 2,
      changes: [{ kind: 'equal', text: '' }],
    });
  });
});
