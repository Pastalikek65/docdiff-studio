import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
import { strToU8, zipSync } from 'fflate';
import { chromium } from 'playwright';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const CORPUS = path.join(ROOT, 'corpus');
const EPOCH = new Date('1980-01-01T00:00:00.000Z');
const PDF_DATE = new Date('2020-01-01T00:00:00.000Z');
const files = new Map();
await mkdir(CORPUS, { recursive: true });

function escapeXml(value) {
  return String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&apos;');
}

function run(text) {
  return `<w:r><w:t xml:space="preserve">${escapeXml(text)}</w:t></w:r>`;
}

function paragraph(text, splitAt = null) {
  const value = String(text);
  const chunks = splitAt === null ? [value] : [value.slice(0, splitAt), value.slice(splitAt)];
  return `<w:p>${chunks.filter((chunk) => chunk.length > 0).map(run).join('')}</w:p>`;
}

function tabParagraph(parts) {
  return `<w:p>${parts.map((part, index) => `${run(part)}${index < parts.length - 1 ? '<w:r><w:tab/></w:r>' : ''}`).join('')}</w:p>`;
}

function table(rows) {
  const rowXml = rows.map((cells) => `<w:tr>${cells.map((cell) => `<w:tc><w:tcPr/><w:p>${run(cell)}</w:p></w:tc>`).join('')}</w:tr>`).join('');
  return `<w:tbl><w:tblPr/><w:tblGrid/>${rowXml}</w:tbl>`;
}

const contentTypes = (hasHeader, hasSettings) => `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
${hasHeader ? '<Override PartName="/word/header1.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.header+xml"/>' : ''}
${hasSettings ? '<Override PartName="/word/settings.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.settings+xml"/>' : ''}
</Types>`;

const rootRels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>`;

function documentXml({ blocks = [], header = false, tracking = false, dtd = false, deep = 0, rawBody = null }) {
  const doctype = dtd ? '<!DOCTYPE w:document [<!ENTITY xxe SYSTEM "file:///etc/passwd">]>' : '';
  const section = `<w:sectPr>${header ? '<w:headerReference w:type="default" r:id="rIdHeader"/>' : ''}</w:sectPr>`;
  let body = rawBody ?? `${blocks.join('')}${section}`;
  if (deep > 0) body = `${'<w:customXml>'.repeat(deep)}${body}${'</w:customXml>'.repeat(deep)}`;
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>${doctype}
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><w:body>${body}</w:body></w:document>`;
}

function docxBytes({ paragraphs = [], rows = [], headerText = null, revision = false, dtd = false, deep = 0, rawDocument = null, extraFiles = {} }) {
  const hasHeader = headerText !== null;
  const hasSettings = revision;
  const blocks = paragraphs.map((entry) => typeof entry === 'string' ? paragraph(entry) : entry.xml);
  if (rows.length > 0) blocks.push(table(rows));
  if (revision) {
    blocks.push(`<w:p><w:ins w:id="1" w:author="Synthetic fixture" w:date="2020-01-01T00:00:00Z">${run('tracked insertion')}</w:ins></w:p>`);
  }
  const rels = hasHeader
    ? `<Relationship Id="rIdHeader" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/header" Target="header1.xml"/>`
    : '';
  const documentRels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${rels}</Relationships>`;
  const values = {
    '[Content_Types].xml': contentTypes(hasHeader, hasSettings),
    '_rels/.rels': rootRels,
    'word/document.xml': rawDocument ?? documentXml({ blocks, header: hasHeader, tracking: revision, dtd, deep }),
    'word/_rels/document.xml.rels': documentRels,
  };
  if (hasHeader) values['word/header1.xml'] = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:hdr xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">${paragraph(headerText)}</w:hdr>`;
  if (hasSettings) values['word/settings.xml'] = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:settings xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:trackRevisions/></w:settings>`;
  Object.assign(values, extraFiles);
  const zipValues = Object.fromEntries(Object.entries(values).map(([name, value]) => [name, [typeof value === 'string' ? strToU8(value) : value, { level: 9, mtime: EPOCH }]]));
  return zipSync(zipValues, { level: 9, mtime: EPOCH });
}

function readU16(bytes, offset) { return bytes[offset] | (bytes[offset + 1] << 8); }
function readU32(bytes, offset) { return (bytes[offset] | (bytes[offset + 1] << 8) | (bytes[offset + 2] << 16) | (bytes[offset + 3] << 24)) >>> 0; }
function writeU32(bytes, offset, value) {
  bytes[offset] = value & 255;
  bytes[offset + 1] = (value >>> 8) & 255;
  bytes[offset + 2] = (value >>> 16) & 255;
  bytes[offset + 3] = (value >>> 24) & 255;
}

function eocdOffset(bytes) {
  for (let offset = bytes.length - 22; offset >= Math.max(0, bytes.length - 65_557); offset--) {
    if (readU32(bytes, offset) === 0x06054b50) return offset;
  }
  throw new Error('ZIP end-of-central-directory record not found.');
}

function patchZipEntry(input, name, { crcXor = 0, declaredUncompressedSize = null } = {}) {
  const bytes = Uint8Array.from(input);
  const end = eocdOffset(bytes);
  const count = readU16(bytes, end + 10);
  let central = readU32(bytes, end + 16);
  const decoder = new TextDecoder();
  for (let index = 0; index < count; index++) {
    if (readU32(bytes, central) !== 0x02014b50) throw new Error('Malformed generated central directory.');
    const nameLength = readU16(bytes, central + 28);
    const extraLength = readU16(bytes, central + 30);
    const commentLength = readU16(bytes, central + 32);
    const entryName = decoder.decode(bytes.subarray(central + 46, central + 46 + nameLength));
    if (entryName === name) {
      const local = readU32(bytes, central + 42);
      if (readU32(bytes, local) !== 0x04034b50) throw new Error('Malformed generated local record.');
      if (crcXor !== 0) {
        writeU32(bytes, central + 16, readU32(bytes, central + 16) ^ crcXor);
        writeU32(bytes, local + 14, readU32(bytes, local + 14) ^ crcXor);
      }
      if (declaredUncompressedSize !== null) {
        writeU32(bytes, central + 24, declaredUncompressedSize);
        writeU32(bytes, local + 22, declaredUncompressedSize);
      }
      return bytes;
    }
    central += 46 + nameLength + extraLength + commentLength;
  }
  throw new Error(`ZIP entry not found: ${name}`);
}

async function createScanRasterizer() {
  const fontPath = path.resolve(ROOT, '../../public/vendor/pdfjs/standard_fonts/LiberationSans-Regular.ttf');
  const font = (await readFile(fontPath)).toString('base64');
  const browser = await chromium.launch({ headless: true, chromiumSandbox: true });
  const page = await browser.newPage({ viewport: { width: 2000, height: 500 }, deviceScaleFactor: 1 });
  await page.setContent(`<style>@font-face{font-family:CorpusLiberation;src:url(data:font/ttf;base64,${font}) format('truetype');font-weight:400;font-style:normal}html,body{margin:0;width:2000px;height:500px;overflow:hidden}canvas{display:block}</style><canvas id="scan" width="2000" height="500"></canvas>`);
  const fontReady = await page.evaluate(async () => {
    await document.fonts.load('82px CorpusLiberation');
    return document.fonts.check('82px CorpusLiberation');
  });
  if (!fontReady) {
    await browser.close();
    throw new Error('Bundled Liberation Sans did not load in the scan rasterizer.');
  }
  return {
    async render(lines, seed = 0x5eed1234) {
      const data = await page.evaluate(({ lines: sourceLines, seed: sourceSeed }) => {
        const canvas = document.querySelector('#scan');
        const ctx = canvas.getContext('2d', { alpha: false });
        ctx.fillStyle = '#f8f8f6';
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        ctx.textBaseline = 'top';
        ctx.font = '82px CorpusLiberation';
        ctx.fillStyle = '#151515';
        sourceLines.forEach((line, index) => {
          const width = ctx.measureText(line).width;
          ctx.fillText(line, Math.max(70, (canvas.width - width) / 2), 72 + index * 155);
        });
        let state = sourceSeed >>> 0;
        ctx.fillStyle = 'rgba(40,40,40,0.16)';
        for (let index = 0; index < 900; index++) {
          state ^= state << 13; state ^= state >>> 17; state ^= state << 5;
          const x = (state >>> 0) % canvas.width;
          state = Math.imul(state ^ 0xa5a5a5a5, 0x45d9f3b) >>> 0;
          const y = state % canvas.height;
          ctx.fillRect(x, y, 1, 1);
        }
        return canvas.toDataURL('image/png').slice('data:image/png;base64,'.length);
      }, { lines, seed });
      return Buffer.from(data, 'base64');
    },
    async close() { await browser.close(); },
  };
}
async function pdfBytes({ pages, title, scanRaster }) {
  const pdf = await PDFDocument.create({ updateMetadata: false });
  pdf.setTitle(title);
  pdf.setAuthor('DocDiff Studio synthetic v1 corpus');
  pdf.setCreator('examples/v1/generate.mjs');
  pdf.setCreationDate(PDF_DATE);
  pdf.setModificationDate(PDF_DATE);
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  for (const pageSpec of pages) {
    if (pageSpec.kind === 'scan') {
      const png = await scanRaster.render(pageSpec.lines, pageSpec.seed ?? 0x5eed1234);
      const image = await pdf.embedPng(png);
      const page = pdf.addPage([2000, 500]);
      page.drawImage(image, { x: 0, y: 0, width: 2000, height: 500 });
    } else {
      const page = pdf.addPage([612, 792]);
      page.drawText(pageSpec.text, { x: 58, y: 710, size: 18, font, color: rgb(0.08, 0.08, 0.08) });
      if (pageSpec.subtext) page.drawText(pageSpec.subtext, { x: 58, y: 675, size: 13, font, color: rgb(0.12, 0.12, 0.12) });
      if (pageSpec.rectangle) {
        page.drawRectangle({
          x: 80, y: 560, width: 90, height: 35,
          color: rgb(1, 0, 0),
        });
      }
    }
  }
  return pdf.save({ useObjectStreams: false });
}

async function addFile(name, bytes, category, note) {
  const target = path.join(CORPUS, name);
  await writeFile(target, bytes);
  files.set(name, { name, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'), category, note });
}

const baselineParagraphs = ['Agreement review 2026', 'The delivery total is 1250 units.', 'Payment is due within thirty days.'];
const baseTable = [['Item', 'Quantity', 'Unit price'], ['Widget A', '2', '500'], ['Widget B', '1', '250']];

const docx = {};
docx.changeBefore = docxBytes({ paragraphs: baselineParagraphs, rows: baseTable });
docx.changeAfter = docxBytes({ paragraphs: ['Agreement review 2026', 'The delivery total is 1350 units.', 'Payment is due within thirty days.'], rows: [['Item', 'Quantity', 'Unit price'], ['Widget A', '2', '600'], ['Widget B', '1', '250']] });
docx.insertBefore = docxBytes({ paragraphs: ['Opening clause remains.', 'Closing clause remains.'] });
docx.insertAfter = docxBytes({ paragraphs: ['Opening clause remains.', 'Inserted middle paragraph.', 'Closing clause remains.'] });
docx.removeBefore = docxBytes({ paragraphs: ['Opening clause remains.', 'Removed middle paragraph.', 'Closing clause remains.'] });
docx.removeAfter = docxBytes({ paragraphs: ['Opening clause remains.', 'Closing clause remains.'] });
docx.moveBefore = docxBytes({ paragraphs: ['Stable cover paragraph.', 'Unique moved clause: account 742.', 'Stable middle paragraph.', 'Stable ending paragraph.'] });
docx.moveAfter = docxBytes({ paragraphs: ['Stable cover paragraph.', 'Stable middle paragraph.', 'Stable ending paragraph.', 'Unique moved clause: account 742.'] });
docx.duplicateBefore = docxBytes({ paragraphs: ['Alpha section.', 'Standard boilerplate repeated.', 'Standard boilerplate repeated.', 'Omega section.'] });
docx.duplicateAfter = docxBytes({ paragraphs: ['Alpha section.', 'Standard boilerplate repeated.', 'Omega section.', 'Standard boilerplate repeated.'] });
docx.splitBefore = docxBytes({ paragraphs: ['One paragraph with split runs.'] });
docx.splitAfter = docxBytes({ paragraphs: [{ xml: paragraph('One paragraph with split runs.', 17) }] });
docx.tabsBefore = docxBytes({ paragraphs: [{ xml: tabParagraph(['ITEM', 'COUNT', 'TOTAL']) }] });
docx.tabsAfter = docxBytes({ paragraphs: [{ xml: `<w:p>${run('ITEM')}<w:r><w:tab/></w:r>${run('COUNT')}<w:r><w:tab/></w:r>${run('TOTAL')}</w:p>` }] });
docx.headerBefore = docxBytes({ paragraphs: ['Body text is unchanged.'], headerText: 'Confidential header A' });
docx.headerAfter = docxBytes({ paragraphs: ['Body text is unchanged.'], headerText: 'Confidential header B' });
docx.revisionBase = docxBytes({ paragraphs: ['Body text is unchanged.'] });
docx.revisionMarked = docxBytes({ paragraphs: ['Body text is unchanged.'], revision: true });
docx.futureTextBefore = docxBytes({ paragraphs: [{ xml: `<w:p>${run('Visible statement remains.')}<w:futureText>Preserved hidden text A</w:futureText></w:p>` }] });
docx.futureTextAfter = docxBytes({ paragraphs: [{ xml: `<w:p>${run('Visible statement remains.')}<w:futureText>Preserved hidden text B</w:futureText></w:p>` }] });
docx.namespaceBefore = docxBytes({ paragraphs: ['Namespace prefix comparison: original.'] });
docx.namespaceAfter = docxBytes({ rawDocument: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><x:document xmlns:x="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><x:body><x:p><x:r><x:t>Namespace prefix comparison: changed.</x:t></x:r></x:p><x:sectPr/></x:body></x:document>` });
docx.reportText = docxBytes({ paragraphs: ['<script>alert(1)</script> & <img src=x onerror=alert(2)>'] });
const benchmarkParagraphsBefore = Array.from({ length: 1_000 }, (_, index) => (
  `Performance paragraph ${String(index + 1).padStart(4, '0')}: amount ${index === 499 ? '1250' : 1000 + index} units.`
));
const benchmarkParagraphsAfter = benchmarkParagraphsBefore.map((text, index) => (
  index === 499 ? text.replace('1250', '1350') : text
));
const benchmarkRowsBefore = [['Item', 'Description', 'Amount'], ...Array.from({ length: 499 }, (_, index) => [
  `Item ${String(index + 1).padStart(4, '0')}`,
  `Routine charge ${String(index + 1).padStart(4, '0')}`,
  index === 249 ? '500' : String(1000 + index),
])];
const benchmarkRowsAfter = benchmarkRowsBefore.map((cells, index) => (
  index === 250 ? [cells[0], cells[1], '600'] : cells
));
docx.benchmarkBefore = docxBytes({ paragraphs: benchmarkParagraphsBefore, rows: benchmarkRowsBefore });
docx.benchmarkAfter = docxBytes({ paragraphs: benchmarkParagraphsAfter, rows: benchmarkRowsAfter });

const invalidPath = docxBytes({ paragraphs: ['Safe body.'], extraFiles: { '../outside.xml': '<unsafe/>' } });
const invalidAbsolute = docxBytes({ paragraphs: ['Safe body.'], extraFiles: { '/rooted.xml': '<unsafe/>' } });
const invalidBackslash = docxBytes({ paragraphs: ['Safe body.'], extraFiles: { 'word\\..\\outside.xml': '<unsafe/>' } });
const invalidEncoded = docxBytes({ paragraphs: ['Safe body.'], extraFiles: { 'word/%2e%2e/outside.xml': '<unsafe/>' } });
const invalidCrc = patchZipEntry(docxBytes({ paragraphs: ['CRC must be checked.'] }), 'word/document.xml', { crcXor: 0x01000000 });
const largeXmlText = 'A'.repeat(16 * 1024 * 1024 + 1);
const largeXmlDocument = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>${largeXmlText}</w:t></w:r></w:p><w:sectPr/></w:body></w:document>`;
const oversizedXml = docxBytes({ rawDocument: largeXmlDocument });
const sizeMismatch = patchZipEntry(docxBytes({ paragraphs: ['Declared XML size differs from actual size.'] }), 'word/document.xml', { declaredUncompressedSize: 16 * 1024 * 1024 + 1 });
const dtdDocx = docxBytes({ paragraphs: ['DTD must be rejected.'], dtd: true });
const deepDocx = docxBytes({ paragraphs: ['Depth must be bounded.'], deep: 132 });
const aggregatePayload = new Uint8Array(15 * 1024 * 1024);
const aggregateEntries = Object.fromEntries(Array.from({ length: 7 }, (_, index) => [`custom/payload-${index}.bin`, aggregatePayload]));
const oversizedAggregate = docxBytes({ paragraphs: ['Aggregate package size must be bounded.'], extraFiles: aggregateEntries });
const tooManyEntries = docxBytes({ paragraphs: ['Entry count must be bounded.'], extraFiles: Object.fromEntries(Array.from({ length: 4100 }, (_, index) => [`custom/e${String(index).padStart(4, '0')}.xml`, '<x/>'])) });

const docxEntries = [
  ['docx-change-before.docx', docx.changeBefore, 'DOCX', 'Selectable OOXML paragraphs and table cells; baseline word/number values.'],
  ['docx-change-after.docx', docx.changeAfter, 'DOCX', 'Selectable OOXML paragraphs and table cells; one paragraph number and one cell value change.'],
  ['docx-insert-before.docx', docx.insertBefore, 'DOCX', 'Two stable paragraphs before a middle insertion.'],
  ['docx-insert-after.docx', docx.insertAfter, 'DOCX', 'One unique middle paragraph inserted without shifting later paragraph identities.'],
  ['docx-remove-before.docx', docx.removeBefore, 'DOCX', 'Contains the paragraph removed in the paired file.'],
  ['docx-remove-after.docx', docx.removeAfter, 'DOCX', 'Middle paragraph removed.'],
  ['docx-move-before.docx', docx.moveBefore, 'DOCX', 'Unique full-document paragraph eligible for move detection.'],
  ['docx-move-after.docx', docx.moveAfter, 'DOCX', 'Same unique paragraph moved to the end.'],
  ['docx-duplicate-before.docx', docx.duplicateBefore, 'DOCX', 'Repeated boilerplate is deliberately ambiguous as a move candidate.'],
  ['docx-duplicate-after.docx', docx.duplicateAfter, 'DOCX', 'Repeated boilerplate reordered; neither duplicate may be confidently marked moved.'],
  ['docx-split-runs-before.docx', docx.splitBefore, 'DOCX', 'One logical paragraph stored in a single run.'],
  ['docx-split-runs-after.docx', docx.splitAfter, 'DOCX', 'Same logical paragraph split across two XML runs.'],
  ['docx-tabs-before.docx', docx.tabsBefore, 'DOCX', 'Contains explicit OOXML tab elements between labels.'],
  ['docx-tabs-after.docx', docx.tabsAfter, 'DOCX', 'Same tab-separated text split into different runs.'],
  ['docx-header-before.docx', docx.headerBefore, 'DOCX', 'Body identical to paired file; unsupported header text differs.'],
  ['docx-header-after.docx', docx.headerAfter, 'DOCX', 'Body identical to paired file; unsupported header text differs.'],
  ['docx-revisions-base.docx', docx.revisionBase, 'DOCX', 'Clean baseline for tracked-revision coverage.'],
  ['docx-revisions-marked.docx', docx.revisionMarked, 'DOCX', 'Contains tracked insertion markup and trackRevisions setting.'],
  ['docx-unknown-text-before.docx', docx.futureTextBefore, 'DOCX-unsupported', 'Contains text in an unknown w:futureText element that is outside the supported extraction model.'],
  ['docx-unknown-text-after.docx', docx.futureTextAfter, 'DOCX-unsupported', 'Same visible paragraph but different text in an unknown w:futureText element. A complete identical result would be a false negative.'],
  ['docx-namespace-before.docx', docx.namespaceBefore, 'DOCX-namespace', 'Transitional WordprocessingML comparison using the conventional w prefix.'],
  ['docx-namespace-after.docx', docx.namespaceAfter, 'DOCX-namespace', 'Semantically equivalent Transitional namespace bound to x prefix with changed paragraph text.'],
  ['docx-report-text.docx', docx.reportText, 'DOCX-report-security', 'Synthetic hostile-looking paragraph text for standalone HTML report escaping checks.'],
  ['docx-benchmark-before.docx', docx.benchmarkBefore, 'DOCX-benchmark', 'Deterministic medium synthetic workload: 1,000 paragraphs and 500 simple table rows.'],
  ['docx-benchmark-after.docx', docx.benchmarkAfter, 'DOCX-benchmark', 'Same 1,500 logical units with one paragraph number and one table amount changed.'],
  ['docx-hostile-traversal.docx', invalidPath, 'hostile-DOCX', 'Valid ZIP structure with a ../ path entry.'],
  ['docx-hostile-absolute-path.docx', invalidAbsolute, 'hostile-DOCX', 'Valid ZIP structure with an absolute path entry.'],
  ['docx-hostile-backslash-path.docx', invalidBackslash, 'hostile-DOCX', 'Valid ZIP structure with a backslash traversal entry.'],
  ['docx-hostile-encoded-path.docx', invalidEncoded, 'hostile-DOCX', 'Valid ZIP structure with URI-encoded traversal segments.'],
  ['docx-hostile-crc.docx', invalidCrc, 'hostile-DOCX', 'Central and local CRC fields disagree with the actual XML bytes.'],
  ['docx-hostile-xml-size.docx', oversizedXml, 'hostile-DOCX', 'A real well-formed word/document.xml part exceeds the 16 MiB XML-part cap; its highly compressible payload keeps the ZIP small.'],
  ['docx-hostile-size-mismatch.docx', sizeMismatch, 'hostile-DOCX', 'Local and central metadata declare an XML size that does not match the compressed entry.'],
  ['docx-hostile-aggregate-size.docx', oversizedAggregate, 'hostile-DOCX', 'Seven real 15 MiB entries exceed the 100 MiB aggregate inflation cap while compressing to a small ZIP.'],
  ['docx-hostile-dtd.docx', dtdDocx, 'hostile-DOCX', 'XML contains a local-file external entity declaration.'],
  ['docx-hostile-depth.docx', deepDocx, 'hostile-DOCX', 'Well-formed nested customXml exceeds the 128-level XML depth cap.'],
  ['docx-hostile-entry-count.docx', tooManyEntries, 'hostile-DOCX', 'Contains more than the 4,096-entry package cap.'],
];

for (const [name, bytes, category, note] of docxEntries) await addFile(name, bytes, category, note);

const scanBase = ['INVOICE REVIEW 2026', 'TOTAL DUE 1250'];
const scanWordChanged = ['INVOICE REVISED 2026', 'TOTAL DUE 1250'];
const scanNumberChanged = ['INVOICE REVIEW 2026', 'TOTAL DUE 1350'];
const scanRaster = await createScanRasterizer();
const scanReference = await scanRaster.render(scanBase);
const scanWordReference = await scanRaster.render(scanWordChanged);
const scanNumberReference = await scanRaster.render(scanNumberChanged);
const scanIdentical = await pdfBytes({ title: 'Synthetic identical raster scan', pages: [{ kind: 'scan', lines: scanBase }], scanRaster });
const scanWordA = await pdfBytes({ title: 'Synthetic raster word before', pages: [{ kind: 'scan', lines: scanBase }], scanRaster });
const scanWordB = await pdfBytes({ title: 'Synthetic raster word after', pages: [{ kind: 'scan', lines: scanWordChanged }], scanRaster });
const scanNumberB = await pdfBytes({ title: 'Synthetic raster number after', pages: [{ kind: 'scan', lines: scanNumberChanged }], scanRaster });
const scanMixA = await pdfBytes({ title: 'Synthetic mixed page before', pages: [{ kind: 'text', text: 'SEARCHABLE COVER 2026', subtext: 'Selectable text page.' }, { kind: 'scan', lines: scanBase }], scanRaster });
const scanMixB = await pdfBytes({ title: 'Synthetic mixed page after', pages: [{ kind: 'text', text: 'SEARCHABLE COVER 2026', subtext: 'Selectable text page.' }, { kind: 'scan', lines: scanWordChanged }], scanRaster });
const pdfMoveBefore = await pdfBytes({ title: 'Synthetic unique PDF page move before', pages: [
  { kind: 'text', text: 'PDF MOVE COVER STABLE' },
  { kind: 'text', text: 'UNIQUE PDF PAGE TO MOVE: REF-742' },
  { kind: 'text', text: 'PDF STABLE MIDDLE ANCHOR' },
  { kind: 'text', text: 'PDF STABLE END ANCHOR' },
], scanRaster });
const pdfMoveAfter = await pdfBytes({ title: 'Synthetic unique PDF page move after', pages: [
  { kind: 'text', text: 'PDF MOVE COVER STABLE' },
  { kind: 'text', text: 'PDF STABLE MIDDLE ANCHOR' },
  { kind: 'text', text: 'PDF STABLE END ANCHOR' },
  { kind: 'text', text: 'UNIQUE PDF PAGE TO MOVE: REF-742' },
], scanRaster });
const pdfMoveVisualAfter = await pdfBytes({ title: 'Synthetic unique PDF page move with visual change', pages: [
  { kind: 'text', text: 'PDF MOVE COVER STABLE' },
  { kind: 'text', text: 'PDF STABLE MIDDLE ANCHOR' },
  { kind: 'text', text: 'PDF STABLE END ANCHOR' },
  { kind: 'text', text: 'UNIQUE PDF PAGE TO MOVE: REF-742', rectangle: true },
], scanRaster });
const pdfDuplicateBefore = await pdfBytes({ title: 'Synthetic duplicate PDF pages before', pages: [
  { kind: 'text', text: 'PDF DUPLICATE COVER' },
  { kind: 'text', text: 'Standard boilerplate repeated.' },
  { kind: 'text', text: 'Standard boilerplate repeated.' },
  { kind: 'text', text: 'PDF DUPLICATE ENDING' },
], scanRaster });
const pdfDuplicateAfter = await pdfBytes({ title: 'Synthetic duplicate PDF pages after', pages: [
  { kind: 'text', text: 'PDF DUPLICATE COVER' },
  { kind: 'text', text: 'Standard boilerplate repeated.' },
  { kind: 'text', text: 'PDF DUPLICATE ENDING' },
  { kind: 'text', text: 'Standard boilerplate repeated.' },
], scanRaster });
const cancelLines = Array.from({ length: 12 }, (_, index) => [`PAGE ${String(index + 1).padStart(2, '0')} REVIEW COPY`, `TOTAL DUE ${1200 + index * 10}`]);
const cancelPdf = await pdfBytes({ title: 'Synthetic multi-page OCR cancellation workload', pages: cancelLines.map((lines, index) => ({ kind: 'scan', lines, seed: 0xc0ffee00 + index })), scanRaster });
await scanRaster.close();

const pdfEntries = [
  ['ocr-identical-before.pdf', scanIdentical, 'scan-PDF', 'Raster-only bitmap page; no selectable text or invisible OCR text.'],
  ['ocr-identical-after.pdf', scanIdentical, 'scan-PDF', 'Byte-identical scanned page; OCR evidence must still keep outcome uncertain.'],
  ['ocr-word-before.pdf', scanWordA, 'scan-PDF', 'Raster-only synthetic English text, INVOICE REVIEW / TOTAL DUE 1250.'],
  ['ocr-word-after.pdf', scanWordB, 'scan-PDF', 'Raster-only synthetic English text; REVIEW changes to REVISED.'],
  ['ocr-number-after.pdf', scanNumberB, 'scan-PDF', 'Raster-only synthetic English text; total changes from 1250 to 1350.'],
  ['ocr-mixed-before.pdf', scanMixA, 'mixed-PDF', 'Selectable cover page plus a separate raster-only scan page.'],
  ['ocr-mixed-after.pdf', scanMixB, 'mixed-PDF', 'Selectable cover is unchanged; selected scanned page has a word change.'],
  ['pdf-move-before.pdf', pdfMoveBefore, 'move-PDF', 'Unique searchable page before global reorder.'],
  ['pdf-move-after.pdf', pdfMoveAfter, 'move-PDF', 'The same unique searchable page reordered to the end.'],
  ['pdf-move-visual-after.pdf', pdfMoveVisualAfter, 'move-PDF', 'Same page order as the moved-page pair with one red rectangle on the moved REF-742 page.'],
  ['pdf-duplicate-move-before.pdf', pdfDuplicateBefore, 'move-PDF', 'Repeated searchable boilerplate pages have identical global fingerprints.'],
  ['pdf-duplicate-move-after.pdf', pdfDuplicateAfter, 'move-PDF', 'Repeated searchable boilerplate is reordered around a stable ending page and must remain ambiguous.'],
  ['ocr-cancel-before.pdf', cancelPdf, 'scan-PDF', 'Twelve-page representative raster OCR workload; about 4.3 million output pixels per side at 1200x300/page.'],
  ['ocr-cancel-after.pdf', cancelPdf, 'scan-PDF', 'Same twelve-page workload used to verify cooperative worker cancellation.'],
];
for (const [name, bytes, category, note] of pdfEntries) await addFile(name, bytes, category, note);
await addFile('ocr-reference.png', scanReference, 'raster-reference', 'Exact grayscale bitmap embedded in the scan-only PDFs; rendered from the repository Liberation Sans font.');
await addFile('ocr-reference-word-changed.png', scanWordReference, 'raster-reference', 'Word-change raster counterpart embedded in the scan-only PDFs.');
await addFile('ocr-reference-number-changed.png', scanNumberReference, 'raster-reference', 'Number-change raster counterpart embedded in the scan-only PDFs.');

const cases = [
  { id: 'docx-paragraph-and-cell-change', format: 'docx', before: 'docx-change-before.docx', after: 'docx-change-after.docx', expectation: { outcome: 'changed', requiresCellChanges: true, requiresDocxEvidence: true } },
  { id: 'docx-insert-middle', format: 'docx', before: 'docx-insert-before.docx', after: 'docx-insert-after.docx', expectation: { outcome: 'changed', requiresAddedParagraph: true, laterParagraphsRemainAligned: true } },
  { id: 'docx-remove-middle', format: 'docx', before: 'docx-remove-before.docx', after: 'docx-remove-after.docx', expectation: { outcome: 'changed', requiresRemovedParagraph: true } },
  { id: 'docx-unique-move', format: 'docx', before: 'docx-move-before.docx', after: 'docx-move-after.docx', expectation: { outcome: 'changed', movedRows: 1, stableMoveId: true } },
  { id: 'docx-duplicate-ambiguity', format: 'docx', before: 'docx-duplicate-before.docx', after: 'docx-duplicate-after.docx', expectation: { outcome: 'changed', movedRows: 0, duplicateBoilerplateNotCalledMoved: true } },
  { id: 'docx-split-runs-equal-text', format: 'docx', before: 'docx-split-runs-before.docx', after: 'docx-split-runs-after.docx', expectation: { outcome: 'identical', sameLogicalParagraph: true } },
  { id: 'docx-tabs-preserved', format: 'docx', before: 'docx-tabs-before.docx', after: 'docx-tabs-after.docx', expectation: { outcome: 'identical', extractedTextContainsTab: true } },
  { id: 'docx-unsupported-header-not-identical', format: 'docx', before: 'docx-header-before.docx', after: 'docx-header-after.docx', expectation: { notIdentical: true, acceptable: ['error', 'uncertain', 'changed'], code: 'DOCX_UNSUPPORTED_FEATURE' } },
  { id: 'docx-tracked-revisions-not-identical', format: 'docx', before: 'docx-revisions-base.docx', after: 'docx-revisions-marked.docx', expectation: { notIdentical: true, acceptable: ['error', 'uncertain', 'changed'], code: 'DOCX_UNSUPPORTED_FEATURE' } },
  { id: 'docx-unknown-text-bearing-element-not-identical', format: 'docx', before: 'docx-unknown-text-before.docx', after: 'docx-unknown-text-after.docx', expectation: { notIdentical: true, acceptable: ['error', 'uncertain', 'changed'] } },
  { id: 'docx-alternate-transitional-namespace-not-identical', format: 'docx', before: 'docx-namespace-before.docx', after: 'docx-namespace-after.docx', expectation: { notIdentical: true, acceptable: ['error', 'changed'], code: 'DOCX_UNSUPPORTED_FEATURE' } },
  { id: 'docx-report-text-escaping', format: 'docx', before: 'docx-report-text.docx', after: 'docx-report-text.docx', expectation: { outcome: 'identical', sourceTextEscaped: true, noActiveHtml: true } },
  { id: 'docx-medium-benchmark', format: 'docx', before: 'docx-benchmark-before.docx', after: 'docx-benchmark-after.docx', expectation: { outcome: 'changed', unitCount: 1500, paragraphCount: 1000, tableRowCount: 500, changedParagraphs: 1, changedTableRows: 1 } },
  ...['traversal','absolute-path','backslash-path','encoded-path','crc','xml-size','size-mismatch','aggregate-size','dtd','depth','entry-count'].map((kind) => ({ id: `hostile-docx-${kind}`, format: 'docx', before: `docx-hostile-${kind}.docx`, after: 'docx-change-before.docx', expectation: { error: true, acceptableCodes: ['DOCX_PACKAGE_INVALID', 'DOCX_XML_INVALID', 'DOCX_UNSUPPORTED_FEATURE', 'INPUT_TOO_LARGE'] } })),
  { id: 'ocr-identical-scan-remains-uncertain', format: 'pdf', before: 'ocr-identical-before.pdf', after: 'ocr-identical-after.pdf', options: { ocr: { enabled: true, beforePageIndexes: [0], afterPageIndexes: [0], minimumConfidence: 0 } }, expectation: { outcome: 'uncertain', noFalseIdentical: true, textEvidenceSource: 'ocr' } },
  { id: 'ocr-word-difference', format: 'pdf', before: 'ocr-word-before.pdf', after: 'ocr-word-after.pdf', options: { ocr: { enabled: true, beforePageIndexes: [0], afterPageIndexes: [0], minimumConfidence: 0 } }, expectation: { outcome: 'changed', expectedBeforeText: 'INVOICE REVIEW', expectedAfterText: 'INVOICE REVISED', textEvidenceSource: 'ocr' } },
  { id: 'ocr-number-difference', format: 'pdf', before: 'ocr-word-before.pdf', after: 'ocr-number-after.pdf', options: { ocr: { enabled: true, beforePageIndexes: [0], afterPageIndexes: [0], minimumConfidence: 0 } }, expectation: { outcome: 'changed', expectedBeforeText: '1250', expectedAfterText: '1350', textEvidenceSource: 'ocr' } },
  { id: 'ocr-mixed-selected-only', format: 'pdf', before: 'ocr-mixed-before.pdf', after: 'ocr-mixed-after.pdf', options: { ocr: { enabled: true, beforePageIndexes: [1], afterPageIndexes: [1], minimumConfidence: 0 } }, expectation: { outcome: 'changed', selectedPageEvidence: 'ocr', unselectedPageEvidence: 'pdf-text', pageIndexes: [0, 1] } },
  { id: 'pdf-unique-page-move', format: 'pdf', before: 'pdf-move-before.pdf', after: 'pdf-move-after.pdf', expectation: { outcome: 'changed', movedRows: 1, beforePageIndex: 1, afterPageIndex: 3, stableMoveId: true } },
  { id: 'pdf-moved-page-visual-change', format: 'pdf', before: 'pdf-move-before.pdf', after: 'pdf-move-visual-after.pdf', expectation: { outcome: 'changed', movedRows: 1, changedRows: 0, beforePageIndex: 1, afterPageIndex: 3, visualChangedPixels: 'greater-than-zero' } },
  { id: 'pdf-duplicate-page-move-ambiguous', format: 'pdf', before: 'pdf-duplicate-move-before.pdf', after: 'pdf-duplicate-move-after.pdf', expectation: { movedRows: 1, movedUniqueAnchor: 'PDF DUPLICATE ENDING', duplicatePageOccurrencesPerSide: 2, duplicateBoilerplateNotCalledMoved: true } },
  { id: 'ocr-cancellation-workload', format: 'pdf', before: 'ocr-cancel-before.pdf', after: 'ocr-cancel-after.pdf', options: { ocr: { enabled: true, beforePageIndexes: Array.from({ length: 8 }, (_, index) => index), afterPageIndexes: Array.from({ length: 8 }, (_, index) => index), minimumConfidence: 0 } }, expectation: { cancellable: true, afterCancelNoResult: true, pagesPerSide: 8, pagesSelectedTotal: 16 } },
];

const manifest = {
  schemaVersion: 1,
  suite: 'DocDiff Studio v1 synthetic DOCX and offline OCR corpus',
  corpusVersion: '1.0.0',
  generator: 'examples/v1/generate.mjs',
  license: 'Apache-2.0 (same as repository LICENSE)',
  externalFixtureSources: [],
  confidentiality: 'All text and scans are synthetic. Scan-only PDF pages contain a grayscale PNG image and no selectable or hidden text layer.',
  limitsCovered: { docxInputBytes: 50 * 1024 * 1024, zipEntries: 4096, totalInflatedBytes: 100 * 1024 * 1024, xmlPartBytes: 16 * 1024 * 1024, xmlDepth: 128, ocrPagesPerComparison: 20, ocrPixelsPerPage: 1_920_000, ocrPixelsTotal: 20_000_000 },
  cases,
  files: [...files.values()].sort((a, b) => a.name.localeCompare(b.name)),
};

await mkdir(CORPUS, { recursive: true });
await writeFile(path.join(ROOT, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
const manifestBytes = await readFile(path.join(ROOT, 'manifest.json'));
console.log(JSON.stringify({ status: 'generated', corpusDir: CORPUS, files: files.size, cases: cases.length, manifestSha256: createHash('sha256').update(manifestBytes).digest('hex') }, null, 2));
