import { describe, expect, it } from 'vitest';
import { strToU8, zipSync } from 'fflate';
import { compareDocumentsV2, DEFAULT_COMPARE_OPTIONS_V2, renderHtmlReportV2, serializeReportV2 } from '../../src/core';
import type { CompareRequestV2 } from '../../src/core/types';

const wordNamespace = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
const packageNamespace = 'http://schemas.openxmlformats.org/package/2006/relationships';
const typesNamespace = 'http://schemas.openxmlformats.org/package/2006/content-types';
const documentContentType = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml';

function docx(body: string, extraParts: Record<string, string> = {}): Uint8Array {
  return zipSync({
    '[Content_Types].xml': strToU8(`<Types xmlns="${typesNamespace}"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="${documentContentType}"/></Types>`),
    '_rels/.rels': strToU8(`<Relationships xmlns="${packageNamespace}"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`),
    'word/document.xml': strToU8(`<w:document xmlns:w="${wordNamespace}"><w:body>${body}<w:sectPr/></w:body></w:document>`),
    ...Object.fromEntries(Object.entries(extraParts).map(([name, text]) => [name, strToU8(text)])),
  });
}

function request(before: Uint8Array, after: Uint8Array): CompareRequestV2 {
  return {
    schemaVersion: 2,
    before: { format: 'docx', name: 'before.docx', bytes: before },
    after: { format: 'docx', name: 'after.docx', bytes: after },
    options: { ...DEFAULT_COMPARE_OPTIONS_V2 },
  };
}

describe('version 2 document comparison', () => {
  it('rejects mixed declared formats before attempting either parser', async () => {
    const request: CompareRequestV2 = {
      schemaVersion: 2,
      before: { format: 'pdf', name: 'before.pdf', bytes: new Uint8Array([0x25, 0x50, 0x44, 0x46]) },
      after: { format: 'docx', name: 'after.docx', bytes: new Uint8Array([0x50, 0x4b, 0x03, 0x04]) },
      options: {
        ignoreWhitespace: false,
        ignoreHeaderLines: 0,
        ignoreFooterLines: 0,
        visualThreshold: 24,
        detectMoves: true,
        ocr: { enabled: false, beforePageIndexes: [], afterPageIndexes: [], minimumConfidence: 0 },
      },
    };

    await expect(compareDocumentsV2(request)).rejects.toMatchObject({ code: 'FORMAT_MISMATCH' });
  });

  it('exports stable v2 defaults with OCR disabled and move detection enabled', () => {
    expect(DEFAULT_COMPARE_OPTIONS_V2).toEqual({
      ignoreWhitespace: false,
      ignoreHeaderLines: 0,
      ignoreFooterLines: 0,
      visualThreshold: 24,
      detectMoves: true,
      ocr: { enabled: false, beforePageIndexes: [], afterPageIndexes: [], minimumConfidence: 70 },
    });
  });

  it('extracts split paragraph runs, spaces, tabs, breaks, and basic table cells in body order', async () => {
    const body = '<w:p><w:r><w:t xml:space="preserve">Hello </w:t></w:r><w:r><w:t>world</w:t><w:tab/><w:t>next</w:t><w:br/><w:t>line</w:t></w:r></w:p>'
      + '<w:tbl><w:tr><w:tc><w:p><w:r><w:t>Alpha</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>Beta</w:t></w:r></w:p><w:p><w:r><w:t>cell 2</w:t></w:r></w:p></w:tc></w:tr></w:tbl>';
    const result = await compareDocumentsV2(request(docx(body), docx(body)));

    expect(result.schemaVersion).toBe(2);
    expect(result.outcome).toBe('identical');
    expect(result.certainty).toBe('complete');
    expect(result.rows.map((row) => row.beforeLocation)).toEqual([
      { format: 'docx', kind: 'paragraph', index: 0 },
      { format: 'docx', kind: 'table-row', index: 1, tableIndex: 0, rowIndex: 0 },
    ]);
    expect(result.rows[0].beforeText).toBe('Hello world\tnext\nline');
    expect(result.rows[1].beforeCells).toEqual(['Alpha', 'Beta\ncell 2']);
    expect(result.rows[1].cellChanges).toEqual([
      { beforeCellIndex: 0, afterCellIndex: 0, changes: [{ kind: 'equal', text: 'Alpha' }] },
      { beforeCellIndex: 1, afterCellIndex: 1, changes: [{ kind: 'equal', text: 'Beta\ncell 2' }] },
    ]);
  });

  it('marks a unique reordered paragraph as moved without converting duplicate boilerplate into a move', async () => {
    const before = docx('<w:p><w:r><w:t>First unique phrase</w:t></w:r></w:p><w:p><w:r><w:t>Second unique phrase</w:t></w:r></w:p><w:p><w:r><w:t>Shared boilerplate</w:t></w:r></w:p><w:p><w:r><w:t>Shared boilerplate</w:t></w:r></w:p>');
    const after = docx('<w:p><w:r><w:t>Second unique phrase</w:t></w:r></w:p><w:p><w:r><w:t>First unique phrase</w:t></w:r></w:p><w:p><w:r><w:t>Shared boilerplate</w:t></w:r></w:p>');
    const result = await compareDocumentsV2(request(before, after));

    expect(result.rows.filter((row) => row.status === 'moved')).toHaveLength(1);
    expect(result.rows.find((row) => row.status === 'moved')).toMatchObject({
      beforeText: 'First unique phrase',
      afterText: 'First unique phrase',
      moveId: expect.stringMatching(/^move-[a-f0-9]+-/u),
    });
    expect(result.summary.moved).toBe(1);
    expect(result.rows.some((row) => row.status === 'moved' && row.beforeText === 'Shared boilerplate')).toBe(false);
  });

  it('keeps repeated empty paragraphs aligned as unchanged units', async () => {
    const body = '<w:p/><w:p/><w:p><w:r><w:t>Visible text</w:t></w:r></w:p>';
    const result = await compareDocumentsV2(request(docx(body), docx(body)));

    expect(result.outcome).toBe('identical');
    expect(result.summary).toEqual({ unchanged: 3, changed: 0, added: 0, removed: 0, moved: 0 });
  });

  it('never reports identical when a document contains unsupported text-bearing OOXML', async () => {
    const body = '<w:p><w:r><w:t>Visible text</w:t></w:r></w:p><w:altChunk r:id="chunk1"/>';
    const result = await compareDocumentsV2(request(docx(body), docx(body)));

    expect(result.outcome).toBe('uncertain');
    expect(result.certainty).toBe('incomplete');
    expect(result.warnings.some((warning) => /altChunk/iu.test(warning))).toBe(true);
  });

  it('marks nested tables inside cells incomplete when their text is omitted', async () => {
    const before = '<w:tbl><w:tr><w:tc><w:tbl><w:tr><w:tc><w:p><w:r><w:t>Nested before</w:t></w:r></w:p></w:tc></w:tr></w:tbl></w:tc></w:tr></w:tbl>';
    const after = '<w:tbl><w:tr><w:tc><w:tbl><w:tr><w:tc><w:p><w:r><w:t>Nested after</w:t></w:r></w:p></w:tc></w:tr></w:tbl></w:tc></w:tr></w:tbl>';
    const result = await compareDocumentsV2(request(docx(before), docx(after)));

    expect(result.outcome).not.toBe('identical');
    expect(result.certainty).toBe('incomplete');
    expect(result.warnings.some((warning) => /nested table/iu.test(warning))).toBe(true);
  });

  it('does not report identical when an unknown WordprocessingML element has omitted direct text', async () => {
    const before = '<w:p><w:unknown>Hidden before</w:unknown></w:p>';
    const after = '<w:p><w:unknown>Hidden after</w:unknown></w:p>';
    const result = await compareDocumentsV2(request(docx(before), docx(after)));

    expect(result.outcome).toBe('uncertain');
    expect(result.certainty).toBe('incomplete');
    expect(result.warnings).toContain('Unrecognized DOCX element text may be omitted from the comparison.');
  });

  it('rejects XML depth and node counts before building a parser tree', async () => {
    const deep = `${'<w:r>'.repeat(130)}<w:t>bounded</w:t>${'</w:r>'.repeat(130)}`;
    await expect(compareDocumentsV2(request(docx(`<w:p>${deep}</w:p>`), docx('<w:p/>'))))
      .rejects.toMatchObject({ code: 'DOCX_XML_INVALID' });

    const manyNodes = '<w:shd/>'.repeat(999_999);
    await expect(compareDocumentsV2(request(docx(manyNodes), docx('<w:p/>'))))
      .rejects.toMatchObject({ code: 'DOCX_XML_INVALID' });
  });

  it('exports escaped schema-2 reports without source bytes or raw filesystem paths', async () => {
    const body = '<w:p><w:r><w:t>&lt;script&gt;alert(1)&lt;/script&gt; &amp; body</w:t></w:r></w:p>';
    const result = await compareDocumentsV2(request(docx(body), docx(body)));
    result.documents.before.name = 'C:\\private\\<script>.docx';
    const tainted = Object.assign(result, { sourceBytes: 'RAW_DOCX_BYTES_SENTINEL', localPath: 'C:\\private\\customer.docx' });
    const html = renderHtmlReportV2(tainted);
    const json = serializeReportV2(tainted);

    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt; &amp; body');
    expect(html).not.toMatch(/<script>/iu);
    expect(html).not.toContain('C:\\private\\');
    expect(json).toContain('"schemaVersion":2');
    expect(json).not.toContain('RAW_DOCX_BYTES_SENTINEL');
    expect(json).not.toContain('localPath');
    expect(json).not.toContain('C:\\private\\');
  });

  it('rejects DTDs, custom entities, duplicate canonical paths, and traversal entries', async () => {
    const dtdBody = '<!DOCTYPE w:document [<!ENTITY secret "expanded">]><w:p><w:r><w:t>&secret;</w:t></w:r></w:p>';
    await expect(compareDocumentsV2(request(docx(dtdBody), docx(dtdBody)))).rejects.toMatchObject({ code: 'DOCX_XML_INVALID' });
    const customEntityBody = '<w:p><w:r><w:t>&secret;</w:t></w:r></w:p>';
    await expect(compareDocumentsV2(request(docx(customEntityBody), docx(customEntityBody)))).rejects.toMatchObject({ code: 'DOCX_XML_INVALID' });
    const body = '<w:p><w:r><w:t>Safe</w:t></w:r></w:p>';
    await expect(compareDocumentsV2(request(docx(body, { 'WORD/DOCUMENT.XML': 'not the main document' }), docx(body))))
      .rejects.toMatchObject({ code: 'DOCX_PACKAGE_INVALID' });
    await expect(compareDocumentsV2(request(docx(body, { '../escape.xml': 'no' }), docx(body))))
      .rejects.toMatchObject({ code: 'DOCX_PACKAGE_INVALID' });

    const mismatchedLocalHeader = docx(body);
    const view = new DataView(mismatchedLocalHeader.buffer, mismatchedLocalHeader.byteOffset, mismatchedLocalHeader.byteLength);
    let localHeader = -1;
    for (let offset = 0; offset <= mismatchedLocalHeader.length - 4; offset += 1) {
      if (view.getUint32(offset, true) === 0x04034b50) { localHeader = offset; break; }
    }
    expect(localHeader).toBeGreaterThanOrEqual(0);
    view.setUint32(localHeader + 18, view.getUint32(localHeader + 18, true) + 1, true);
    await expect(compareDocumentsV2(request(mismatchedLocalHeader, docx(body))))
      .rejects.toMatchObject({ code: 'DOCX_PACKAGE_INVALID' });

    const mismatchedLocalCrc = docx(body);
    const crcView = new DataView(mismatchedLocalCrc.buffer, mismatchedLocalCrc.byteOffset, mismatchedLocalCrc.byteLength);
    let crcHeader = -1;
    for (let offset = 0; offset <= mismatchedLocalCrc.length - 4; offset += 1) {
      if (crcView.getUint32(offset, true) === 0x04034b50) { crcHeader = offset; break; }
    }
    expect(crcHeader).toBeGreaterThanOrEqual(0);
    crcView.setUint32(crcHeader + 14, crcView.getUint32(crcHeader + 14, true) ^ 1, true);
    await expect(compareDocumentsV2(request(mismatchedLocalCrc, docx(body))))
      .rejects.toMatchObject({ code: 'DOCX_PACKAGE_INVALID' });
  });

  it('rejects package metadata elements that override their required namespace', async () => {
    const body = '<w:p><w:r><w:t>Safe</w:t></w:r></w:p>';
    const wrongRelationshipNamespace = `<Relationships xmlns="${packageNamespace}"><Relationship xmlns="urn:wrong" Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`;
    await expect(compareDocumentsV2(request(
      docx(body, { '_rels/.rels': wrongRelationshipNamespace }), docx(body),
    ))).rejects.toMatchObject({ code: 'DOCX_PACKAGE_INVALID' });

    const wrongContentTypeNamespace = `<Types xmlns="${typesNamespace}"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override xmlns="urn:wrong" PartName="/word/document.xml" ContentType="${documentContentType}"/></Types>`;
    await expect(compareDocumentsV2(request(
      docx(body, { '[Content_Types].xml': wrongContentTypeNamespace }), docx(body),
    ))).rejects.toMatchObject({ code: 'DOCX_PACKAGE_INVALID' });
  });

  it('does not fetch external relationship targets and marks the package incomplete', async () => {
    const body = '<w:p><w:r><w:t>Visible text</w:t></w:r></w:p>';
    const externalRels = `<Relationships xmlns="${packageNamespace}"><Relationship Id="rId9" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="https://example.invalid/private" TargetMode="External"/></Relationships>`;
    const result = await compareDocumentsV2(request(
      docx(body, { 'word/_rels/document.xml.rels': externalRels }),
      docx(body, { 'word/_rels/document.xml.rels': externalRels }),
    ));
    expect(result.outcome).toBe('uncertain');
    expect(result.certainty).toBe('incomplete');
    expect(result.warnings).toContain('External relationship targets were not loaded.');
    expect(JSON.stringify(result)).not.toContain('example.invalid');
  });

  it('marks hyperlink targets unsupported even when only the target changes', async () => {
    const body = '<w:p><w:hyperlink r:id="rId9"><w:r><w:t>Open reference</w:t></w:r></w:hyperlink></w:p>';
    const relationship = (target: string) => `<Relationships xmlns="${packageNamespace}"><Relationship Id="rId9" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="${target}"/></Relationships>`;
    const result = await compareDocumentsV2(request(
      docx(body, { 'word/_rels/document.xml.rels': relationship('first-reference.xml') }),
      docx(body, { 'word/_rels/document.xml.rels': relationship('second-reference.xml') }),
    ));

    expect(result.outcome).toBe('uncertain');
    expect(result.certainty).toBe('incomplete');
    expect(result.warnings.some((warning) => /hyperlink/iu.test(warning))).toBe(true);
    expect(JSON.stringify(result)).not.toContain('first-reference.xml');
  });

  it('marks text-bearing relationship parts unsupported when their package path is custom', async () => {
    const contentTypes = `<Types xmlns="${typesNamespace}"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="${documentContentType}"/><Override PartName="/custom/header.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.header+xml"/></Types>`;
    const document = `<w:document xmlns:w="${wordNamespace}" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><w:body><w:p><w:r><w:t>Same main body</w:t></w:r></w:p><w:sectPr><w:headerReference w:type="default" r:id="h1"/></w:sectPr></w:body></w:document>`;
    const relationships = `<Relationships xmlns="${packageNamespace}"><Relationship Id="h1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/header" Target="/custom/header.xml"/></Relationships>`;
    const header = (text: string) => `<w:hdr xmlns:w="${wordNamespace}"><w:p><w:r><w:t>${text}</w:t></w:r></w:p></w:hdr>`;
    const make = (text: string) => zipSync({
      '[Content_Types].xml': strToU8(contentTypes),
      '_rels/.rels': strToU8(`<Relationships xmlns="${packageNamespace}"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`),
      'word/document.xml': strToU8(document),
      'word/_rels/document.xml.rels': strToU8(relationships),
      'custom/header.xml': strToU8(header(text)),
    });

    const result = await compareDocumentsV2(request(make('Before header'), make('After header')));

    expect(result.outcome).not.toBe('identical');
    expect(result.certainty).toBe('incomplete');
    expect(result.warnings.some((warning) => /header/iu.test(warning))).toBe(true);
    expect(JSON.stringify(result)).not.toContain('custom/header.xml');
  });

  it('marks unknown related XML content incomplete without exposing its target path', async () => {
    const contentTypes = `<Types xmlns="${typesNamespace}"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="${documentContentType}"/><Override PartName="/custom/feature.xml" ContentType="application/xml"/></Types>`;
    const body = '<w:p><w:r><w:t>Same main body</w:t></w:r><w:customPart r:id="custom1"/></w:p>';
    const relationships = `<Relationships xmlns="${packageNamespace}"><Relationship Id="custom1" Type="http://schemas.example.invalid/relationships/customPart" Target="/custom/feature.xml"/></Relationships>`;
    const make = () => zipSync({
      '[Content_Types].xml': strToU8(contentTypes),
      '_rels/.rels': strToU8(`<Relationships xmlns="${packageNamespace}"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`),
      'word/document.xml': strToU8(`<w:document xmlns:w="${wordNamespace}" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><w:body>${body}<w:sectPr/></w:body></w:document>`),
      'word/_rels/document.xml.rels': strToU8(relationships),
      'custom/feature.xml': strToU8('<feature>Hidden related text</feature>'),
    });

    const result = await compareDocumentsV2(request(make(), make()));

    expect(result.outcome).toBe('uncertain');
    expect(result.certainty).toBe('incomplete');
    expect(result.warnings).toContain('Additional related XML content is not included in the document comparison.');
    expect(JSON.stringify(result)).not.toContain('custom/feature.xml');
  });
});
