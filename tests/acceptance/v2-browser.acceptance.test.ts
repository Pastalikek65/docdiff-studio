import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { createServer as createNetServer } from 'node:net';
import { resolve } from 'node:path';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
import { strToU8, zipSync } from 'fflate';
import type { ComparisonResultV2, SourceFormatV2 } from '../../src/core/types.js';

type FixtureRequest = {
  format: SourceFormatV2;
  beforeFormat?: SourceFormatV2;
  afterFormat?: SourceFormatV2;
  beforeFile: string;
  afterFile: string;
  beforeBytesBase64?: string;
  afterBytesBase64?: string;
  beforeName?: string;
  afterName?: string;
  options?: Record<string, unknown>;
};

type BrowserResult = {
  state: 'complete' | 'error' | 'terminated';
  error?: { code: string; message: string };
  progress: Array<{ phase: string; completed: number; total: number }>;
  ocrProgress: Array<{ phase: string; progress: number }>;
  workerTerminationCounts: number[];
  result?: ComparisonResultV2;
  beforeSourceSha256?: string;
  afterSourceSha256?: string;
  report?: {
    html: string;
    json: string;
    activeElementCount: number;
    eventHandlerAttributeCount: number;
    rawNameAppearsInHtml: boolean;
    inputBase64AppearsInReport: boolean;
    htmlTextContainsName: boolean;
  };
};

type AcceptanceApi = {
  start: (request: FixtureRequest) => Promise<string>;
  compare: (request: FixtureRequest) => Promise<BrowserResult>;
  wait: (id: string) => Promise<BrowserResult> | undefined;
  state: (id: string) => { state: string; progress: BrowserResult['progress']; ocrProgress: BrowserResult['ocrProgress']; trackedWorkers: number } | undefined;
  cancel: (id: string) => { state: 'terminated'; childWorkerTerminateCalls: number } | undefined;
};

type WindowWithAcceptance = Window & { docdiffV2Acceptance: AcceptanceApi };

type Manifest = {
  files: Array<{ name: string; bytes: number; sha256: string }>;
  cases: Array<{ id: string; before: string; after: string; expectation: Record<string, unknown>; options?: Record<string, unknown> }>;
};

let vite: ChildProcessWithoutNullStreams | undefined;
let browser: Browser | undefined;
let browserContext: BrowserContext | undefined;
let page: Page;
let origin: string;
let output = '';
const browserDiagnostics: string[] = [];
const externalRequests: string[] = [];
const blockedLocalAssetRequests: string[] = [];
let blockedLocalAssetPath: string | undefined;

async function freePort(): Promise<number> {
  const server = createNetServer();
  await new Promise<void>((resolveListen, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolveListen);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Could not reserve a local Vite port');
  const port = address.port;
  await new Promise<void>((resolveClose, reject) => server.close((error) => error ? reject(error) : resolveClose()));
  return port;
}

async function startVite(): Promise<void> {
  const port = await freePort();
  vite = spawn(process.execPath, [
    resolve(process.cwd(), 'node_modules/vite/bin/vite.js'),
    '--host', '127.0.0.1', '--port', String(port), '--strictPort',
  ], { cwd: process.cwd(), stdio: 'pipe' });
  vite.stdout.on('data', (chunk: Buffer) => { output += chunk.toString(); });
  vite.stderr.on('data', (chunk: Buffer) => { output += chunk.toString(); });
  origin = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 25_000;
  while (Date.now() < deadline) {
    if (vite.exitCode !== null) throw new Error(`Vite exited before serving the v2 bridge.\n${output}`);
    try {
      const response = await fetch(`${origin}/tests/acceptance/v2-bridge.html`);
      if (response.ok) return;
      if (response.status >= 500) throw new Error(`Vite bridge returned ${response.status}: ${await response.text()}\n${output}`);
    } catch (error) {
      if (error instanceof Error && error.message.startsWith('Vite bridge returned')) throw error;
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 150));
  }
  throw new Error(`Timed out waiting for v2 Vite bridge.\n${output}`);
}

async function compare(request: FixtureRequest): Promise<BrowserResult> {
  return page.evaluate((fixture) => (window as WindowWithAcceptance).docdiffV2Acceptance.compare(fixture), request);
}

function expectComplete(result: BrowserResult): ComparisonResultV2 {
  expect(result.state, `${JSON.stringify(result.error)}\nprogress=${JSON.stringify(result.progress)}\nocr=${JSON.stringify(result.ocrProgress)}\n${browserDiagnostics.join('\n')}`).toBe('complete');
  expect(result.error).toBeUndefined();
  expect(result.result?.schemaVersion).toBe(2);
  expect(result.report).toBeDefined();
  return result.result!;
}

function caseRequest(item: Manifest['cases'][number], format: SourceFormatV2): FixtureRequest {
  return {
    format,
    beforeFile: item.before,
    afterFile: item.after,
    ...(item.options ? { options: item.options } : {}),
  };
}

function rowText(row: ComparisonResultV2['rows'][number]): string {
  return `${row.beforeText}\n${row.afterText}\n${row.beforeCells?.join('\t') ?? ''}\n${row.afterCells?.join('\t') ?? ''}`;
}

async function movedPageVisualPdfBytes(drawMovedPageRectangle: boolean): Promise<Uint8Array> {
  const pdf = await PDFDocument.create({ updateMetadata: false });
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const pages = drawMovedPageRectangle
    ? ['Cover stable', 'Middle stable', 'End stable', 'MOVE unique']
    : ['Cover stable', 'MOVE unique', 'Middle stable', 'End stable'];
  for (const label of pages) {
    const page = pdf.addPage([612, 792]);
    page.drawText(label, { x: 58, y: 710, size: 18, font, color: rgb(0.08, 0.08, 0.08) });
    if (drawMovedPageRectangle && label === 'MOVE unique') {
      page.drawRectangle({ x: 80, y: 560, width: 90, height: 35, color: rgb(1, 0, 0) });
    }
  }
  return pdf.save({ useObjectStreams: false });
}

function customPathHeaderDocxBytes(headerText: string): Uint8Array {
  const wordNamespace = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
  const relationshipNamespace = 'http://schemas.openxmlformats.org/package/2006/relationships';
  const relationships = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
  const contentTypes = `<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/custom/header.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.header+xml"/></Types>`;
  const rootRelationships = `<Relationships xmlns="${relationshipNamespace}"><Relationship Id="rId1" Type="${relationships}/officeDocument" Target="word/document.xml"/></Relationships>`;
  const document = `<w:document xmlns:w="${wordNamespace}" xmlns:r="${relationships}"><w:body><w:p><w:r><w:t>Same main body</w:t></w:r></w:p><w:sectPr><w:headerReference w:type="default" r:id="h1"/></w:sectPr></w:body></w:document>`;
  const documentRelationships = `<Relationships xmlns="${relationshipNamespace}"><Relationship Id="h1" Type="${relationships}/header" Target="/custom/header.xml"/></Relationships>`;
  const header = `<w:hdr xmlns:w="${wordNamespace}"><w:p><w:r><w:t>${headerText}</w:t></w:r></w:p></w:hdr>`;
  return zipSync({
    '[Content_Types].xml': strToU8(contentTypes),
    '_rels/.rels': strToU8(rootRelationships),
    'word/document.xml': strToU8(document),
    'word/_rels/document.xml.rels': strToU8(documentRelationships),
    'custom/header.xml': strToU8(header),
  });
}

describe('independent v1 DOCX and local OCR browser acceptance', () => {
  let manifest: Manifest;

  beforeAll(async () => {
    manifest = JSON.parse(await readFile(resolve(process.cwd(), 'examples/v1/manifest.json'), 'utf8')) as Manifest;
    await startVite();
    browser = await chromium.launch({ headless: true, chromiumSandbox: true });
    browserContext = await browser.newContext();
    page = await browserContext.newPage();
    page.on('console', (message) => browserDiagnostics.push(`console:${message.type()}:${message.text()}`));
    page.on('request', (request) => {
      if (!request.url().startsWith(origin)) externalRequests.push(request.url());
    });
    page.on('requestfailed', (request) => browserDiagnostics.push(`request:${request.url()}:${request.failure()?.errorText ?? 'failed'}`));
    page.on('pageerror', (error) => browserDiagnostics.push(`pageerror:${error.message}`));
    await browserContext.route('**/*', async (route) => {
      const url = new URL(route.request().url());
      if (url.origin === origin && url.pathname === blockedLocalAssetPath) {
        blockedLocalAssetRequests.push(url.pathname);
        await route.fulfill({ status: 404, contentType: 'text/plain', body: 'Test-only local OCR asset unavailable.' });
      } else if (url.origin === origin) await route.continue();
      else {
        externalRequests.push(route.request().url());
        await route.abort();
      }
    });
    await page.goto(`${origin}/tests/acceptance/v2-bridge.html`);
    await page.waitForFunction(() => typeof (window as WindowWithAcceptance).docdiffV2Acceptance?.compare === 'function');
  }, 30_000);

  afterAll(async () => {
    await browser?.close();
    if (vite && vite.exitCode === null) {
      vite.kill();
      await new Promise<void>((resolveExit) => vite!.once('exit', () => resolveExit()));
    }
  }, 10_000);

  it('keeps the separate v1 corpus reproducible and cryptographically matched to its manifest', () => {
    expect(manifest.cases).toHaveLength(32);
    expect(manifest.files).toHaveLength(53);
    for (const fixture of manifest.files) {
      const bytes = requireFixtureBytes(fixture.name);
      expect(bytes.length, fixture.name).toBe(fixture.bytes);
      expect(createHash('sha256').update(bytes).digest('hex'), fixture.name).toBe(fixture.sha256);
    }
  });

  it('compares real DOCX paragraphs and table cells, preserving source hashes and logical locations', async () => {
    const item = manifest.cases.find(({ id }) => id === 'docx-paragraph-and-cell-change')!;
    const result = await compare(caseRequest(item, 'docx'));
    const comparison = expectComplete(result);
    expect(comparison.outcome).toBe('changed');
    expect(comparison.documents.before).toMatchObject({ format: 'docx', unitKind: 'docx-block' });
    expect(comparison.documents.before.sha256).toBe(result.beforeSourceSha256);
    expect(comparison.documents.after.sha256).toBe(result.afterSourceSha256);
    expect(comparison.rows.some((row) => row.textEvidence.before.source === 'docx-xml' && row.textEvidence.after.source === 'docx-xml')).toBe(true);
    const paragraph = comparison.rows.find((row) => row.beforeText.includes('1250') || row.afterText.includes('1350'));
    expect(paragraph?.status).toBe('changed');
    expect(paragraph?.beforeLocation).toMatchObject({ format: 'docx', kind: 'paragraph' });
    expect(paragraph?.changes.some((change) => change.kind === 'removed' && change.text.includes('1250'))).toBe(true);
    expect(paragraph?.changes.some((change) => change.kind === 'added' && change.text.includes('1350'))).toBe(true);
    const changedCells = comparison.rows.find((row) => row.beforeCells?.includes('500') && row.afterCells?.includes('600'));
    expect(changedCells?.beforeLocation).toMatchObject({ format: 'docx', kind: 'table-row', tableIndex: 0, rowIndex: 1 });
    expect(changedCells?.cellChanges?.some((cell) => cell.beforeCellIndex === 2 && cell.afterCellIndex === 2 && cell.changes.some((change) => change.kind === 'removed' && change.text === '500') && cell.changes.some((change) => change.kind === 'added' && change.text === '600'))).toBe(true);
  }, 30_000);

  it('compares the deterministic 1,500-unit DOCX workload with one number and one cell change', async () => {
    const item = manifest.cases.find(({ id }) => id === 'docx-medium-benchmark')!;
    const result = await compare(caseRequest(item, 'docx'));
    const comparison = expectComplete(result);
    expect(comparison.outcome).toBe('changed');
    expect(comparison.documents.before.unitCount).toBe(1_500);
    expect(comparison.documents.after.unitCount).toBe(1_500);
    expect(comparison.summary).toMatchObject({ unchanged: 1_498, changed: 2, added: 0, removed: 0, moved: 0 });
    const changedParagraphs = comparison.rows.filter((row) => row.status === 'changed' && row.beforeLocation?.kind === 'paragraph');
    expect(changedParagraphs).toHaveLength(1);
    expect(changedParagraphs[0]).toMatchObject({
      beforeLocation: { format: 'docx', kind: 'paragraph', index: 499 },
      afterLocation: { format: 'docx', kind: 'paragraph', index: 499 },
    });
    expect(changedParagraphs[0].beforeText).toContain('1250');
    expect(changedParagraphs[0].afterText).toContain('1350');
    const changedRows = comparison.rows.filter((row) => row.status === 'changed' && row.beforeLocation?.kind === 'table-row');
    expect(changedRows).toHaveLength(1);
    expect(changedRows[0]).toMatchObject({
      beforeLocation: { format: 'docx', kind: 'table-row', tableIndex: 0, rowIndex: 250 },
      afterLocation: { format: 'docx', kind: 'table-row', tableIndex: 0, rowIndex: 250 },
    });
    expect(changedRows[0].beforeCells?.[2]).toBe('500');
    expect(changedRows[0].afterCells?.[2]).toBe('600');
    expect(result.report?.json.length).toBeGreaterThan(0);
  }, 90_000);

  it('keeps inserted and removed middle paragraphs from cascading later alignment', async () => {
    const insertedCase = manifest.cases.find(({ id }) => id === 'docx-insert-middle')!;
    const inserted = expectComplete(await compare(caseRequest(insertedCase, 'docx')));
    expect(inserted.rows.filter((row) => row.status === 'added').map(rowText)).toEqual(expect.arrayContaining([expect.stringContaining('Inserted middle paragraph.')]));
    const closing = inserted.rows.find((row) => row.beforeText.includes('Closing clause remains.') || row.afterText.includes('Closing clause remains.'));
    expect(closing).toMatchObject({ status: 'unchanged', beforeLocation: { index: 1 }, afterLocation: { index: 2 } });

    const removedCase = manifest.cases.find(({ id }) => id === 'docx-remove-middle')!;
    const removed = expectComplete(await compare(caseRequest(removedCase, 'docx')));
    expect(removed.rows.filter((row) => row.status === 'removed').map(rowText)).toEqual(expect.arrayContaining([expect.stringContaining('Removed middle paragraph.')]));
    const removedClosing = removed.rows.find((row) => row.beforeText.includes('Closing clause remains.') || row.afterText.includes('Closing clause remains.'));
    expect(removedClosing).toMatchObject({ status: 'unchanged', beforeLocation: { index: 2 }, afterLocation: { index: 1 } });
  }, 40_000);

  it('marks only unique whole-document move candidates and keeps duplicate boilerplate ambiguous', async () => {
    const moveCase = manifest.cases.find(({ id }) => id === 'docx-unique-move')!;
    const moved = expectComplete(await compare(caseRequest(moveCase, 'docx')));
    const moveRows = moved.rows.filter((row) => row.status === 'moved');
    expect(moveRows).toHaveLength(1);
    expect(moveRows[0]).toMatchObject({ beforeText: 'Unique moved clause: account 742.', afterText: 'Unique moved clause: account 742.' });
    expect(moveRows[0].moveId).toMatch(/^move-/u);
    expect(moved.summary.moved).toBe(1);
    const repeated = expectComplete(await compare(caseRequest(moveCase, 'docx')));
    expect(repeated.rows.find((row) => row.status === 'moved')?.moveId).toBe(moveRows[0].moveId);

    const duplicatesCase = manifest.cases.find(({ id }) => id === 'docx-duplicate-ambiguity')!;
    const duplicates = expectComplete(await compare(caseRequest(duplicatesCase, 'docx')));
    expect(duplicates.summary.moved, JSON.stringify(duplicates.rows.map((row) => ({ status: row.status, beforeLocation: row.beforeLocation, afterLocation: row.afterLocation, beforeText: row.beforeText, afterText: row.afterText, moveId: row.moveId })))).toBe(0);
    expect(duplicates.rows.some((row) => row.status === 'moved' && row.beforeText.includes('Standard boilerplate repeated.'))).toBe(false);
  }, 40_000);

  it('detects one exact moved PDF page while refusing to label reordered duplicate pages as moves', async () => {
    const uniqueCase = manifest.cases.find(({ id }) => id === 'pdf-unique-page-move')!;
    const unique = expectComplete(await compare(caseRequest(uniqueCase, 'pdf')));
    expect(unique.outcome).toBe('changed');
    const moved = unique.rows.filter((row) => row.status === 'moved');
    expect(moved).toHaveLength(1);
    expect(moved[0]).toMatchObject({
      beforeText: expect.stringContaining('UNIQUE PDF PAGE TO MOVE: REF-742'),
      afterText: expect.stringContaining('UNIQUE PDF PAGE TO MOVE: REF-742'),
      beforeLocation: { format: 'pdf', kind: 'page', index: 1 },
      afterLocation: { format: 'pdf', kind: 'page', index: 3 },
      textEvidence: { before: { source: 'pdf-text' }, after: { source: 'pdf-text' } },
    });
    expect(moved[0].moveId).toMatch(/^move-/u);
    expect(unique.summary.moved).toBe(1);
    const uniqueAgain = expectComplete(await compare(caseRequest(uniqueCase, 'pdf')));
    expect(uniqueAgain.rows.find((row) => row.status === 'moved')?.moveId).toBe(moved[0].moveId);

    const duplicatesCase = manifest.cases.find(({ id }) => id === 'pdf-duplicate-page-move-ambiguous')!;
    const duplicates = expectComplete(await compare(caseRequest(duplicatesCase, 'pdf')));
    expect(duplicates.summary.moved).toBe(1);
    const repeatedPages = duplicates.rows.filter((row) => row.beforeText.includes('Standard boilerplate repeated.') || row.afterText.includes('Standard boilerplate repeated.'));
    expect(repeatedPages).toHaveLength(2);
    expect(repeatedPages.map((row) => row.status)).toEqual(['unchanged', 'unchanged']);
    expect(repeatedPages.map((row) => [row.beforeLocation?.index, row.afterLocation?.index])).toEqual([[1, 1], [2, 3]]);
    const uniqueMovedAnchor = duplicates.rows.filter((row) => row.status === 'moved');
    expect(uniqueMovedAnchor).toHaveLength(1);
    expect(uniqueMovedAnchor[0]).toMatchObject({ beforeText: 'PDF DUPLICATE ENDING', afterText: 'PDF DUPLICATE ENDING', beforeLocation: { index: 3 }, afterLocation: { index: 2 } });
  }, 50_000);

  it('keeps the moved REF-742 page visual change visible in the checked-in corpus through the real worker', async () => {
    const item = manifest.cases.find(({ id }) => id === 'pdf-moved-page-visual-change')!;
    const result = await compare(caseRequest(item, 'pdf'));
    const comparison = expectComplete(result);
    expect(comparison.outcome).toBe('changed');
    expect(comparison.summary).toMatchObject({ moved: 1, changed: 0 });
    const moved = comparison.rows.filter((row) => row.status === 'moved');
    expect(moved).toHaveLength(1);
    expect(moved[0]).toMatchObject({
      beforeText: expect.stringContaining('UNIQUE PDF PAGE TO MOVE: REF-742'),
      afterText: expect.stringContaining('UNIQUE PDF PAGE TO MOVE: REF-742'),
      beforeLocation: { format: 'pdf', kind: 'page', index: 1 },
      afterLocation: { format: 'pdf', kind: 'page', index: 3 },
    });
    expect(moved[0].visual?.changedPixels).toBeGreaterThan(0);
    expect(moved[0].visual?.diffImageDataUrl).toMatch(/^data:image\/png;base64,/u);
    expect(result.report?.html).toContain('Visual difference');
  }, 45_000);

  it('preserves visual-difference facts when an exactly moved PDF page also changes appearance', async () => {
    const [beforeBytes, afterBytes] = await Promise.all([
      movedPageVisualPdfBytes(false),
      movedPageVisualPdfBytes(true),
    ]);
    const result = await compare({
      format: 'pdf',
      beforeFile: 'generated-move-visual-before.pdf',
      afterFile: 'generated-move-visual-after.pdf',
      beforeBytesBase64: Buffer.from(beforeBytes).toString('base64'),
      afterBytesBase64: Buffer.from(afterBytes).toString('base64'),
    });
    const comparison = expectComplete(result);
    expect(comparison.outcome).toBe('changed');
    expect(comparison.summary.moved).toBe(1);
    expect(comparison.summary.changed).toBe(0);
    const moved = comparison.rows.filter((row) => row.status === 'moved');
    expect(moved).toHaveLength(1);
    expect(moved[0]).toMatchObject({
      beforeText: 'MOVE unique',
      afterText: 'MOVE unique',
      beforeLocation: { format: 'pdf', kind: 'page', index: 1 },
      afterLocation: { format: 'pdf', kind: 'page', index: 3 },
    });
    expect(moved[0].visual?.changedPixels).toBeGreaterThan(0);
    expect(moved[0].visual?.totalPixels).toBeGreaterThan(0);
    expect(moved[0].visual?.diffImageDataUrl).toMatch(/^data:image\/png;base64,/u);
    expect(result.report?.html).toContain('Visual difference');
  }, 40_000);

  it('does not report identical when custom-path DOCX header content differs', async () => {
    const beforeBytes = customPathHeaderDocxBytes('Header BEFORE');
    const afterBytes = customPathHeaderDocxBytes('Header AFTER');
    const result = await compare({
      format: 'docx',
      beforeFile: 'custom-header-before.docx',
      afterFile: 'custom-header-after.docx',
      beforeBytesBase64: Buffer.from(beforeBytes).toString('base64'),
      afterBytesBase64: Buffer.from(afterBytes).toString('base64'),
    });
    const comparison = expectComplete(result);
    expect(comparison.outcome).not.toBe('identical');
    expect(comparison.certainty).toBe('incomplete');
    expect(comparison.warnings.some((warning) => /header text is not included/iu.test(warning))).toBe(true);
    expect(result.report?.json).not.toContain('Header BEFORE');
    expect(result.report?.json).not.toContain('Header AFTER');
  }, 30_000);

  it('treats run splitting and tabs as logical text while unsupported headers/revisions never become identical', async () => {
    const splitCase = manifest.cases.find(({ id }) => id === 'docx-split-runs-equal-text')!;
    const split = expectComplete(await compare(caseRequest(splitCase, 'docx')));
    expect(split.outcome).toBe('identical');
    expect(split.rows).toHaveLength(1);
    expect(split.rows[0].beforeText).toBe('One paragraph with split runs.');

    const tabsCase = manifest.cases.find(({ id }) => id === 'docx-tabs-preserved')!;
    const tabs = expectComplete(await compare(caseRequest(tabsCase, 'docx')));
    expect(tabs.outcome).toBe('identical');
    expect(tabs.rows[0].beforeText).toBe('ITEM\tCOUNT\tTOTAL');

    for (const id of ['docx-unsupported-header-not-identical', 'docx-tracked-revisions-not-identical']) {
      const item = manifest.cases.find((entry) => entry.id === id)!;
      const result = await compare(caseRequest(item, 'docx'));
      if (result.state === 'error') expect(result.error?.code).toBe('DOCX_UNSUPPORTED_FEATURE');
      else expect(result.result?.outcome, `${id}: ${JSON.stringify(result.result?.warnings)}`).not.toBe('identical');
    }
  }, 50_000);

  it('does not call unknown text-bearing OOXML or alternate namespace content identical when their pair differs', async () => {
    for (const id of ['docx-unknown-text-bearing-element-not-identical', 'docx-alternate-transitional-namespace-not-identical']) {
      const item = manifest.cases.find((entry) => entry.id === id)!;
      const result = await compare(caseRequest(item, 'docx'));
      if (result.state === 'error') {
        expect(['DOCX_UNSUPPORTED_FEATURE', 'DOCX_XML_INVALID']).toContain(result.error?.code);
      } else {
        expect(result.result?.outcome, `${id}: ${JSON.stringify(result.result?.warnings)}`).not.toBe('identical');
      }
    }
  }, 40_000);

  it('rejects hostile DOCX ZIP/XML inputs and mismatched source formats without producing reports', async () => {
    const hostile = manifest.cases.filter(({ id }) => id.startsWith('hostile-docx-'));
    expect(hostile).toHaveLength(11);
    for (const item of hostile) {
      const result = await compare(caseRequest(item, 'docx'));
      expect(result.state, `${item.id}: ${JSON.stringify(result.error)}`).toBe('error');
      expect(['DOCX_PACKAGE_INVALID', 'DOCX_XML_INVALID', 'DOCX_UNSUPPORTED_FEATURE', 'INPUT_TOO_LARGE']).toContain(result.error?.code);
      expect(result.result).toBeUndefined();
      expect(result.report).toBeUndefined();
    }
    const ordinary = manifest.cases.find(({ id }) => id === 'docx-split-runs-equal-text')!;
    const mismatch = await compare({ ...caseRequest(ordinary, 'docx'), afterFormat: 'pdf' });
    expect(mismatch.state).toBe('error');
    expect(mismatch.error?.code).toBe('FORMAT_MISMATCH');
  }, 90_000);

  it('rejects OCR page selections above the combined per-comparison bound', async () => {
    const item = manifest.cases.find(({ id }) => id === 'ocr-cancellation-workload')!;
    const result = await compare({
      ...caseRequest(item, 'pdf'),
      options: {
        ocr: {
          enabled: true,
          beforePageIndexes: Array.from({ length: 11 }, (_, index) => index),
          afterPageIndexes: Array.from({ length: 10 }, (_, index) => index),
          minimumConfidence: 0,
        },
      },
    });
    expect(result.state).toBe('error');
    expect(result.error?.code).toBe('OCR_PAGE_LIMIT_EXCEEDED');
    expect(result.result).toBeUndefined();
  }, 30_000);

  it('escapes hostile document names in HTML and serializes schema-2 public data without source archive bytes', async () => {
    const item = manifest.cases.find(({ id }) => id === 'docx-report-text-escaping')!;
    const attackName = 'C:\\private\\"><img src=x onerror=alert(1)><svg onload=alert(2)>.docx';
    const safeName = attackName.split(/[\\/]/u).at(-1)!;
    const result = await compare({ ...caseRequest(item, 'docx'), beforeName: attackName, afterName: attackName });
    const comparison = expectComplete(result);
    expect(comparison.documents.before.name).toBe(safeName);
    expect(result.report?.rawNameAppearsInHtml).toBe(false);
    expect(result.report?.htmlTextContainsName).toBe(false);
    expect(result.report?.activeElementCount).toBe(0);
    expect(result.report?.eventHandlerAttributeCount).toBe(0);
    expect(result.report?.inputBase64AppearsInReport).toBe(false);
    expect(result.report?.html).toContain('&lt;img src=x onerror=alert(1)&gt;');
    expect(result.report?.html).toContain('&lt;svg onload=alert(2)&gt;');
    expect(result.report?.html).toContain('&lt;script&gt;alert(1)&lt;/script&gt; &amp; &lt;img src=x onerror=alert(2)&gt;');
    const json = JSON.parse(result.report!.json) as ComparisonResultV2;
    expect(json.schemaVersion).toBe(2);
    expect(json.documents.before.name).toBe(safeName);
    expect(result.report?.html).not.toContain('C:\\private\\');
    expect(result.report?.json).not.toContain('C:\\private\\');
    expect(result.report?.json).not.toContain('PK\u0003\u0004');
    expect(externalRequests).toEqual([]);
  }, 30_000);

  it('performs actual offline English OCR on image-only PDFs and selected pages only', async () => {
    const identicalCase = manifest.cases.find(({ id }) => id === 'ocr-identical-scan-remains-uncertain')!;
    const identical = await compare(caseRequest(identicalCase, 'pdf'));
    const identicalResult = expectComplete(identical);
    expect(identicalResult.outcome).toBe('uncertain');
    expect(identicalResult.certainty).toBe('incomplete');
    expect(identicalResult.rows[0].textEvidence.before.source).toBe('ocr');
    expect(identicalResult.rows[0].textEvidence.after.source).toBe('ocr');
    expect(identicalResult.warnings.some((warning) => /OCR-derived text is heuristic/iu.test(warning))).toBe(true);
    expect(identicalResult.rows[0].textEvidence.before.confidence ?? -1).toBeGreaterThan(0);
    expect(identicalResult.rows[0].textEvidence.before.confidence ?? 101).toBeLessThanOrEqual(100);

    const wordCase = manifest.cases.find(({ id }) => id === 'ocr-word-difference')!;
    const word = expectComplete(await compare(caseRequest(wordCase, 'pdf')));
    expect(word.outcome).toBe('changed');
    expect(word.certainty).toBe('incomplete');
    expect(word.warnings.some((warning) => /OCR-derived text is heuristic/iu.test(warning))).toBe(true);
    expect(word.rows[0].beforeText).toContain('INVOICE REVIEW');
    expect(word.rows[0].afterText).toContain('INVOICE REVISED');
    expect(word.rows[0].textEvidence.before.source).toBe('ocr');

    const numberCase = manifest.cases.find(({ id }) => id === 'ocr-number-difference')!;
    const number = expectComplete(await compare(caseRequest(numberCase, 'pdf')));
    expect(number.outcome).toBe('changed');
    expect(number.certainty).toBe('incomplete');
    expect(number.warnings.some((warning) => /OCR-derived text is heuristic/iu.test(warning))).toBe(true);
    expect(number.rows[0].beforeText).toContain('1250');
    expect(number.rows[0].afterText).toContain('1350');

    const mixedCase = manifest.cases.find(({ id }) => id === 'ocr-mixed-selected-only')!;
    const mixed = expectComplete(await compare(caseRequest(mixedCase, 'pdf')));
    expect(mixed.rows).toHaveLength(2);
    expect(mixed.certainty).toBe('incomplete');
    expect(mixed.warnings.some((warning) => /OCR-derived text is heuristic/iu.test(warning))).toBe(true);
    expect(mixed.rows[0]).toMatchObject({ status: 'unchanged', textEvidence: { before: { source: 'pdf-text' }, after: { source: 'pdf-text' } } });
    expect(mixed.rows[1]).toMatchObject({ status: 'changed', textEvidence: { before: { source: 'ocr' }, after: { source: 'ocr' } } });
    expect(mixed.rows[1].beforeText).toContain('INVOICE REVIEW');
    expect(mixed.rows[1].afterText).toContain('INVOICE REVISED');
    expect(externalRequests).toEqual([]);
  }, 150_000);

  it('fails clearly and terminates both workers when the local English model is unavailable', async () => {
    const item = manifest.cases.find(({ id }) => id === 'ocr-word-difference')!;
    const request = caseRequest(item, 'pdf');
    blockedLocalAssetPath = '/vendor/ocr/lang/eng.traineddata';
    blockedLocalAssetRequests.length = 0;
    const id = await page.evaluate((fixture) => (window as WindowWithAcceptance).docdiffV2Acceptance.start(fixture), request);
    const response = page.evaluate((jobId) => (window as WindowWithAcceptance).docdiffV2Acceptance.wait(jobId), id);
    try {
      const routeDeadline = Date.now() + 15_000;
      while (blockedLocalAssetRequests.length === 0 && Date.now() < routeDeadline) {
        await new Promise((resolveDelay) => setTimeout(resolveDelay, 50));
      }
      expect(blockedLocalAssetRequests).toContain(blockedLocalAssetPath);
      let responseTimeout: ReturnType<typeof setTimeout> | undefined;
      const result = await Promise.race([
        response,
        new Promise<undefined>((resolveDelay) => { responseTimeout = setTimeout(() => resolveDelay(undefined), 12_000); }),
      ]);
      if (responseTimeout) clearTimeout(responseTimeout);
      const currentState = await page.evaluate((jobId) => (window as WindowWithAcceptance).docdiffV2Acceptance.state(jobId), id);
      expect(externalRequests, 'The unavailable local model must not trigger remote fallback.').toEqual([]);
      expect(result, `OCR failure did not resolve after ${blockedLocalAssetRequests.length} local 404 response(s); worker state=${JSON.stringify(currentState)}; browser=${browserDiagnostics.join('\n')}`).toBeDefined();
      if (!result) throw new Error(`OCR failure did not resolve; worker state=${JSON.stringify(currentState)}.`);
      expect(result.state).toBe('error');
      expect(result.error?.code).toBe('OCR_FAILED');
      expect(result.error?.message).toMatch(/local English OCR could not read a selected page/i);
      expect(result.result).toBeUndefined();
      expect(result.report).toBeUndefined();
      expect(result.workerTerminationCounts.length).toBeGreaterThanOrEqual(2);
      expect(result.workerTerminationCounts.every((count) => count > 0)).toBe(true);
      expect(externalRequests).toEqual([]);
    } finally {
      const state = await page.evaluate((jobId) => (window as WindowWithAcceptance).docdiffV2Acceptance.state(jobId), id);
      if (state?.state === 'running') {
        const cancelled = await page.evaluate((jobId) => (window as WindowWithAcceptance).docdiffV2Acceptance.cancel(jobId), id);
        expect(cancelled?.childWorkerTerminateCalls).toBeGreaterThan(0);
        const terminal = await response;
        expect(terminal?.state).toBe('terminated');
        expect(terminal?.workerTerminationCounts.length).toBeGreaterThanOrEqual(2);
        expect(terminal?.workerTerminationCounts.every((count) => count > 0)).toBe(true);
      }
      blockedLocalAssetPath = undefined;
    }
  }, 35_000);

  it('cancels during a real selected-page OCR workload and terminates the local Tesseract child worker', async () => {
    const item = manifest.cases.find(({ id }) => id === 'ocr-cancellation-workload')!;
    const id = await page.evaluate((request) => (window as WindowWithAcceptance).docdiffV2Acceptance.start(request), caseRequest(item, 'pdf'));
    await page.waitForFunction((jobId) => {
      const state = (window as WindowWithAcceptance).docdiffV2Acceptance.state(jobId);
      return Boolean(state && state.trackedWorkers >= 2 && state.ocrProgress.length > 0);
    }, id, { timeout: 60_000, polling: 100 });
    const beforeCancel = await page.evaluate((jobId) => (window as WindowWithAcceptance).docdiffV2Acceptance.state(jobId), id);
    expect(beforeCancel?.state).toBe('running');
    expect(beforeCancel?.ocrProgress.length).toBeGreaterThan(0);
    const cancelled = await page.evaluate((jobId) => (window as WindowWithAcceptance).docdiffV2Acceptance.cancel(jobId), id);
    expect(cancelled).toMatchObject({ state: 'terminated' });
    expect(cancelled?.childWorkerTerminateCalls).toBeGreaterThan(0);
    const final = await page.evaluate((jobId) => (window as WindowWithAcceptance).docdiffV2Acceptance.state(jobId), id);
    expect(final?.state).toBe('terminated');
  }, 90_000);
});

function requireFixtureBytes(filename: string): Buffer {
  const path = resolve(process.cwd(), 'examples/v1/corpus', filename);
  return readFileSync(path);
}
