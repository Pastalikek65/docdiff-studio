import { alignBlocks, blockFingerprint, type ComparableBlock } from './block-alignment';
import { parseDocxDocument, type DocxBlock } from './docx-parser';
import { COMPARISON_LIMITS, DEFAULT_COMPARE_OPTIONS_V2 } from './limits';
import { pngDataUrlToBlob } from './image-data';
import { comparePngDataUrls } from './visual-png-diff';
import { preflightReportOutputsV2 } from './report-v2';
import { comparePdfDocuments } from './pdf-engine';
import { omitSelectedLines, singleTextChange, textChanges } from './text-diff';
import {
  CompareError,
  type CompareOptions,
  type CompareOptionsV2,
  type CompareProgress,
  type CompareRequestV2,
  type ComparisonResult,
  type ComparisonResultV2,
  type ComparisonRow,
  type ComparisonRowV2,
  type DocumentInputV2,
  type DocumentLocationV2,
  type OcrRuntimeV2,
  type TextEvidenceV2,
} from './types';
import { sanitizeDocumentName, validateOptions } from './validation';

interface V2Block extends ComparableBlock {
  location: DocumentLocationV2;
  evidence: TextEvidenceV2;
  row?: ComparisonRowV2;
}

interface ValidatedRequest {
  before: DocumentInputV2;
  after: DocumentInputV2;
  options: CompareOptionsV2;
}

/** Compare tagged PDF/PDF or Transitional DOCX/DOCX inputs as schema version 2. */
export async function compareDocumentsV2(
  request: CompareRequestV2,
  onProgress?: (progress: CompareProgress) => void,
  ocrRuntime?: OcrRuntimeV2,
): Promise<ComparisonResultV2> {
  try {
    return await compareV2(request, onProgress, ocrRuntime);
  } finally {
    if (ocrRuntime) {
      try { await ocrRuntime.terminate(); }
      catch { /* Runtime teardown is best-effort; the renderer also owns cancellation. */ }
    }
  }
}

async function compareV2(
  request: CompareRequestV2,
  onProgress: ((progress: CompareProgress) => void) | undefined,
  ocrRuntime: OcrRuntimeV2 | undefined,
): Promise<ComparisonResultV2> {
  const startedAt = performance.now();
  const validated = validateRequest(request);
  const { before, after, options } = validated;
  const beforeHash = await sha256(before.bytes);
  checkTime(startedAt);
  const afterHash = await sha256(after.bytes);
  checkTime(startedAt);

  let result: ComparisonResultV2;
  if (before.format === 'pdf') {
    let pdfRenderedPixels = 0;
    const legacy = await comparePdfDocuments(
      { name: before.name, bytes: before.bytes },
      { name: after.name, bytes: after.bytes },
      options,
      (progress) => {
        // The v1 engine's completion event precedes v2 mapping/exports; only
        // v2 reports completion after both schema-2 formats pass preflight.
        if (progress.phase !== 'Comparison complete') reportProgress(onProgress, progress);
      },
      (pixels) => { pdfRenderedPixels = pixels; },
    );
    checkTime(startedAt);
    result = fromPdfResult(legacy, beforeHash, afterHash, options);
    validateOcrSelection(options, result.documents.before.physicalPageCount!, result.documents.after.physicalPageCount!);
    if (options.ocr.enabled) await applyOcr(result, options, ocrRuntime, onProgress, startedAt, pdfRenderedPixels);
    addNoTextWarnings(result, options.ocr.enabled);
    result = withMoves(result, options.detectMoves);
    if (options.detectMoves) await addMovedPageVisuals(result, pdfRenderedPixels, startedAt);
  } else {
    if (options.ocr.enabled || options.ocr.beforePageIndexes.length || options.ocr.afterPageIndexes.length) {
      throw new CompareError('INVALID_INPUT', 'OCR page selections are only available when comparing PDFs.');
    }
    reportProgress(onProgress, { phase: 'Reading DOCX packages', completed: 0, total: 2 });
    const beforeDocx = parseDocxDocument(before.bytes, COMPARISON_LIMITS.maxTextCharactersTotal);
    checkTime(startedAt);
    const beforeCharacters = beforeDocx.blocks.reduce((sum, block) => sum + block.text.length, 0);
    const afterDocx = parseDocxDocument(after.bytes, COMPARISON_LIMITS.maxTextCharactersTotal - beforeCharacters);
    checkTime(startedAt);
    reportProgress(onProgress, { phase: 'Reading DOCX packages', completed: 2, total: 2 });
    result = compareDocxBlocks(before, after, beforeHash, afterHash, beforeDocx.blocks, afterDocx.blocks, options, [
      ...beforeDocx.warnings,
      ...afterDocx.warnings,
    ]);
  }
  checkTime(startedAt);
  preflightReportOutputsV2(result, () => reportProgress(onProgress, {
    phase: 'Comparison complete', completed: 1, total: 1,
  }));
  return result;
}

function validateRequest(request: CompareRequestV2): ValidatedRequest {
  if (!request || typeof request !== 'object' || request.schemaVersion !== 2) {
    throw new CompareError('INVALID_INPUT', 'The version 2 comparison request is invalid.');
  }
  if (!request.before || !request.after || (request.before.format !== 'pdf' && request.before.format !== 'docx')
    || (request.after.format !== 'pdf' && request.after.format !== 'docx')) {
    throw new CompareError('INVALID_INPUT', 'Select two supported PDF or DOCX documents.');
  }
  if (request.before.format !== request.after.format) {
    throw new CompareError('FORMAT_MISMATCH', 'PDF documents can only be compared with PDFs, and DOCX documents with DOCX files.');
  }
  const before = validateInput(request.before);
  const after = validateInput(request.after);
  if (before.bytes.byteLength + after.bytes.byteLength > COMPARISON_LIMITS.maxCombinedInputBytes) {
    throw new CompareError('INPUT_TOO_LARGE', 'The two documents together exceed the supported input size.');
  }
  const base = validateOptions(request.options as Partial<CompareOptions>);
  const raw = request.options as Partial<CompareOptionsV2> | undefined;
  if (raw?.detectMoves !== undefined && typeof raw.detectMoves !== 'boolean') {
    throw new CompareError('INVALID_INPUT', 'The move-detection option must be true or false.');
  }
  const ocrRaw = raw?.ocr ?? DEFAULT_COMPARE_OPTIONS_V2.ocr;
  if (!ocrRaw || typeof ocrRaw !== 'object' || typeof ocrRaw.enabled !== 'boolean'
    || !Array.isArray(ocrRaw.beforePageIndexes) || !Array.isArray(ocrRaw.afterPageIndexes)
    || !Number.isFinite(ocrRaw.minimumConfidence) || ocrRaw.minimumConfidence < 0 || ocrRaw.minimumConfidence > 100) {
    throw new CompareError('INVALID_INPUT', 'The OCR options are invalid.');
  }
  validatePageIndexes(ocrRaw.beforePageIndexes);
  validatePageIndexes(ocrRaw.afterPageIndexes);
  if (ocrRaw.beforePageIndexes.length + ocrRaw.afterPageIndexes.length > COMPARISON_LIMITS.maxOcrPages) {
    throw new CompareError('OCR_PAGE_LIMIT_EXCEEDED', `Select no more than ${COMPARISON_LIMITS.maxOcrPages} pages for OCR in one comparison.`);
  }
  return {
    before,
    after,
    options: {
      ...base,
      detectMoves: raw?.detectMoves ?? DEFAULT_COMPARE_OPTIONS_V2.detectMoves,
      ocr: {
        enabled: ocrRaw.enabled,
        beforePageIndexes: [...ocrRaw.beforePageIndexes],
        afterPageIndexes: [...ocrRaw.afterPageIndexes],
        minimumConfidence: ocrRaw.minimumConfidence,
      },
    },
  };
}

function validateInput(input: DocumentInputV2): DocumentInputV2 {
  if (!input || typeof input !== 'object' || typeof input.name !== 'string' || !(input.bytes instanceof Uint8Array)) {
    throw new CompareError('INVALID_INPUT', 'Choose a document with a name and byte data.');
  }
  if (input.bytes.byteLength === 0) throw new CompareError('INVALID_INPUT', 'The selected file is empty.');
  if (input.bytes.byteLength > COMPARISON_LIMITS.maxInputBytesPerDocument) {
    throw new CompareError('INPUT_TOO_LARGE', 'Each document must be no larger than 50 MiB.');
  }
  if (input.name.length > 1_024) throw new CompareError('INVALID_INPUT', 'The document name is too long.');
  if (input.format === 'pdf') {
    if (findBytes(input.bytes.subarray(0, Math.min(input.bytes.length, 1_024)), [0x25, 0x50, 0x44, 0x46, 0x2d]) < 0) {
      throw new CompareError('FORMAT_MISMATCH', 'The selected file bytes do not match the declared PDF format.');
    }
  } else if (input.bytes[0] !== 0x50 || input.bytes[1] !== 0x4b) {
    throw new CompareError('FORMAT_MISMATCH', 'The selected file bytes do not match the declared DOCX ZIP format.');
  }
  return { format: input.format, name: sanitizeDocumentName(input.name), bytes: input.bytes };
}

function validatePageIndexes(indexes: number[]): void {
  const seen = new Set<number>();
  for (const index of indexes) {
    if (!Number.isSafeInteger(index) || index < 0 || index >= COMPARISON_LIMITS.maxPagesPerDocument || seen.has(index)) {
      throw new CompareError('INVALID_INPUT', 'OCR page selections must be unique valid zero-based page indexes.');
    }
    seen.add(index);
  }
}

function validateOcrSelection(options: CompareOptionsV2, beforePages: number, afterPages: number): void {
  if (!options.ocr.enabled) return;
  if (options.ocr.beforePageIndexes.some((index) => index >= beforePages)
    || options.ocr.afterPageIndexes.some((index) => index >= afterPages)) {
    throw new CompareError('INVALID_INPUT', 'An OCR page selection is outside the document page range.');
  }
  if (options.ocr.beforePageIndexes.length + options.ocr.afterPageIndexes.length === 0) {
    throw new CompareError('INVALID_INPUT', 'Select at least one page before enabling OCR.');
  }
}

function fromPdfResult(
  legacy: ComparisonResult,
  beforeHash: string,
  afterHash: string,
  options: CompareOptionsV2,
): ComparisonResultV2 {
  const rows = legacy.rows.map((row) => pdfRow(row, options));
  return {
    schemaVersion: 2,
    documents: {
      before: { name: sanitizeDocumentName(legacy.documents.before.name), format: 'pdf', sha256: beforeHash, unitKind: 'pdf-page', unitCount: legacy.documents.before.pageCount, physicalPageCount: legacy.documents.before.pageCount },
      after: { name: sanitizeDocumentName(legacy.documents.after.name), format: 'pdf', sha256: afterHash, unitKind: 'pdf-page', unitCount: legacy.documents.after.pageCount, physicalPageCount: legacy.documents.after.pageCount },
    },
    options,
    rows,
    summary: summarize(rows),
    warnings: legacy.warnings.filter((warning) => !warning.startsWith('Text could not be extracted from')),
    outcome: legacy.outcome,
    certainty: legacy.outcome === 'uncertain' ? 'incomplete' : 'complete',
  };
}

function pdfRow(row: ComparisonRow, options: CompareOptionsV2): ComparisonRowV2 {
  return {
    id: row.id,
    status: row.status,
    beforeLocation: row.beforePage === null ? null : { format: 'pdf', kind: 'page', index: row.beforePage },
    afterLocation: row.afterPage === null ? null : { format: 'pdf', kind: 'page', index: row.afterPage },
    beforeText: row.beforeText,
    afterText: row.afterText,
    changes: row.changes,
    textEvidence: { before: pdfEvidence(row.beforeText), after: pdfEvidence(row.afterText) },
    ...(row.beforeImageDataUrl ? { beforeImageDataUrl: row.beforeImageDataUrl } : {}),
    ...(row.afterImageDataUrl ? { afterImageDataUrl: row.afterImageDataUrl } : {}),
    ...(row.visual ? { visual: row.visual } : {}),
  };
}

function pdfEvidence(text: string): TextEvidenceV2 {
  return text.trim() ? { source: 'pdf-text' } : { source: 'none' };
}

function compareDocxBlocks(
  before: DocumentInputV2,
  after: DocumentInputV2,
  beforeHash: string,
  afterHash: string,
  beforeBlocks: DocxBlock[],
  afterBlocks: DocxBlock[],
  options: CompareOptionsV2,
  warnings: string[],
): ComparisonResultV2 {
  const alignments = alignBlocks(beforeBlocks, afterBlocks);
  const rows = alignments.map((pair, index) => {
    const left = pair.before === null ? undefined : beforeBlocks[pair.before];
    const right = pair.after === null ? undefined : afterBlocks[pair.after];
    return rowFromBlocks(left, right, index, options);
  });
  const completed = options.detectMoves ? reclassifyMoves(rows, beforeBlocks.map(comparable), afterBlocks.map(comparable), options) : rows;
  const allWarnings = [...new Set(warnings)];
  const summary = summarize(completed);
  const certainty = allWarnings.length ? 'incomplete' : 'complete';
  return {
    schemaVersion: 2,
    documents: {
      before: { name: sanitizeDocumentName(before.name), format: 'docx', sha256: beforeHash, unitKind: 'docx-block', unitCount: beforeBlocks.length },
      after: { name: sanitizeDocumentName(after.name), format: 'docx', sha256: afterHash, unitKind: 'docx-block', unitCount: afterBlocks.length },
    },
    options,
    rows: completed,
    summary,
    warnings: allWarnings,
    outcome: outcomeFor(completed, certainty),
    certainty,
  };
}

function rowFromBlocks(left: DocxBlock | undefined, right: DocxBlock | undefined, index: number, options: CompareOptionsV2): ComparisonRowV2 {
  const beforeText = left ? left.text : '';
  const afterText = right ? right.text : '';
  const changes = left && right
    ? textChanges(beforeText, afterText, options)
    : left ? singleTextChange(beforeText, 'removed') : singleTextChange(afterText, 'added');
  const beforeCells = left?.cells;
  const afterCells = right?.cells;
  const cellChanges = beforeCells || afterCells
    ? compareCells(beforeCells, afterCells, options)
    : undefined;
  const changed = changes.some((change) => change.kind !== 'equal')
    || Boolean(cellChanges?.some((cell) => cell.beforeCellIndex === null || cell.afterCellIndex === null))
    || Boolean(cellChanges?.some((cell) => cell.changes.some((change) => change.kind !== 'equal')));
  const status = !left ? 'added' : !right ? 'removed' : changed ? 'changed' : 'unchanged';
  return {
    id: `block-${index + 1}`,
    status,
    beforeLocation: left ? docxLocation(left) : null,
    afterLocation: right ? docxLocation(right) : null,
    beforeText,
    afterText,
    changes,
    textEvidence: {
      before: { source: left ? 'docx-xml' : 'none' },
      after: { source: right ? 'docx-xml' : 'none' },
    },
    ...(beforeCells ? { beforeCells } : {}),
    ...(afterCells ? { afterCells } : {}),
    ...(cellChanges ? { cellChanges } : {}),
  };
}

function compareCells(before: string[] | undefined, after: string[] | undefined, options: CompareOptionsV2) {
  const left = before ?? [];
  const right = after ?? [];
  const changes = [];
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    const beforeValue = left[index];
    const afterValue = right[index];
    const cellDiff = beforeValue === undefined
      ? singleTextChange(afterValue ?? '', 'added')
      : afterValue === undefined
        ? singleTextChange(beforeValue, 'removed')
        : textChanges(beforeValue, afterValue, options);
    changes.push({
      beforeCellIndex: beforeValue === undefined ? null : index,
      afterCellIndex: afterValue === undefined ? null : index,
      changes: cellDiff.length ? cellDiff : [{ kind: 'equal' as const, text: beforeValue ?? afterValue ?? '' }],
    });
  }
  return changes;
}

function docxLocation(block: DocxBlock): DocumentLocationV2 {
  return block.kind === 'paragraph'
    ? { format: 'docx', kind: 'paragraph', index: block.index }
    : { format: 'docx', kind: 'table-row', index: block.index, tableIndex: block.tableIndex!, rowIndex: block.rowIndex! };
}

function comparable(block: DocxBlock): ComparableBlock {
  return { kind: block.kind, text: block.text, ...(block.cells ? { cells: block.cells } : {}) };
}

async function applyOcr(
  result: ComparisonResultV2,
  options: CompareOptionsV2,
  runtime: OcrRuntimeV2 | undefined,
  onProgress: ((progress: CompareProgress) => void) | undefined,
  startedAt: number,
  pdfRenderedPixels: number,
): Promise<void> {
  const selections = [
    ...options.ocr.beforePageIndexes.map((pageIndex) => ({ side: 'before' as const, pageIndex })),
    ...options.ocr.afterPageIndexes.map((pageIndex) => ({ side: 'after' as const, pageIndex })),
  ];
  if (!runtime && selections.some(({ side, pageIndex }) => {
    const row = findPdfRow(result.rows, side, pageIndex);
    const text = side === 'before' ? row?.beforeText : row?.afterText;
    return Boolean(row && !text?.trim());
  })) {
    throw new CompareError('OCR_UNAVAILABLE', 'Local English OCR is unavailable in this comparison worker.');
  }
  let ocrPixels = 0;
  let textCharacters = result.rows.reduce((sum, row) => sum + row.beforeText.length + row.afterText.length, 0);
  const warnings = new Set(result.warnings);
  for (let index = 0; index < selections.length; index += 1) {
    checkTime(startedAt);
    const selection = selections[index];
    const row = findPdfRow(result.rows, selection.side, selection.pageIndex);
    if (!row) throw new CompareError('PDF_DECODE_FAILED', 'A selected PDF page could not be located for OCR.');
    const sideText = selection.side === 'before' ? row.beforeText : row.afterText;
    if (sideText.trim()) {
      warnings.add(`OCR was skipped for the selected ${selection.side} page ${selection.pageIndex + 1} because PDF text was present.`);
      reportProgress(onProgress, { phase: 'Recognizing selected PDF pages', completed: index + 1, total: selections.length });
      continue;
    }
    if (!runtime) throw new CompareError('OCR_UNAVAILABLE', 'Local English OCR is unavailable in this comparison worker.');
    const imageDataUrl = selection.side === 'before' ? row.beforeImageDataUrl : row.afterImageDataUrl;
    if (!imageDataUrl || typeof createImageBitmap !== 'function') {
      throw new CompareError('OCR_FAILED', 'The selected PDF page image is unavailable for OCR.');
    }
    let image: Blob;
    let bitmap: ImageBitmap;
    try {
      image = pngDataUrlToBlob(imageDataUrl);
      bitmap = await createImageBitmap(image);
    } catch {
      throw new CompareError('OCR_FAILED', 'The selected PDF page image could not be prepared for OCR.');
    }
    const pagePixels = bitmap.width * bitmap.height;
    bitmap.close();
    if (!Number.isSafeInteger(pagePixels) || pagePixels <= 0 || pagePixels > COMPARISON_LIMITS.maxOcrPixelsPerPage) {
      throw new CompareError('PIXEL_LIMIT_EXCEEDED', 'A selected OCR page exceeds the supported raster size.');
    }
    ocrPixels += pagePixels;
    if (ocrPixels > COMPARISON_LIMITS.maxOcrPixelsTotal || pdfRenderedPixels + ocrPixels > COMPARISON_LIMITS.maxRenderedPixels) {
      throw new CompareError('PIXEL_LIMIT_EXCEEDED', 'The selected OCR pages exceed the supported aggregate raster budget.');
    }
    if (image.size > 12 * 1024 * 1024) throw new CompareError('OCR_FAILED', 'The selected PDF page image exceeds the OCR runtime input limit.');
    let recognized: Awaited<ReturnType<OcrRuntimeV2['recognizePage']>>;
    try {
      recognized = await runtime.recognizePage({ ...selection, image }, (progress) => {
        const fraction = Number.isFinite(progress?.progress) ? Math.max(0, Math.min(1, progress.progress)) : 0;
        reportProgress(onProgress, {
          phase: `${progress?.phase || 'Running local OCR'} · ${selection.side} page ${selection.pageIndex + 1}`,
          completed: Math.min(selections.length, index + fraction),
          total: selections.length,
        });
      });
    } catch (error) {
      if (error instanceof CompareError && error.code === 'CANCELLED') throw error;
      if (error instanceof Error && error.name === 'AbortError') throw new CompareError('CANCELLED', 'Comparison cancelled during local OCR.');
      throw new CompareError('OCR_FAILED', 'Local English OCR could not read a selected page.');
    }
    if (!recognized || typeof recognized.text !== 'string') throw new CompareError('OCR_FAILED', 'Local English OCR returned an invalid result.');
    warnings.add('OCR-derived text is heuristic and may contain recognition errors; review the source page images before relying on text differences.');
    const text = recognized.text.replace(/\r\n?/gu, '\n');
    if (text.length > COMPARISON_LIMITS.maxPageTextCharacters) throw new CompareError('TEXT_LIMIT_EXCEEDED', 'OCR text for a selected page exceeds the supported text limit.');
    textCharacters += text.length;
    if (textCharacters > COMPARISON_LIMITS.maxTextCharactersTotal) throw new CompareError('TEXT_LIMIT_EXCEEDED', 'PDF and OCR text together exceed the supported comparison limit.');
    const confidence = typeof recognized.confidence === 'number' && Number.isFinite(recognized.confidence)
      ? Math.max(0, Math.min(100, recognized.confidence))
      : undefined;
    const evidence: TextEvidenceV2 = { source: 'ocr', ...(confidence === undefined ? {} : { confidence }) };
    if (!text.trim()) warnings.add(`OCR found no text on the selected ${selection.side} page ${selection.pageIndex + 1}.`);
    if (confidence === undefined) warnings.add(`OCR confidence was not available for the selected ${selection.side} page ${selection.pageIndex + 1}.`);
    else if (confidence < options.ocr.minimumConfidence) warnings.add(`OCR confidence was below the selected threshold on the ${selection.side} page ${selection.pageIndex + 1}.`);
    if (selection.side === 'before') {
      row.beforeText = text;
      row.textEvidence.before = evidence;
    } else {
      row.afterText = text;
      row.textEvidence.after = evidence;
    }
    row.changes = row.beforeLocation && row.afterLocation
      ? textChanges(row.beforeText, row.afterText, options)
      : row.beforeLocation ? singleTextChange(row.beforeText, 'removed') : singleTextChange(row.afterText, 'added');
    if (row.beforeLocation && row.afterLocation) {
      const textDiffers = row.changes.some((change) => change.kind !== 'equal');
      const visualDiffers = (row.visual?.changedPixels ?? 0) > 0;
      row.status = textDiffers || visualDiffers ? 'changed' : 'unchanged';
    }
    reportProgress(onProgress, { phase: 'Recognizing selected PDF pages', completed: index + 1, total: selections.length });
    checkTime(startedAt);
  }
  result.warnings = [...warnings];
  const ocrUsed = result.rows.some((row) => row.textEvidence.before.source === 'ocr' || row.textEvidence.after.source === 'ocr');
  const unreviewedEmptyPages = result.rows.some((row) => (
    (row.beforeLocation && row.textEvidence.before.source === 'none')
    || (row.afterLocation && row.textEvidence.after.source === 'none')
  ));
  result.certainty = result.certainty === 'incomplete' || unreviewedEmptyPages || ocrUsed ? 'incomplete' : 'complete';
  result.summary = summarize(result.rows);
  result.outcome = outcomeFor(result.rows, result.certainty);
}

function addNoTextWarnings(result: ComparisonResultV2, ocrEnabled: boolean): void {
  const emptyPageCount = result.rows.reduce((count, row) => count
    + (row.beforeLocation && row.textEvidence.before.source === 'none' ? 1 : 0)
    + (row.afterLocation && row.textEvidence.after.source === 'none' ? 1 : 0), 0);
  if (emptyPageCount === 0) return;
  const message = ocrEnabled
    ? `${emptyPageCount} PDF page(s) still have no extracted text after the selected OCR pages were processed.`
    : `${emptyPageCount} PDF page(s) have no selectable text; OCR was not requested.`;
  if (!result.warnings.includes(message)) result.warnings.push(message);
  result.certainty = 'incomplete';
  result.outcome = outcomeFor(result.rows, result.certainty);
}

function findPdfRow(rows: ComparisonRowV2[], side: 'before' | 'after', pageIndex: number): ComparisonRowV2 | undefined {
  return rows.find((row) => {
    const location = side === 'before' ? row.beforeLocation : row.afterLocation;
    return location?.format === 'pdf' && location.index === pageIndex;
  });
}

function withMoves(result: ComparisonResultV2, enabled: boolean): ComparisonResultV2 {
  if (enabled) {
    const beforeBlocks = blocksFromRows(result.rows, 'before');
    const afterBlocks = blocksFromRows(result.rows, 'after');
    result.rows = reclassifyMoves(result.rows, beforeBlocks, afterBlocks, result.options);
  }
  result.summary = summarize(result.rows);
  result.outcome = outcomeFor(result.rows, result.certainty);
  return result;
}

async function addMovedPageVisuals(
  result: ComparisonResultV2,
  renderedPixelUsage: number,
  startedAt: number,
): Promise<void> {
  let pixelUsage = renderedPixelUsage;
  let imageCharacterUsage = result.rows.reduce((sum, row) => sum
    + (row.beforeImageDataUrl?.length ?? 0)
    + (row.afterImageDataUrl?.length ?? 0)
    + (row.visual?.diffImageDataUrl.length ?? 0), 0);
  for (const row of result.rows) {
    if (row.status !== 'moved') continue;
    checkTime(startedAt);
    if (row.beforeLocation?.format !== 'pdf' || row.afterLocation?.format !== 'pdf'
      || !row.beforeImageDataUrl || !row.afterImageDataUrl) {
      throw new CompareError('PDF_DECODE_FAILED', 'A moved PDF page is missing a rendered preview for visual comparison.');
    }
    const difference = await comparePngDataUrls(
      row.beforeImageDataUrl,
      row.afterImageDataUrl,
      result.options.visualThreshold,
      pixelUsage,
      imageCharacterUsage,
      startedAt,
    );
    row.visual = difference.visual;
    pixelUsage += difference.pixelCost;
    imageCharacterUsage += difference.imageCharacters;
  }
}

function blocksFromRows(rows: ComparisonRowV2[], side: 'before' | 'after'): V2Block[] {
  const map = new Map<number, V2Block>();
  for (const row of rows) {
    const location = side === 'before' ? row.beforeLocation : row.afterLocation;
    if (!location) continue;
    const text = side === 'before' ? row.beforeText : row.afterText;
    const cells = side === 'before' ? row.beforeCells : row.afterCells;
    const evidence = side === 'before' ? row.textEvidence.before : row.textEvidence.after;
    const imageDataUrl = side === 'before' ? row.beforeImageDataUrl : row.afterImageDataUrl;
    map.set(location.index, {
      kind: location.kind,
      text,
      ...(cells ? { cells } : {}),
      location,
      evidence,
      row,
      ...(imageDataUrl ? { imageDataUrl } : {}),
    });
  }
  return [...map.values()].sort((a, b) => a.location.index - b.location.index);
}

function reclassifyMoves(
  rows: ComparisonRowV2[],
  beforeBlocks: Array<ComparableBlock | V2Block>,
  afterBlocks: Array<ComparableBlock | V2Block>,
  options: CompareOptionsV2,
): ComparisonRowV2[] {
  const beforeCounts = countBlockKeys(beforeBlocks);
  const afterCounts = countBlockKeys(afterBlocks);
  const removed = new Map<string, ComparisonRowV2>();
  const added = new Map<string, ComparisonRowV2>();
  for (const row of rows) {
    if (row.beforeLocation && !row.afterLocation) removed.set(blockFingerprint(blockFromRow(row, 'before')), row);
    if (!row.beforeLocation && row.afterLocation) added.set(blockFingerprint(blockFromRow(row, 'after')), row);
  }
  const replacementByAdded = new Map<ComparisonRowV2, ComparisonRowV2>();
  const removedRows = new Set<ComparisonRowV2>();
  for (const [fingerprint, beforeRow] of removed) {
    if (beforeCounts.get(fingerprint) !== 1 || afterCounts.get(fingerprint) !== 1) continue;
    const afterRow = added.get(fingerprint);
    if (!afterRow) continue;
    const beforeIndex = beforeRow.beforeLocation!.index;
    const afterIndex = afterRow.afterLocation!.index;
    const moveId = `move-${stableHash(fingerprint)}-${beforeIndex}-${afterIndex}`;
    const sameText = beforeRow.beforeText;
    const cellChanges = beforeRow.beforeCells || afterRow.afterCells
      ? compareCells(beforeRow.beforeCells, afterRow.afterCells, options)
      : undefined;
    const moveRow: ComparisonRowV2 = {
      id: moveId,
      status: 'moved',
      moveId,
      beforeLocation: beforeRow.beforeLocation,
      afterLocation: afterRow.afterLocation,
      beforeText: beforeRow.beforeText,
      afterText: afterRow.afterText,
      changes: textChanges(sameText, afterRow.afterText, options),
      textEvidence: { before: beforeRow.textEvidence.before, after: afterRow.textEvidence.after },
      ...(beforeRow.beforeCells ? { beforeCells: beforeRow.beforeCells } : {}),
      ...(afterRow.afterCells ? { afterCells: afterRow.afterCells } : {}),
      ...(cellChanges ? { cellChanges } : {}),
      ...(beforeRow.beforeImageDataUrl ? { beforeImageDataUrl: beforeRow.beforeImageDataUrl } : {}),
      ...(afterRow.afterImageDataUrl ? { afterImageDataUrl: afterRow.afterImageDataUrl } : {}),
    };
    replacementByAdded.set(afterRow, moveRow);
    removedRows.add(beforeRow);
  }
  if (!replacementByAdded.size) return rows;
  return rows.flatMap((row) => {
    if (removedRows.has(row)) return [];
    const replacement = replacementByAdded.get(row);
    return replacement ? [replacement] : [row];
  });
}

function blockFromRow(row: ComparisonRowV2, side: 'before' | 'after'): ComparableBlock {
  const location = side === 'before' ? row.beforeLocation : row.afterLocation;
  const cells = side === 'before' ? row.beforeCells : row.afterCells;
  return {
    kind: location?.kind ?? 'unknown',
    text: side === 'before' ? row.beforeText : row.afterText,
    ...(cells ? { cells } : {}),
  };
}

function countBlockKeys(blocks: Array<ComparableBlock | V2Block>): Map<string, number> {
  const result = new Map<string, number>();
  for (const block of blocks) {
    const key = blockFingerprint(block);
    result.set(key, (result.get(key) ?? 0) + 1);
  }
  return result;
}

function stableHash(value: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

function summarize(rows: ComparisonRowV2[]): ComparisonResultV2['summary'] {
  return {
    unchanged: rows.filter((row) => row.status === 'unchanged').length,
    changed: rows.filter((row) => row.status === 'changed').length,
    added: rows.filter((row) => row.status === 'added').length,
    removed: rows.filter((row) => row.status === 'removed').length,
    moved: rows.filter((row) => row.status === 'moved').length,
  };
}

function outcomeFor(rows: ComparisonRowV2[], certainty: 'complete' | 'incomplete'): ComparisonResultV2['outcome'] {
  if (rows.some((row) => row.status === 'changed' || row.status === 'added' || row.status === 'removed' || row.status === 'moved')) return 'changed';
  return certainty === 'complete' ? 'identical' : 'uncertain';
}

function reportProgress(callback: ((progress: CompareProgress) => void) | undefined, progress: CompareProgress): void {
  try { callback?.(progress); } catch { /* Consumer progress callbacks cannot break a comparison. */ }
}

function checkTime(startedAt: number): void {
  if (performance.now() - startedAt > COMPARISON_LIMITS.maxWallTimeMs) {
    throw new CompareError('TIME_LIMIT_EXCEEDED', 'The comparison exceeded its time limit.');
  }
}

async function sha256(bytes: Uint8Array): Promise<string> {
  try {
    const digest = await crypto.subtle.digest('SHA-256', Uint8Array.from(bytes).buffer);
    return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
  } catch {
    throw new CompareError('WORKER_FAILED', 'The selected document could not be fingerprinted safely.');
  }
}

function findBytes(haystack: Uint8Array, needle: number[]): number {
  outer: for (let index = 0; index <= haystack.length - needle.length; index += 1) {
    for (let part = 0; part < needle.length; part += 1) if (haystack[index + part] !== needle[part]) continue outer;
    return index;
  }
  return -1;
}
