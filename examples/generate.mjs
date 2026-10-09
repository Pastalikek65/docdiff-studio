import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateSync } from 'node:zlib';
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';

const here = dirname(fileURLToPath(import.meta.url));
const corpusDir = resolve(here, 'corpus');
const fixedDate = new Date('2024-01-02T03:04:05.000Z');

await mkdir(corpusDir, { recursive: true });

async function createPdf(filename, pageSpecs, { title = filename } = {}) {
  const pdf = await PDFDocument.create();
  pdf.setTitle(title);
  pdf.setAuthor('DocDiff Studio synthetic acceptance corpus');
  pdf.setSubject('Deterministic synthetic fixture; contains no personal data');
  pdf.setCreator('examples/generate.mjs');
  pdf.setProducer('pdf-lib 1.17.1');
  pdf.setCreationDate(fixedDate);
  pdf.setModificationDate(fixedDate);
  const font = await pdf.embedFont(StandardFonts.Helvetica);

  for (const spec of pageSpecs) {
    const size = spec.size ?? [612, 792];
    const page = pdf.addPage(size);
    const firstLineY = size[1] > 792 ? size[1] - 72 : 720;
    for (const [index, line] of (spec.lines ?? []).entries()) {
      page.drawText(line, {
        x: 54,
        y: firstLineY - index * 38,
        size: 20,
        font,
        color: rgb(0.09, 0.18, 0.28),
      });
    }
    for (const rectangle of spec.rectangles ?? []) {
      page.drawRectangle({
        x: rectangle.x,
        y: rectangle.y,
        width: rectangle.width,
        height: rectangle.height,
        color: rgb(...rectangle.color),
        borderColor: rgb(...(rectangle.borderColor ?? rectangle.color)),
        borderWidth: rectangle.borderWidth ?? 0,
      });
    }
    if (spec.imagePng) {
      const image = await pdf.embedPng(spec.imagePng);
      page.drawImage(image, {
        x: 54,
        y: 500,
        width: 504,
        height: 226,
      });
    }
  }

  const bytes = await pdf.save({ useObjectStreams: false, updateMetadata: false });
  const outputPath = resolve(corpusDir, filename);
  await writeFile(outputPath, bytes);
  return bytes;
}

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const name = Buffer.from(type, 'ascii');
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const checksum = Buffer.alloc(4);
  checksum.writeUInt32BE(crc32(Buffer.concat([name, data])));
  return Buffer.concat([length, name, data, checksum]);
}

const glyphs = {
  A: ['01110', '10001', '10001', '11111', '10001', '10001', '10001'],
  C: ['01111', '10000', '10000', '10000', '10000', '10000', '01111'],
  E: ['11111', '10000', '10000', '11110', '10000', '10000', '11111'],
  G: ['01111', '10000', '10000', '10111', '10001', '10001', '01111'],
  I: ['11111', '00100', '00100', '00100', '00100', '00100', '11111'],
  L: ['10000', '10000', '10000', '10000', '10000', '10000', '11111'],
  N: ['10001', '11001', '11001', '10101', '10011', '10011', '10001'],
  O: ['01110', '10001', '10001', '10001', '10001', '10001', '01110'],
  S: ['01111', '10000', '10000', '01110', '00001', '00001', '11110'],
  '0': ['01110', '10001', '10011', '10101', '11001', '10001', '01110'],
  '1': ['00100', '01100', '00100', '00100', '00100', '00100', '01110'],
  '8': ['01110', '10001', '10001', '01110', '10001', '10001', '01110'],
};

function makeImageOnlyPng() {
  const width = 420;
  const height = 188;
  const pixels = Buffer.alloc(width * height * 3, 255);
  const setPixel = (x, y, color) => {
    const offset = (y * width + x) * 3;
    pixels[offset] = color[0];
    pixels[offset + 1] = color[1];
    pixels[offset + 2] = color[2];
  };

  // Draw a border and a bitmap label so PDF.js must decode actual image pixels;
  // the label is not a PDF text object and is deliberately not OCR'd by v1.
  for (let x = 0; x < width; x += 1) {
    setPixel(x, 0, [32, 52, 77]);
    setPixel(x, height - 1, [32, 52, 77]);
  }
  for (let y = 0; y < height; y += 1) {
    setPixel(0, y, [32, 52, 77]);
    setPixel(width - 1, y, [32, 52, 77]);
  }
  const label = 'SCAN 0081';
  const scale = 8;
  const charAdvance = 6 * scale;
  const labelWidth = label.length * charAdvance - scale;
  const startX = Math.floor((width - labelWidth) / 2);
  const startY = 74;
  [...label].forEach((character, characterIndex) => {
    const glyph = glyphs[character];
    if (!glyph) return;
    glyph.forEach((row, glyphY) => {
      [...row].forEach((bit, glyphX) => {
        if (bit !== '1') return;
        for (let dy = 0; dy < scale; dy += 1) {
          for (let dx = 0; dx < scale; dx += 1) {
            setPixel(startX + characterIndex * charAdvance + glyphX * scale + dx, startY + glyphY * scale + dy, [17, 87, 112]);
          }
        }
      });
    });
  });

  const scanlines = Buffer.alloc((width * 3 + 1) * height);
  for (let y = 0; y < height; y += 1) {
    const rowOffset = y * (width * 3 + 1);
    scanlines[rowOffset] = 0;
    pixels.copy(scanlines, rowOffset + 1, y * width * 3, (y + 1) * width * 3);
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 2;
  header[10] = 0;
  header[11] = 0;
  header[12] = 0;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk('IHDR', header),
    pngChunk('IDAT', deflateSync(scanlines, { level: 9 })),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

const corpus = [];
async function record(filename, bytes, description, expected) {
  corpus.push({
    file: `corpus/${filename}`,
    description,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    bytes: bytes.length,
    expected,
  });
}

const identical = await createPdf('identical-before.pdf', [{ lines: ['Acceptance fixture: identical', 'Reference number: 42'] }]);
await writeFile(resolve(corpusDir, 'identical-after.pdf'), identical);
await record('identical-before.pdf', identical, 'Before side of byte-identical pair.', { outcome: 'identical', rows: [{ status: 'unchanged', beforePage: 0, afterPage: 0 }] });
await record('identical-after.pdf', identical, 'After side of byte-identical pair.', { outcome: 'identical', rows: [{ status: 'unchanged', beforePage: 0, afterPage: 0 }] });

const wordNumberBefore = await createPdf('word-number-before.pdf', [{ lines: ['Status: pending', 'Total: 128,750'] }]);
const wordNumberAfter = await createPdf('word-number-after.pdf', [{ lines: ['Status: approved', 'Total: 182,750'] }]);
await record('word-number-before.pdf', wordNumberBefore, 'Before side with a status word and number.', { outcome: 'changed', rows: [{ status: 'changed', beforePage: 0, afterPage: 0, hasRemovedText: true }] });
await record('word-number-after.pdf', wordNumberAfter, 'After side with both a changed word and number.', { outcome: 'changed', rows: [{ status: 'changed', beforePage: 0, afterPage: 0, hasAddedText: true }] });

const anchors = ['Anchor A', 'Anchor B', 'Anchor C', 'Anchor D'].map((line) => ({ lines: [line] }));
const beforeInsertion = await createPdf('insert-middle-before.pdf', anchors);
const afterInsertion = await createPdf('insert-middle-after.pdf', [anchors[0], anchors[1], { lines: ['Inserted middle page'] }, anchors[2], anchors[3]]);
await record('insert-middle-before.pdf', beforeInsertion, 'Four stable anchor pages before a middle-page insertion.', { outcome: 'changed' });
await record('insert-middle-after.pdf', afterInsertion, 'Same anchors plus one page between B and C; later anchors must remain aligned.', {
  outcome: 'changed',
  rows: [
    { status: 'unchanged', beforePage: 0, afterPage: 0 },
    { status: 'unchanged', beforePage: 1, afterPage: 1 },
    { status: 'added', beforePage: null, afterPage: 2 },
    { status: 'unchanged', beforePage: 2, afterPage: 3 },
    { status: 'unchanged', beforePage: 3, afterPage: 4 },
  ],
});

const beforeVisual = await createPdf('visual-only-before.pdf', [{
  lines: ['Visual-only fixture: same selectable text'],
  rectangles: [{ x: 72, y: 360, width: 160, height: 90, color: [0.05, 0.43, 0.35] }],
}]);
const afterVisual = await createPdf('visual-only-after.pdf', [{
  lines: ['Visual-only fixture: same selectable text'],
  rectangles: [{ x: 72, y: 360, width: 160, height: 90, color: [0.68, 0.16, 0.26] }],
}]);
await record('visual-only-before.pdf', beforeVisual, 'Text is the same; a filled rectangle is teal.', { outcome: 'changed', rows: [{ status: 'changed', beforePage: 0, afterPage: 0, textEqual: true, visualChanged: true }] });
await record('visual-only-after.pdf', afterVisual, 'Text is the same; the same rectangle is red.', { outcome: 'changed', rows: [{ status: 'changed', beforePage: 0, afterPage: 0, textEqual: true, visualChanged: true }] });

const scannedImage = makeImageOnlyPng();
const scanned = await createPdf('scanned-image-only.pdf', [{ imagePng: scannedImage }], { title: 'Image-only scanned page fixture' });
const scannedCopy = await createPdf('scanned-image-only-copy.pdf', [{ imagePng: scannedImage }], { title: 'Image-only scanned page fixture rebuilt' });
await record('scanned-image-only.pdf', scanned, 'A real PDF page with an embedded PNG and no PDF text layer; the label exists only as image pixels.', { extractedText: '', renderedPixelsNonWhite: true, outcome: 'uncertain' });
await record('scanned-image-only-copy.pdf', scannedCopy, 'Same raster pixels and no PDF text layer, rebuilt with different metadata so the PDF bytes differ.', { extractedText: '', renderedPixelsNonWhite: true, outcome: 'uncertain' });

const malformed = Buffer.from('%PDF-1.7\n1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\n', 'ascii');
await writeFile(resolve(corpusDir, 'malformed-truncated.pdf'), malformed);
await record('malformed-truncated.pdf', malformed, 'Truncated PDF object graph with no pages, xref table, or EOF marker.', { error: 'PDF_DECODE_FAILED' });

const tooManyPages = await createPdf('resource-many-pages.pdf', Array.from({ length: 201 }, (_, index) => ({ lines: [`Resource fixture page ${index + 1}`] })));
await record('resource-many-pages.pdf', tooManyPages, '201 valid pages for page-count budget review; expectations depend on the shipped cap.', { resourceLimitCandidate: 'pageCount', minimumPages: 201 });

const largeText = await createPdf('resource-large-text.pdf', Array.from({ length: 41 }, () => ({
  size: [16_000, 2_400],
  lines: Array.from({ length: 50 }, () => 'A'.repeat(1_000)),
})));
await record('resource-large-text.pdf', largeText, '41 valid pages with 50,000 selectable ASCII characters per page, exceeding the 2 million document text cap while staying below the 100,000 character page cap.', { resourceLimitCandidate: 'textCharacters', pageCount: 41, minimumTextCharacters: 2_050_000, maximumTextCharactersPerPage: 100_000 });

const largeCanvasPage = [{ size: [9000, 9000], lines: ['Large page for safe downscale review'] }];
const largeCanvas = await createPdf('resource-large-canvas.pdf', largeCanvasPage);
const largeCanvasCopy = await createPdf('resource-large-canvas-copy.pdf', largeCanvasPage, { title: 'Large page for safe downscale review, rebuilt' });
await record('resource-large-canvas.pdf', largeCanvas, 'One valid 9000 by 9000 point page; its physical area exceeds 80 million pixels but should be downscaled to the configured per-page render bounds.', { resourceReview: 'safeDownscale', outcome: 'identical' });
await record('resource-large-canvas-copy.pdf', largeCanvasCopy, 'Same selectable page and physical dimensions, with different metadata so matching requires PDF.js content/rendering.', { resourceReview: 'safeDownscale', outcome: 'identical' });

const largeRenderedTotal = await createPdf('resource-rendered-pixels.pdf', Array.from({ length: 110 }, (_, index) => ({
  size: [794, 1000],
  lines: [`Rendered-pixel budget page ${index + 1}`],
})));
await record('resource-rendered-pixels.pdf', largeRenderedTotal, '110 valid 794 by 1000 point pages; the before document alone exceeds 80 million scale-1 pixels while each page stays below the per-page render cap.', { resourceLimitCandidate: 'decodedPixels', minimumPixelsAtScale1: 87_340_000 });

const cancelWorkloadPages = Array.from({ length: 10 }, (_, index) => ({
  size: [1200, 1600],
  lines: [`Cancellation workload page ${index + 1}`, 'Same visible content on both sides'],
  rectangles: [{ x: 120, y: 360, width: 600, height: 260, color: [0.05, 0.43, 0.35] }],
}));
const cancelWorkload = await createPdf('cancel-workload.pdf', cancelWorkloadPages);
const cancelWorkloadCopy = await createPdf('cancel-workload-copy.pdf', cancelWorkloadPages, { title: 'Cancellation workload rebuilt' });
await record('cancel-workload.pdf', cancelWorkload, 'Ten valid large render pages for worker-termination acceptance; a same-content copy is provided.', { resourceReview: 'workerTermination' });
await record('cancel-workload-copy.pdf', cancelWorkloadCopy, 'Same page content at a separate PDF byte identity, for cancellation acceptance.', { resourceReview: 'workerTermination' });

const manifest = {
  version: 1,
  generator: 'examples/generate.mjs',
  pdfLibrary: 'pdf-lib 1.17.1',
  fixedPdfDates: fixedDate.toISOString(),
  files: corpus,
};
await writeFile(resolve(corpusDir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');

// Read each output back from disk so manifest hashes also validate persisted bytes.
for (const item of corpus) {
  const diskBytes = await readFile(resolve(here, item.file));
  if (createHash('sha256').update(diskBytes).digest('hex') !== item.sha256) {
    throw new Error(`Non-deterministic write detected for ${item.file}`);
  }
}

console.log(`Wrote ${corpus.length} deterministic PDF fixtures to ${corpusDir}`);
