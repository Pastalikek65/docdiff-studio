import { AnnotationMode, getDocument, GlobalWorkerOptions } from 'pdfjs-dist';
import type { PDFDocumentLoadingTask, PDFDocumentProxy, PDFPageProxy } from 'pdfjs-dist';
import pdfWorkerUrl from 'pdfjs-dist/build/pdf.worker.mjs?url';
import { alignPages, type PageFeatures } from './alignment';
import { COMPARISON_LIMITS } from './limits';
import { preflightReportOutputs } from './report';
import { omitSelectedLines, singleTextChange, textChanges } from './text-diff';
import { CompareError, type CompareOptions, type CompareProgress, type ComparisonResult, type ComparisonRow, type DocumentInfo } from './types';
import { sanitizeDocumentName, validateDocuments, validateOptions, type ValidatedDocument } from './validation';

interface PageSnapshot extends PageFeatures {
  page: PDFPageProxy;
}

interface OpenPdf {
  loadingTask: PDFDocumentLoadingTask;
  pdf: PDFDocumentProxy;
  source: ValidatedDocument;
  sha256: string;
  pages: PageSnapshot[];
}

interface RenderBudget {
  inputPixels: number;
  imageCharacters: number;
}

interface WorkerCanvasAndContext {
  canvas: OffscreenCanvas | null;
  context: OffscreenCanvasRenderingContext2D | null;
}

/** PDF.js defaults to DOMCanvasFactory, which requires document even when the
 * caller renders to an OffscreenCanvas. Image conversion uses this factory
 * internally, so provide a worker-safe implementation for image-only PDFs. */
class WorkerCanvasFactory {
  constructor(_options?: { enableHWA?: boolean; ownerDocument?: unknown }) {
    // PDF.js constructs its canvas factory with these options. OffscreenCanvas
    // is the only canvas implementation available in our dedicated worker.
  }

  create(width: number, height: number): WorkerCanvasAndContext {
    if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) {
      throw new Error('Invalid PDF.js canvas size');
    }
    const canvas = new OffscreenCanvas(width, height);
    const context = canvas.getContext('2d', { willReadFrequently: true });
    if (!context) throw new Error('PDF.js could not create a 2D canvas context');
    return { canvas, context };
  }

  reset(canvasAndContext: WorkerCanvasAndContext, width: number, height: number): void {
    if (!canvasAndContext.canvas) throw new Error('PDF.js canvas is not specified');
    if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) {
      throw new Error('Invalid PDF.js canvas size');
    }
    canvasAndContext.canvas.width = width;
    canvasAndContext.canvas.height = height;
  }

  destroy(canvasAndContext: WorkerCanvasAndContext): void {
    if (!canvasAndContext.canvas) throw new Error('PDF.js canvas is not specified');
    canvasAndContext.canvas.width = 0;
    canvasAndContext.canvas.height = 0;
    canvasAndContext.canvas = null;
    canvasAndContext.context = null;
  }
}

export async function comparePdfDocuments(
  before: import('./types').DocumentInput,
  after: import('./types').DocumentInput,
  rawOptions: Partial<CompareOptions> = {},
  onProgress?: (progress: CompareProgress) => void,
  onRenderPixelUsage?: (pixels: number) => void,
): Promise<ComparisonResult> {
  const startedAt = performance.now();
  const options = validateOptions(rawOptions);
  const [leftSource, rightSource] = validateDocuments(before, after);
  ensureBrowserWorkerCapabilities();
  const leftHash = await sha256(leftSource.bytes);
  checkTime(startedAt);
  const rightHash = await sha256(rightSource.bytes);
  checkTime(startedAt);

  const workerBase = globalThis.location?.origin && globalThis.location.origin !== 'null'
    ? `${globalThis.location.origin}/`
    : globalThis.location?.href;
  if (!workerBase) throw new CompareError('WORKER_UNAVAILABLE', 'The PDF.js worker asset cannot be resolved in this browser context.');
  GlobalWorkerOptions.workerSrc = new URL(pdfWorkerUrl, workerBase).href;
  const vendorRoot = new URL('/vendor/pdfjs/', workerBase).href;
  const budget: RenderBudget = { inputPixels: 0, imageCharacters: 0 };
  const opened: OpenPdf[] = [];
  try {
    const left = await openPdf(leftSource, leftHash, vendorRoot);
    opened.push(left);
    checkTime(startedAt);
    checkPageCount(left.pdf.numPages);
    const right = await openPdf(rightSource, rightHash, vendorRoot);
    opened.push(right);
    checkTime(startedAt);
    checkPageCount(right.pdf.numPages);
    const pageCount = left.pdf.numPages + right.pdf.numPages;
    let completed = 0;
    let totalTextCharacters = 0;

    for (const document of [left, right]) {
      for (let pageIndex = 0; pageIndex < document.pdf.numPages; pageIndex += 1) {
        checkTime(startedAt);
        const page = await document.pdf.getPage(pageIndex + 1);
        checkTime(startedAt);
        const collected = await readPageText(page, totalTextCharacters, startedAt);
        checkTime(startedAt);
        totalTextCharacters += collected.characters;
        const sample = await renderAlignmentSample(page, budget, startedAt);
        checkTime(startedAt);
        document.pages.push({ page, text: collected.text, visualSample: sample });
        page.cleanup();
        completed += 1;
        reportProgress(onProgress, { phase: 'Reading PDF pages', completed, total: pageCount });
      }
    }

    const alignments = alignPages(
      left.pages.map((page) => ({ ...page, text: omitSelectedLines(page.text, options.ignoreHeaderLines, options.ignoreFooterLines) })),
      right.pages.map((page) => ({ ...page, text: omitSelectedLines(page.text, options.ignoreHeaderLines, options.ignoreFooterLines) })),
    );
    checkTime(startedAt);
    reportProgress(onProgress, { phase: 'Aligning pages', completed: 1, total: 1 });
    const rows: ComparisonRow[] = [];
    for (let index = 0; index < alignments.length; index += 1) {
      checkTime(startedAt);
      const alignment = alignments[index];
      if (alignment.before === null) {
        const page = right.pages[alignment.after];
        const rendered = await renderPage(page.page, undefined, budget, startedAt);
        checkTime(startedAt);
        const dataUrl = await canvasToDataUrl(rendered.canvas, budget);
        checkTime(startedAt);
        page.page.cleanup();
        rows.push({
          id: `page-${index + 1}`,
          status: 'added',
          beforePage: null,
          afterPage: alignment.after,
          beforeText: '',
          afterText: page.text,
          changes: singleTextChange(page.text, 'added'),
          afterImageDataUrl: dataUrl,
        });
      } else if (alignment.after === null) {
        const page = left.pages[alignment.before];
        const rendered = await renderPage(page.page, undefined, budget, startedAt);
        checkTime(startedAt);
        const dataUrl = await canvasToDataUrl(rendered.canvas, budget);
        checkTime(startedAt);
        page.page.cleanup();
        rows.push({
          id: `page-${index + 1}`,
          status: 'removed',
          beforePage: alignment.before,
          afterPage: null,
          beforeText: page.text,
          afterText: '',
          changes: singleTextChange(page.text, 'removed'),
          beforeImageDataUrl: dataUrl,
        });
      } else {
        const beforePage = left.pages[alignment.before];
        const afterPage = right.pages[alignment.after];
        const commonScale = getPairScale(beforePage.page, afterPage.page);
        const beforeRender = await renderPage(beforePage.page, commonScale, budget, startedAt);
        checkTime(startedAt);
        const afterRender = await renderPage(afterPage.page, commonScale, budget, startedAt);
        checkTime(startedAt);
        const visualRender = makeVisualDiff(beforeRender, afterRender, options.visualThreshold, budget);
        checkTime(startedAt);
        const beforeImageDataUrl = await canvasToDataUrl(beforeRender.canvas, budget);
        checkTime(startedAt);
        const afterImageDataUrl = await canvasToDataUrl(afterRender.canvas, budget);
        checkTime(startedAt);
        const diffImageDataUrl = await canvasToDataUrl(visualRender.canvas, budget);
        checkTime(startedAt);
        beforePage.page.cleanup();
        afterPage.page.cleanup();
        const changes = textChanges(beforePage.text, afterPage.text, options);
        const hasTextDifference = changes.some((change) => change.kind !== 'equal');
        const hasVisualDifference = visualRender.changedPixels > 0;
        rows.push({
          id: `page-${index + 1}`,
          status: hasTextDifference || hasVisualDifference ? 'changed' : 'unchanged',
          beforePage: alignment.before,
          afterPage: alignment.after,
          beforeText: beforePage.text,
          afterText: afterPage.text,
          changes,
          beforeImageDataUrl,
          afterImageDataUrl,
          visual: {
            diffImageDataUrl,
            changedPixels: visualRender.changedPixels,
            totalPixels: visualRender.totalPixels,
            ratio: visualRender.totalPixels ? visualRender.changedPixels / visualRender.totalPixels : 0,
          },
        });
      }
      reportProgress(onProgress, { phase: 'Comparing aligned pages', completed: index + 1, total: alignments.length });
    }

    const summary = {
      unchanged: rows.filter((row) => row.status === 'unchanged').length,
      changed: rows.filter((row) => row.status === 'changed').length,
      added: rows.filter((row) => row.status === 'added').length,
      removed: rows.filter((row) => row.status === 'removed').length,
    };
    const warnings: string[] = [];
    const leftEmptyCount = left.pages.filter((page) => page.text.trim().length === 0).length;
    const rightEmptyCount = right.pages.filter((page) => page.text.trim().length === 0).length;
    if (leftEmptyCount > 0) warnings.push(emptyTextWarning(left.source.name, leftEmptyCount));
    if (rightEmptyCount > 0) warnings.push(emptyTextWarning(right.source.name, rightEmptyCount));
    if (options.ignoreWhitespace || options.ignoreHeaderLines > 0 || options.ignoreFooterLines > 0) {
      const ignored: string[] = [];
      if (options.ignoreWhitespace) ignored.push('whitespace');
      if (options.ignoreHeaderLines > 0) ignored.push(`${options.ignoreHeaderLines} header line(s)`);
      if (options.ignoreFooterLines > 0) ignored.push(`${options.ignoreFooterLines} footer line(s)`);
      warnings.push(`The selected ${ignored.join(', ')} option(s) affect text differences only. Page images are still compared.`);
    }

    const hasChanges = summary.changed + summary.added + summary.removed > 0;
    const outcome = hasChanges ? 'changed' : leftEmptyCount + rightEmptyCount > 0 ? 'uncertain' : 'identical';
    const result: ComparisonResult = {
      schemaVersion: 1,
      documents: {
        before: toDocumentInfo(left),
        after: toDocumentInfo(right),
      },
      options,
      rows,
      summary,
      warnings,
      outcome,
    };
    // Fail at the engine boundary if a future algorithm change grows report data
    // beyond the limits advertised by the UI and save bridge.
    preflightReportOutputs(result, () => {
      checkTime(startedAt);
      reportProgress(onProgress, { phase: 'Comparison complete', completed: 1, total: 1 });
    });
    try { onRenderPixelUsage?.(budget.inputPixels); } catch { /* Internal telemetry cannot break a comparison. */ }
    return result;
  } finally {
    await Promise.allSettled(opened.map(({ loadingTask }) => loadingTask.destroy()));
  }
}

function ensureBrowserWorkerCapabilities(): void {
  if (typeof OffscreenCanvas === 'undefined' || typeof Worker === 'undefined') {
    throw new CompareError('WORKER_UNAVAILABLE', 'PDF comparison requires a browser worker with OffscreenCanvas support.');
  }
  if (!globalThis.crypto?.subtle) {
    throw new CompareError('WORKER_UNAVAILABLE', 'Secure local hashing is unavailable in this browser context.');
  }
}

async function openPdf(source: ValidatedDocument, digest: string, vendorRoot: string): Promise<OpenPdf> {
  let loadingTask: PDFDocumentLoadingTask | undefined;
  try {
    const assetUrl = (folder: 'cmaps' | 'iccs' | 'standard_fonts' | 'wasm'): string => new URL(`${folder}/`, vendorRoot).href;
    loadingTask = getDocument({
      data: new Uint8Array(source.bytes),
      cMapUrl: assetUrl('cmaps'),
      cMapPacked: true,
      iccUrl: assetUrl('iccs'),
      standardFontDataUrl: assetUrl('standard_fonts'),
      wasmUrl: assetUrl('wasm'),
      CanvasFactory: WorkerCanvasFactory,
      useWorkerFetch: true,
      useWasm: true,
      maxImageSize: COMPARISON_LIMITS.maxImagePixels,
      canvasMaxAreaInBytes: 32 * 1024 * 1024,
      isOffscreenCanvasSupported: true,
      isImageDecoderSupported: true,
      disableRange: true,
      disableStream: true,
      disableAutoFetch: true,
      stopAtErrors: true,
      enableXfa: false,
      verbosity: 0,
    });
    const pdf = await loadingTask.promise;
    return {
      loadingTask,
      pdf,
      source,
      sha256: digest,
      pages: [],
    };
  } catch (error) {
    // If PDF.js created a loading task but rejected its promise (for example,
    // malformed or encrypted input), it is not yet tracked by the caller's
    // `opened` list. Destroy that worker/task here to release its resources.
    if (loadingTask) await Promise.allSettled([loadingTask.destroy()]);
    throw mapPdfError(error);
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

function checkPageCount(pageCount: number): void {
  if (!Number.isInteger(pageCount) || pageCount < 1) {
    throw new CompareError('PDF_DECODE_FAILED', 'The PDF has no readable pages.');
  }
  if (pageCount > COMPARISON_LIMITS.maxPagesPerDocument) {
    throw new CompareError('TOO_MANY_PAGES', `Each PDF may contain at most ${COMPARISON_LIMITS.maxPagesPerDocument} pages.`);
  }
}

async function readPageText(
  page: PDFPageProxy,
  currentTotal: number,
  startedAt: number,
): Promise<{ text: string; characters: number }> {
  const reader = page.streamTextContent({ includeMarkedContent: false }).getReader() as ReadableStreamDefaultReader<{
    items: Array<{ str?: unknown; hasEOL?: unknown; transform?: unknown; width?: unknown }>;
  }>;
  const parts: string[] = [];
  let characters = 0;
  let previous: { str: string; transform?: unknown; width?: unknown; hasEOL?: boolean } | undefined;
  try {
    while (true) {
      checkTime(startedAt);
      const { value, done } = await reader.read();
      if (done) break;
      for (const item of value.items) {
        if (typeof item.str !== 'string' || item.str.length === 0) continue;
        const str = sanitizeExtractedText(item.str);
        const separator = previous
          ? inferTextSeparator(previous, { str, transform: item.transform, width: item.width })
          : '';
        const addition = separator + str;
        characters += addition.length;
        if (characters > COMPARISON_LIMITS.maxPageTextCharacters || currentTotal + characters > COMPARISON_LIMITS.maxTextCharactersTotal) {
          throw new CompareError('TEXT_LIMIT_EXCEEDED', 'The extracted PDF text exceeds the supported comparison limit.');
        }
        parts.push(addition);
        previous = { str, transform: item.transform, width: item.width, hasEOL: item.hasEOL === true };
      }
    }
  } catch (error) {
    try { await reader.cancel(); } catch { /* stream may already be closed */ }
    if (error instanceof CompareError) throw error;
    throw mapPdfError(error);
  } finally {
    try { reader.releaseLock(); } catch { /* reader was cancelled */ }
  }
  return { text: parts.join(''), characters };
}

function sanitizeExtractedText(value: string): string {
  return value.replace(/\r\n?/gu, '\n').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/gu, '\ufffd');
}

function inferTextSeparator(
  previous: { str: string; transform?: unknown; width?: unknown; hasEOL?: boolean },
  current: { str: string; transform?: unknown; width?: unknown },
): '' | '\n' | ' ' {
  if (previous.hasEOL) return '\n';
  if (/\s$/u.test(previous.str) || /^\s/u.test(current.str)) return '';
  const previousTransform = Array.isArray(previous.transform) ? previous.transform : null;
  const currentTransform = Array.isArray(current.transform) ? current.transform : null;
  const previousX = previousTransform?.[4];
  const currentX = currentTransform?.[4];
  const previousY = previousTransform?.[5];
  const currentY = currentTransform?.[5];
  const width = previous.width;
  const fontSize = Math.max(1, Math.abs(Number(currentTransform?.[0]) || 1));
  if ([previousX, currentX, previousY, currentY, width].every(Number.isFinite)) {
    const lineDifference = Math.abs(Number(previousY) - Number(currentY));
    if (lineDifference > fontSize * 0.6) return '\n';
    const gap = Number(currentX) - (Number(previousX) + Number(width));
    return gap > fontSize * 0.2 ? ' ' : '';
  }
  return '';
}

async function renderAlignmentSample(page: PDFPageProxy, budget: RenderBudget, startedAt: number): Promise<number[]> {
  checkTime(startedAt);
  const sampleSize = 64;
  budget.inputPixels += sampleSize * sampleSize;
  if (budget.inputPixels > COMPARISON_LIMITS.maxRenderedPixels) {
    throw new CompareError('PIXEL_LIMIT_EXCEEDED', 'The documents exceed the supported rendered-pixel budget.');
  }
  const canvas = new OffscreenCanvas(sampleSize, sampleSize);
  const context = canvas.getContext('2d', { willReadFrequently: true });
  if (!context) throw new CompareError('WORKER_UNAVAILABLE', 'A 2D canvas is unavailable in the comparison worker.');
  context.fillStyle = '#ffffff';
  context.fillRect(0, 0, sampleSize, sampleSize);
  const base = page.getViewport({ scale: 1 });
  if (!Number.isFinite(base.width) || !Number.isFinite(base.height) || base.width <= 0 || base.height <= 0) {
    throw new CompareError('PIXEL_LIMIT_EXCEEDED', 'A PDF page has invalid or unsupported dimensions.');
  }
  const scale = Math.min(sampleSize / base.width, sampleSize / base.height);
  const viewport = page.getViewport({ scale });
  const offsetX = (sampleSize - viewport.width) / 2;
  const offsetY = (sampleSize - viewport.height) / 2;
  try {
    await page.render({
      canvas: null,
      canvasContext: context as unknown as CanvasRenderingContext2D,
      viewport,
      transform: [1, 0, 0, 1, offsetX, offsetY],
      background: '#ffffff',
      annotationMode: AnnotationMode.ENABLE,
    }).promise;
    checkTime(startedAt);
  } catch (error) {
    throw mapPdfError(error);
  }
  const data = context.getImageData(0, 0, sampleSize, sampleSize).data;
  const signature: number[] = [];
  const cells = 16;
  for (let gridY = 0; gridY < cells; gridY += 1) {
    for (let gridX = 0; gridX < cells; gridX += 1) {
      let total = 0;
      let count = 0;
      for (let y = gridY * 4; y < gridY * 4 + 4; y += 1) {
        for (let x = gridX * 4; x < gridX * 4 + 4; x += 1) {
          const offset = (y * sampleSize + x) * 4;
          total += 0.2126 * data[offset] + 0.7152 * data[offset + 1] + 0.0722 * data[offset + 2];
          count += 1;
        }
      }
      signature.push(Math.round(total / count));
    }
  }
  canvas.width = 1;
  canvas.height = 1;
  return signature;
}

function getPairScale(before: PDFPageProxy, after: PDFPageProxy): number {
  const left = before.getViewport({ scale: 1 });
  const right = after.getViewport({ scale: 1 });
  return fitScale(Math.max(left.width, right.width), Math.max(left.height, right.height));
}

function fitScale(width: number, height: number): number {
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    throw new CompareError('PIXEL_LIMIT_EXCEEDED', 'A PDF page has invalid or unsupported dimensions.');
  }
  return Math.min(
    COMPARISON_LIMITS.maxRenderScale,
    COMPARISON_LIMITS.maxRenderWidth / width,
    COMPARISON_LIMITS.maxRenderHeight / height,
  );
}

async function renderPage(
  page: PDFPageProxy,
  specifiedScale: number | undefined,
  budget: RenderBudget,
  startedAt: number,
): Promise<{ canvas: OffscreenCanvas; width: number; height: number }> {
  checkTime(startedAt);
  const base = page.getViewport({ scale: 1 });
  const scale = specifiedScale ?? fitScale(base.width, base.height);
  const viewport = page.getViewport({ scale });
  const width = Math.max(1, Math.ceil(viewport.width));
  const height = Math.max(1, Math.ceil(viewport.height));
  const pixels = width * height;
  if (!Number.isSafeInteger(pixels) || pixels > COMPARISON_LIMITS.maxPixelsPerRenderedPage
    || width > COMPARISON_LIMITS.maxRenderWidth || height > COMPARISON_LIMITS.maxRenderHeight) {
    throw new CompareError('PIXEL_LIMIT_EXCEEDED', 'A page exceeds the supported rendered size.');
  }
  budget.inputPixels += pixels;
  if (budget.inputPixels > COMPARISON_LIMITS.maxRenderedPixels) {
    throw new CompareError('PIXEL_LIMIT_EXCEEDED', 'The documents exceed the supported rendered-pixel budget.');
  }
  const canvas = new OffscreenCanvas(width, height);
  const context = canvas.getContext('2d', { willReadFrequently: true });
  if (!context) throw new CompareError('WORKER_UNAVAILABLE', 'A 2D canvas is unavailable in the comparison worker.');
  context.fillStyle = '#ffffff';
  context.fillRect(0, 0, width, height);
  try {
    await page.render({
      canvas: null,
      canvasContext: context as unknown as CanvasRenderingContext2D,
      viewport,
      background: '#ffffff',
      annotationMode: AnnotationMode.ENABLE,
    }).promise;
    checkTime(startedAt);
  } catch (error) {
    throw mapPdfError(error);
  }
  return { canvas, width, height };
}

function makeVisualDiff(
  before: { canvas: OffscreenCanvas; width: number; height: number },
  after: { canvas: OffscreenCanvas; width: number; height: number },
  threshold: number,
  budget: RenderBudget,
): { canvas: OffscreenCanvas; changedPixels: number; totalPixels: number } {
  const width = Math.max(before.width, after.width);
  const height = Math.max(before.height, after.height);
  const totalPixels = width * height;
  budget.inputPixels += totalPixels;
  if (!Number.isSafeInteger(totalPixels) || totalPixels > COMPARISON_LIMITS.maxPixelsPerRenderedPage
    || budget.inputPixels > COMPARISON_LIMITS.maxRenderedPixels) {
    throw new CompareError('PIXEL_LIMIT_EXCEEDED', 'The visual overlay exceeds the supported rendered-pixel budget.');
  }

  const leftContext = before.canvas.getContext('2d', { willReadFrequently: true });
  const rightContext = after.canvas.getContext('2d', { willReadFrequently: true });
  if (!leftContext || !rightContext) throw new CompareError('WORKER_UNAVAILABLE', 'A page image is unavailable for pixel comparison.');
  const left = leftContext.getImageData(0, 0, before.width, before.height).data;
  const right = rightContext.getImageData(0, 0, after.width, after.height).data;
  const overlay = new OffscreenCanvas(width, height);
  const overlayContext = overlay.getContext('2d', { willReadFrequently: true });
  if (!overlayContext) throw new CompareError('WORKER_UNAVAILABLE', 'A visual overlay canvas is unavailable.');
  const overlayData = overlayContext.createImageData(width, height);
  let changedPixels = 0;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const index = (y * width + x) * 4;
      const leftInside = x < before.width && y < before.height;
      const rightInside = x < after.width && y < after.height;
      const leftOffset = leftInside ? (y * before.width + x) * 4 : -1;
      const rightOffset = rightInside ? (y * after.width + x) * 4 : -1;
      const maxDifference = Math.max(
        Math.abs((leftInside ? left[leftOffset] : 255) - (rightInside ? right[rightOffset] : 255)),
        Math.abs((leftInside ? left[leftOffset + 1] : 255) - (rightInside ? right[rightOffset + 1] : 255)),
        Math.abs((leftInside ? left[leftOffset + 2] : 255) - (rightInside ? right[rightOffset + 2] : 255)),
        Math.abs((leftInside ? left[leftOffset + 3] : 255) - (rightInside ? right[rightOffset + 3] : 255)),
      );
      if (maxDifference > threshold) {
        changedPixels += 1;
        overlayData.data[index] = 220;
        overlayData.data[index + 1] = 40;
        overlayData.data[index + 2] = 72;
        overlayData.data[index + 3] = Math.min(235, 90 + Math.round(maxDifference * 145 / 255));
      }
    }
  }
  overlayContext.putImageData(overlayData, 0, 0);
  return { canvas: overlay, changedPixels, totalPixels };
}

async function canvasToDataUrl(canvas: OffscreenCanvas, budget: RenderBudget): Promise<string> {
  try {
    const blob = await canvas.convertToBlob({ type: 'image/png' });
    const prefix = 'data:image/png;base64,';
    const estimated = prefix.length + Math.ceil(blob.size / 3) * 4;
    if (estimated > COMPARISON_LIMITS.maxImageOutputCharacters - budget.imageCharacters) {
      throw new CompareError('OUTPUT_LIMIT_EXCEEDED', 'Embedded page images exceed the supported report size.');
    }
    const bytes = new Uint8Array(await blob.arrayBuffer());
    const base64 = encodeBase64(bytes);
    const value = prefix + base64;
    budget.imageCharacters += value.length;
    canvas.width = 1;
    canvas.height = 1;
    return value;
  } catch (error) {
    canvas.width = 1;
    canvas.height = 1;
    if (error instanceof CompareError) throw error;
    throw new CompareError('WORKER_FAILED', 'A page image could not be prepared for the comparison report.');
  }
}

function encodeBase64(bytes: Uint8Array): string {
  let binary = '';
  const chunkSize = 0x8000;
  for (let index = 0; index < bytes.length; index += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(index, Math.min(index + chunkSize, bytes.length)));
  }
  return btoa(binary);
}

function toDocumentInfo(document: OpenPdf): DocumentInfo {
  return {
    name: sanitizeDocumentName(document.source.name),
    format: 'pdf',
    sha256: document.sha256,
    pageCount: document.pdf.numPages,
  };
}

function emptyTextWarning(name: string, count: number): string {
  return `Text could not be extracted from ${count} page(s) in "${name}". The comparison still shows page images, but no OCR is performed in this MVP.`;
}

function reportProgress(callback: ((progress: CompareProgress) => void) | undefined, progress: CompareProgress): void {
  if (typeof callback !== 'function') return;
  try { callback(progress); } catch { /* consumer callbacks must not break the comparison */ }
}

function checkTime(startedAt: number): void {
  if (performance.now() - startedAt > COMPARISON_LIMITS.maxWallTimeMs) {
    throw new CompareError('TIME_LIMIT_EXCEEDED', 'The comparison exceeded its time limit.');
  }
}

function mapPdfError(error: unknown): CompareError {
  if (error instanceof CompareError) return error;
  const message = error instanceof Error ? error.message : '';
  if (/image exceeded maximum allowed size/iu.test(message)) {
    return new CompareError('PIXEL_LIMIT_EXCEEDED', 'A PDF contains an embedded image above the supported pixel limit.');
  }
  return new CompareError('PDF_DECODE_FAILED', 'This PDF could not be read. It may be damaged, encrypted, or use an unsupported feature.');
}
