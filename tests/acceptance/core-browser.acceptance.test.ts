import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { createServer as createNetServer } from 'node:net';
import { resolve } from 'node:path';
import { chromium, type Browser, type Page } from 'playwright';

type FixtureRequest = {
  beforeFile: string;
  afterFile: string;
  beforeName?: string;
  afterName?: string;
  padBeforeBytes?: number;
};

type BrowserResult = {
  state: 'complete' | 'error' | 'terminated';
  error?: { code: string; message: string };
  progress: Array<{ phase: string; completed: number; total: number }>;
  result?: {
    documents: { before: { name: string; sha256: string }; after: { name: string; sha256: string } };
    outcome: 'identical' | 'changed' | 'uncertain';
    summary: { unchanged: number; changed: number; added: number; removed: number };
    warnings: string[];
    rows: Array<{
      status: string;
      beforePage: number | null;
      afterPage: number | null;
      beforeText: string;
      afterText: string;
      changes: Array<{ kind: string; text: string }>;
      visual?: { changedPixels: number; totalPixels: number; ratio: number; hasDiffImage: boolean };
      hasBeforeImage: boolean;
      hasAfterImage: boolean;
    }>;
  };
  report?: {
    html: string;
    json: string;
    containsOriginalPdfBase64: boolean;
    rawNameAppearsInHtml: boolean;
    activeElementCount: number;
    eventHandlerAttributeCount: number;
  };
};

type AcceptanceApi = {
  start: (request: FixtureRequest) => Promise<string>;
  compare: (request: FixtureRequest) => Promise<BrowserResult>;
  state: (id: string) => { state: string; progress: Array<{ phase: string; completed: number; total: number }> } | undefined;
  terminate: (id: string) => BrowserResult | undefined;
};

type WindowWithAcceptance = Window & { docdiffAcceptance: AcceptanceApi };

let vite: ChildProcessWithoutNullStreams | undefined;
let browser: Browser | undefined;
let page: Page;
let origin: string;
let output = '';
const browserDiagnostics: string[] = [];

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
    '--host', '127.0.0.1',
    '--port', String(port),
    '--strictPort',
  ], { cwd: process.cwd(), stdio: 'pipe' });
  vite.stdout.on('data', (chunk: Buffer) => { output += chunk.toString(); });
  vite.stderr.on('data', (chunk: Buffer) => { output += chunk.toString(); });
  origin = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 25_000;
  while (Date.now() < deadline) {
    if (vite.exitCode !== null) throw new Error(`Vite exited before serving the bridge.\n${output}`);
    try {
      const response = await fetch(`${origin}/tests/acceptance/bridge.html`);
      if (response.ok) return;
      if (response.status >= 500) throw new Error(`Vite bridge returned ${response.status}: ${await response.text()}\n${output}`);
    } catch (error) {
      if (error instanceof Error && error.message.startsWith('Vite bridge returned')) throw error;
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 150));
  }
  throw new Error(`Timed out waiting for Vite bridge.\n${output}`);
}

async function compare(request: FixtureRequest): Promise<BrowserResult> {
  return page.evaluate((fixture) => (window as WindowWithAcceptance).docdiffAcceptance.compare(fixture), request);
}

function expectSuccessful(result: BrowserResult): NonNullable<BrowserResult['result']> {
  expect(result.state, `${JSON.stringify(result.error)}\nprogress=${JSON.stringify(result.progress)}\n${browserDiagnostics.join('\n')}`).toBe('complete');
  expect(result.error).toBeUndefined();
  return result.result!;
}

describe('independent browser engine acceptance', () => {
  beforeAll(async () => {
    await startVite();
    browser = await chromium.launch({ headless: true, chromiumSandbox: true });
    page = await browser.newPage();
    page.on('console', (message) => browserDiagnostics.push(`console:${message.type()}:${message.text()}`));
    page.on('requestfailed', (request) => browserDiagnostics.push(`request:${request.url()}:${request.failure()?.errorText ?? 'failed'}`));
    page.on('pageerror', (error) => browserDiagnostics.push(`pageerror:${error.message}`));
    await page.goto(`${origin}/tests/acceptance/bridge.html`);
    await page.waitForFunction(() => typeof (window as WindowWithAcceptance).docdiffAcceptance?.compare === 'function');
  }, 30_000);

  afterAll(async () => {
    await browser?.close();
    if (vite && vite.exitCode === null) {
      vite.kill();
      await new Promise<void>((resolveExit) => vite!.once('exit', () => resolveExit()));
    }
  }, 10_000);

  it('keeps the checked-in corpus aligned with its SHA-256 manifest', async () => {
    const manifestPath = resolve(process.cwd(), 'examples/corpus/manifest.json');
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as {
      files: Array<{ file: string; sha256: string; bytes: number }>;
    };
    expect(manifest.files.length).toBeGreaterThanOrEqual(16);
    for (const fixture of manifest.files) {
      const bytes = await readFile(resolve(process.cwd(), 'examples', fixture.file.replace(/^corpus\//u, 'corpus/')));
      expect(bytes.length, fixture.file).toBe(fixture.bytes);
      expect(createHash('sha256').update(bytes).digest('hex'), fixture.file).toBe(fixture.sha256);
    }
  });

  it('uses PDF.js on real identical and changed PDFs, including rendered visual-only changes', async () => {
    const identical = expectSuccessful(await compare({ beforeFile: 'identical-before.pdf', afterFile: 'identical-after.pdf' }));
    expect(identical.outcome).toBe('identical');
    expect(identical.rows).toHaveLength(1);
    expect(identical.rows[0]).toMatchObject({ status: 'unchanged', beforePage: 0, afterPage: 0 });
    expect(identical.documents.before.sha256).toBe(identical.documents.after.sha256);

    const changed = expectSuccessful(await compare({ beforeFile: 'word-number-before.pdf', afterFile: 'word-number-after.pdf' }));
    expect(changed.outcome).toBe('changed');
    expect(changed.rows).toHaveLength(1);
    expect(changed.rows[0].beforeText).toContain('pending');
    expect(changed.rows[0].beforeText).toContain('128,750');
    expect(changed.rows[0].afterText).toContain('approved');
    expect(changed.rows[0].afterText).toContain('182,750');
    expect(changed.rows[0].changes.some((change) => change.kind === 'removed' && /pending|128,750/u.test(change.text))).toBe(true);
    expect(changed.rows[0].changes.some((change) => change.kind === 'added' && /approved|182,750/u.test(change.text))).toBe(true);

    const visual = expectSuccessful(await compare({ beforeFile: 'visual-only-before.pdf', afterFile: 'visual-only-after.pdf' }));
    expect(visual.outcome).toBe('changed');
    expect(visual.rows[0].beforeText).toBe(visual.rows[0].afterText);
    expect(visual.rows[0].status).toBe('changed');
    expect(visual.rows[0].visual?.changedPixels).toBeGreaterThan(0);
    expect(visual.rows[0].visual?.hasDiffImage).toBe(true);
  }, 30_000);

  it('aligns both inserted and removed middle pages without shifting later anchors', async () => {
    const inserted = expectSuccessful(await compare({ beforeFile: 'insert-middle-before.pdf', afterFile: 'insert-middle-after.pdf' }));
    expect(inserted.rows.map(({ status, beforePage, afterPage }) => ({ status, beforePage, afterPage }))).toEqual([
      { status: 'unchanged', beforePage: 0, afterPage: 0 },
      { status: 'unchanged', beforePage: 1, afterPage: 1 },
      { status: 'added', beforePage: null, afterPage: 2 },
      { status: 'unchanged', beforePage: 2, afterPage: 3 },
      { status: 'unchanged', beforePage: 3, afterPage: 4 },
    ]);

    const removed = expectSuccessful(await compare({ beforeFile: 'insert-middle-after.pdf', afterFile: 'insert-middle-before.pdf' }));
    expect(removed.rows.map(({ status, beforePage, afterPage }) => ({ status, beforePage, afterPage }))).toEqual([
      { status: 'unchanged', beforePage: 0, afterPage: 0 },
      { status: 'unchanged', beforePage: 1, afterPage: 1 },
      { status: 'removed', beforePage: 2, afterPage: null },
      { status: 'unchanged', beforePage: 3, afterPage: 2 },
      { status: 'unchanged', beforePage: 4, afterPage: 3 },
    ]);
  }, 30_000);

  it('keeps scanned image pages visible and uncertain when PDF text extraction is empty', async () => {
    const scanned = expectSuccessful(await compare({ beforeFile: 'scanned-image-only.pdf', afterFile: 'scanned-image-only-copy.pdf' }));
    expect(scanned.outcome).toBe('uncertain');
    expect(scanned.warnings.join(' ')).toMatch(/text|extract|uncertain|image/iu);
    expect(scanned.rows).toHaveLength(1);
    expect(scanned.rows[0].beforeText.trim()).toBe('');
    expect(scanned.rows[0].afterText.trim()).toBe('');
    expect(scanned.rows[0].hasBeforeImage).toBe(true);
    expect(scanned.rows[0].hasAfterImage).toBe(true);
  }, 30_000);

  it('rejects malformed, oversized, over-page, over-text, and over-pixel input explicitly', async () => {
    const malformed = await compare({ beforeFile: 'malformed-truncated.pdf', afterFile: 'identical-after.pdf' });
    expect(malformed.state).toBe('error');
    expect(malformed.error?.code).toBe('PDF_DECODE_FAILED');

    const oversized = await compare({ beforeFile: 'identical-before.pdf', afterFile: 'identical-after.pdf', padBeforeBytes: 50 * 1024 * 1024 });
    expect(oversized.state).toBe('error');
    expect(oversized.error?.code).toBe('INPUT_TOO_LARGE');

    const tooManyPages = await compare({ beforeFile: 'resource-many-pages.pdf', afterFile: 'identical-after.pdf' });
    expect(tooManyPages.state).toBe('error');
    expect(tooManyPages.error?.code).toBe('TOO_MANY_PAGES');

    const tooMuchText = await compare({ beforeFile: 'resource-large-text.pdf', afterFile: 'identical-after.pdf' });
    expect(tooMuchText.state).toBe('error');
    expect(tooMuchText.error?.code).toBe('TEXT_LIMIT_EXCEEDED');

    const tooManyPixels = await compare({ beforeFile: 'resource-rendered-pixels.pdf', afterFile: 'identical-after.pdf' });
    expect(tooManyPixels.state).toBe('error');
    expect(tooManyPixels.error?.code).toBe('PIXEL_LIMIT_EXCEEDED');
  }, 30_000);

  it('downscales a huge physical page and safely escapes names in exported reports', async () => {
    const largePage = expectSuccessful(await compare({ beforeFile: 'resource-large-canvas.pdf', afterFile: 'resource-large-canvas-copy.pdf' }));
    expect(largePage.outcome).toBe('identical');
    expect(largePage.rows[0].status).toBe('unchanged');

    const attackName = '\"><img src=x onerror=alert(1)><svg onload=alert(2)>.pdf';
    const result = await compare({ beforeFile: 'identical-before.pdf', afterFile: 'identical-after.pdf', beforeName: attackName });
    const safe = expectSuccessful(result);
    expect(result.report?.rawNameAppearsInHtml).toBe(false);
    expect(result.report?.activeElementCount).toBe(0);
    expect(result.report?.eventHandlerAttributeCount).toBe(0);
    expect(result.report?.containsOriginalPdfBase64).toBe(false);
    expect(result.report?.html).toContain('&lt;img src=x onerror=alert(1)&gt;');
    expect(result.report?.html).toContain('&lt;svg onload=alert(2)&gt;');
    expect(safe.documents.before.name).toBe(attackName);
    expect(result.report?.json).not.toContain('data:application/pdf');
  }, 30_000);

  it('terminates its dedicated comparison worker independently of the core wall-time limit', async () => {
    const id = await page.evaluate(() => (window as WindowWithAcceptance).docdiffAcceptance.start({
      beforeFile: 'cancel-workload.pdf',
      afterFile: 'cancel-workload-copy.pdf',
    }));
    await page.waitForFunction((jobId) => {
      const current = (window as WindowWithAcceptance).docdiffAcceptance.state(jobId);
      return Boolean(current && current.progress.length > 0);
    }, id, { timeout: 8_000 });

    const beforeStop = await page.evaluate((jobId) => (window as WindowWithAcceptance).docdiffAcceptance.state(jobId), id);
    expect(beforeStop?.progress.length).toBeGreaterThan(0);
    expect(beforeStop?.state).toBe('running');
    const stopped = await page.evaluate((jobId) => (window as WindowWithAcceptance).docdiffAcceptance.terminate(jobId), id);
    expect(stopped?.state).toBe('terminated');
    const finalState = await page.evaluate((jobId) => (window as WindowWithAcceptance).docdiffAcceptance.state(jobId), id);
    expect(finalState?.state).toBe('terminated');
    expect(finalState?.progress).toEqual(stopped?.progress);
  }, 15_000);
});
