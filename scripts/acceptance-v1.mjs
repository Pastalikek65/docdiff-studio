import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createServer } from 'node:http';
import { _electron, chromium } from 'playwright';
import os from 'node:os';
import { execFileSync } from 'node:child_process';

const root = fileURLToPath(new URL('../', import.meta.url));
const artifact = path.join(root, 'artifacts', `acceptance-v1-${randomUUID()}`);
await mkdir(artifact, { recursive: true });
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const sourceIdentity = {
  commit: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
  dirty: execFileSync('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf8' }).trim().length > 0,
  trackedChanges: execFileSync('git', ['diff', '--name-only', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim().split('\n').filter(Boolean),
  untrackedPaths: execFileSync('git', ['ls-files', '--others', '--exclude-standard'], { cwd: root, encoding: 'utf8' }).trim().split('\n').filter(Boolean),
};
const originals = new Map();
for (const folder of ['corpus', 'v1']) {
  const manifest = JSON.parse(await readFile(path.join(root, 'examples', folder, 'manifest.json'), 'utf8'));
  for (const entry of manifest.files) {
    const filename = folder === 'corpus' ? path.join(root, 'examples', entry.file) : path.join(root, 'examples', 'v1', 'corpus', entry.name);
    const bytes = await readFile(filename);
    assert.equal(bytes.length, entry.bytes);
    assert.equal(digest(bytes), entry.sha256);
    originals.set(filename, digest(bytes));
  }
}
const fixture = name => path.join(root, 'examples', ...(/^(docx-|ocr-|pdf-)/.test(name) ? ['v1', 'corpus'] : ['corpus']), name);
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
delete env.DOC_DIFF_VITE_ORIGIN;
const executableIndex = process.argv.indexOf('--executable');
const executablePath = executableIndex >= 0 ? path.resolve(process.argv[executableIndex + 1]) : undefined;
let app, window, browser, server, cdp, sampleTimer;
let peakAppWorkingSetKiB = 0, samples = 0;
const steps = [], observations = {}, errors = [], requests = [], consoleMessages = [];
const startedAt = new Date().toISOString();
let exportSequence = 0;
try {
  app = await _electron.launch({ executablePath, args: [...(executablePath ? [] : [path.join(root, 'dist-electron/electron/main.js')]), `--user-data-dir=${path.join(artifact, 'profile')}`], env, chromiumSandbox: true, timeout: 60000 });
  window = await app.firstWindow();
  window.on('pageerror', error => errors.push(error.message));
  window.on('console', message => consoleMessages.push(`${message.type()}: ${message.text()}`));
  window.context().on('request', request => requests.push(request.url()));
  await window.getByRole('button', { name: /Compare pair/ }).waitFor();
  const security = await app.evaluate(({ BrowserWindow, app }) => {
    const window = BrowserWindow.getAllWindows()[0];
    const preferences = window.webContents.getLastWebPreferences();
    return { sandbox: preferences.sandbox, contextIsolation: preferences.contextIsolation, nodeIntegration: preferences.nodeIntegration, url: window.webContents.getURL(), packaged: app.isPackaged, appVersion: app.getVersion(), appPath: app.getAppPath(), executablePath: process.execPath };
  });
  assert.equal(security.sandbox, true);
  assert.equal(security.contextIsolation, true);
  assert.equal(security.nodeIntegration, false);
  assert.equal(security.url, 'docdiff://app/index.html');
  assert.equal(await window.evaluate(() => typeof window.require), 'undefined');
  if (executablePath) {
    assert.equal(security.packaged, true, 'An explicit package executable must run a packaged app.');
    assert.equal(security.appVersion, JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8')).version);
  }
  const applicationIdentity = { version: security.appVersion, executableSha256: digest(await readFile(security.executablePath)), ...(security.packaged ? { appArchiveSha256: digest(await readFile(security.appPath)) } : {}) };
  const assetServerModuleUrl = pathToFileURL(path.join(security.packaged ? security.appPath : root, 'dist-electron/electron/main.js')).href;
  const applicationFiles = [{ path: security.executablePath, sha256: applicationIdentity.executableSha256 }, ...(security.packaged ? [{ path: security.appPath, sha256: applicationIdentity.appArchiveSha256 }] : [])];
  delete security.appPath;
  delete security.executablePath;
  steps.push('cold startup and renderer isolation');
  sampleTimer = setInterval(async () => {
    try {
      const value = await app.evaluate(({ app }) => app.getAppMetrics().reduce((sum, item) => sum + item.memory.workingSetSize, 0));
      peakAppWorkingSetKiB = Math.max(peakAppWorkingSetKiB, value);
      samples++;
    } catch {}
  }, 200);
  const setPair = async (before, after, number = 1) => {
    await window.getByLabel(`Pair ${number} before document`, { exact: true }).setInputFiles(fixture(before));
    await window.getByLabel(`Pair ${number} after document`, { exact: true }).setInputFiles(fixture(after));
  };
  const run = async () => {
    await window.getByRole('button', { name: /Compare (pair|all pairs)/ }).click();
    await window.getByRole('button', { name: 'Cancel batch', exact: true }).waitFor({ state: 'hidden', timeout: 130000 });
  };
  const pairSection = number => window.locator(`section[aria-label="Pair ${number}"]`);
  const save = async format => {
    const output = path.join(artifact, `comparison-${++exportSequence}.${format}`);
    await app.evaluate(({ dialog }, output) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath: output }); }, output);
    await window.getByRole('button', { name: format === 'html' ? 'Save selected HTML' : 'Save batch JSON', exact: true }).click();
    await window.getByText('Report saved.', { exact: true }).waitFor();
    return { output, bytes: await readFile(output) };
  };
  const readResult = async () => {
    const json = await save('json');
    const report = JSON.parse(json.bytes.toString('utf8'));
    assert.equal(report.schemaVersion, 2);
    assert.ok(!report.reportKind, 'Single completed pair should export its direct version-2 report.');
    assert.ok(Array.isArray(report.rows));
    return report;
  };
  const compare = async (before, after) => {
    await setPair(before, after);
    await run();
    assert.equal(await pairSection(1).locator('.pair-error').count(), 0, await pairSection(1).innerText());
    return readResult();
  };
  const pdf = await compare('word-number-before.pdf', 'word-number-after.pdf');
  assert.equal(pdf.summary.changed, 1);
  assert.ok(pdf.rows[0].changes.some(change => change.kind === 'added'));
  assert.ok(pdf.rows[0].changes.some(change => change.kind === 'removed'));
  assert.ok(pdf.rows[0].visual.changedPixels > 0);
  assert.equal(pdf.rows[0].beforeLocation.format, 'pdf');
  await window.waitForFunction(() => [...document.querySelectorAll('.page-image')].length === 2 && [...document.querySelectorAll('.page-image')].every(image => image.complete && image.naturalWidth > 0));
  const html = await save('html');
  assert.ok(!/<script\b/i.test(html.bytes.toString()));
  browser = await chromium.launch({ chromiumSandbox: true });
  const reportPage = await browser.newPage();
  await reportPage.goto(pathToFileURL(html.output).href);
  await reportPage.getByRole('heading', { name: 'DocDiff Studio comparison' }).waitFor();
  await reportPage.waitForFunction(() => document.images.length >= 2 && [...document.images].every(image => image.complete && image.naturalWidth > 0));
  steps.push('real PDF word/number/visual comparison, native save IPC with simulated dialog destination, standalone HTML reopening');
  const insertion = await compare('insert-middle-before.pdf', 'insert-middle-after.pdf');
  assert.deepEqual(insertion.summary, { unchanged: 4, changed: 0, added: 1, removed: 0, moved: 0 });
  assert.ok(insertion.rows.some(row => row.beforeLocation?.index === 2 && row.afterLocation?.index === 3 && row.status === 'unchanged'));
  await window.getByRole('button', { name: 'Added: No matching unit to Page 3', exact: true }).click();
  steps.push('middle PDF insertion preserves later alignment and change navigation');
  const identical = await compare('identical-before.pdf', 'identical-after.pdf');
  assert.equal(identical.outcome, 'identical');
  steps.push('identical digital PDF without false changes');
  await setPair('malformed-truncated.pdf', 'identical-after.pdf');
  await run();
  assert.ok((await pairSection(1).locator('.pair-error').innerText()).includes('PDF_DECODE_FAILED'));
  assert.equal(await window.getByRole('button', { name: 'Save selected HTML' }).isDisabled(), true);
  steps.push('malformed PDF fails without an exportable comparison');
  const docx = await compare('docx-change-before.docx', 'docx-change-after.docx');
  assert.equal(docx.outcome, 'changed');
  assert.equal(docx.documents.before.unitKind, 'docx-block');
  assert.equal(docx.documents.before.physicalPageCount, undefined);
  assert.ok(docx.rows.some(row => row.cellChanges?.some(cell => cell.changes.some(change => change.kind !== 'equal'))));
  assert.ok(docx.rows.every(row => !row.beforeImageDataUrl && !row.afterImageDataUrl));
  const docxHtml = await save('html');
  assert.ok(!/<script\b/i.test(docxHtml.bytes.toString()));
  await reportPage.goto(pathToFileURL(docxHtml.output).href);
  assert.ok((await reportPage.locator('body').innerText()).includes('DOCX'));
  await window.screenshot({ path: path.join(artifact, 'docx-review.png'), fullPage: true });
  observations.docx = { summary: docx.summary, htmlSha256: digest(docxHtml.bytes) };
  steps.push('real DOCX paragraph/table-cell differences with logical locations and reopened HTML');
  const selectedChange = window.locator('.change-item[aria-current="page"]');
  const firstChangeLabel = await selectedChange.getAttribute('aria-label');
  await window.getByRole('button', { name: 'Save selected HTML' }).focus();
  await window.keyboard.press('Alt+ArrowDown');
  await window.waitForFunction(previous => document.querySelector('.change-item[aria-current="page"]')?.getAttribute('aria-label') !== previous, firstChangeLabel);
  await window.waitForFunction(() => document.querySelector('.change-item[aria-current="page"]') === document.activeElement, undefined, { timeout: 3000 });
  assert.equal(await selectedChange.evaluate(element => element === document.activeElement), true);
  await window.keyboard.press('Alt+ArrowUp');
  await window.waitForFunction(previous => document.querySelector('.change-item[aria-current="page"]')?.getAttribute('aria-label') === previous, firstChangeLabel);
  await window.waitForFunction(() => document.querySelector('.change-item[aria-current="page"]') === document.activeElement, undefined, { timeout: 3000 });
  assert.equal(await selectedChange.evaluate(element => element === document.activeElement), true);
  steps.push('keyboard change navigation moves focus and returns to the original DOCX change');
  const moved = await compare('docx-move-before.docx', 'docx-move-after.docx');
  assert.equal(moved.summary.moved, 1);
  assert.ok(moved.rows.some(row => row.status === 'moved' && row.moveId && row.beforeLocation && row.afterLocation));
  const duplicate = await compare('docx-duplicate-before.docx', 'docx-duplicate-after.docx');
  assert.equal(duplicate.summary.moved, 0);
  steps.push('exact unique DOCX move and duplicate boilerplate ambiguity');
  const pdfMove = await compare('pdf-move-before.pdf', 'pdf-move-after.pdf');
  assert.equal(pdfMove.summary.moved, 1);
  assert.ok(pdfMove.rows.some(row => row.status === 'moved' && row.beforeLocation.index === 1 && row.afterLocation.index === 3 && row.moveId));
  const duplicatePages = await compare('pdf-duplicate-move-before.pdf', 'pdf-duplicate-move-after.pdf');
  assert.equal(duplicatePages.summary.moved, 1);
  assert.ok(duplicatePages.rows.filter(row => row.status === 'moved').every(row => row.beforeText.includes('PDF DUPLICATE ENDING')));
  steps.push('unique PDF page movement preserves duplicate-page ambiguity');
  const visualMove = await compare('pdf-move-before.pdf', 'pdf-move-visual-after.pdf');
  assert.equal(visualMove.summary.moved, 1);
  const visuallyChangedMove = visualMove.rows.find(row => row.status === 'moved');
  assert.ok(visuallyChangedMove.visual.changedPixels > 0);
  assert.ok(visuallyChangedMove.visual.diffImageDataUrl.startsWith('data:image/png;base64,'));
  const moveHtml = await save('html');
  assert.ok(moveHtml.bytes.toString('utf8').includes('Visual difference'));
  steps.push('moved PDF page retains independently computed visual differences in JSON and HTML');
  const benchmarkStarted = performance.now();
  const benchmark = await compare('docx-benchmark-before.docx', 'docx-benchmark-after.docx');
  assert.equal(benchmark.documents.before.unitCount, 1500);
  assert.equal(benchmark.documents.after.unitCount, 1500);
  assert.equal(benchmark.summary.changed, 2);
  assert.equal(benchmark.summary.unchanged, 1498);
  observations.docxBenchmark = { elapsedMsIncludingNativeSave: performance.now() - benchmarkStarted, unitsPerDocument: 1500, paragraphs: 1000, tableRows: 500, beforeBytes: (await readFile(fixture('docx-benchmark-before.docx'))).length, afterBytes: (await readFile(fixture('docx-benchmark-after.docx'))).length, scope: 'One warm synthetic run, comparison and JSON save; not a throughput guarantee' };
  steps.push('1500-unit synthetic DOCX workload has exactly two changed units');
  const unsupported = await compare('docx-header-before.docx', 'docx-header-after.docx');
  assert.notEqual(unsupported.outcome, 'identical');
  assert.equal(unsupported.certainty, 'incomplete');
  assert.ok(unsupported.warnings.length);
  steps.push('unsupported DOCX headers remain incomplete rather than falsely identical');
  await setPair('docx-hostile-traversal.docx', 'docx-change-before.docx');
  await run();
  assert.ok((await pairSection(1).locator('.pair-error').innerText()).includes('DOCX_PACKAGE_INVALID'));
  assert.equal(await window.getByRole('button', { name: 'Save selected HTML' }).isDisabled(), true);
  steps.push('hostile DOCX archive path rejected without a comparison');
  await window.locator('.compare-settings > summary').click();
  await window.getByLabel('Read selected scanned PDF pages with local English OCR', { exact: true }).check();
  await window.getByLabel('Original PDF pages', { exact: true }).fill('1');
  await window.getByLabel('Revised PDF pages', { exact: true }).fill('1');
  const ocrStarted = performance.now();
  const ocr = await compare('ocr-word-before.pdf', 'ocr-number-after.pdf');
  assert.equal(ocr.outcome, 'changed');
  assert.equal(ocr.certainty, 'incomplete');
  assert.equal(ocr.rows[0].textEvidence.before.source, 'ocr');
  assert.equal(ocr.rows[0].textEvidence.after.source, 'ocr');
  assert.ok(ocr.rows[0].beforeText.includes('1250'));
  assert.ok(ocr.rows[0].afterText.includes('1350'));
  assert.ok(Number.isFinite(ocr.rows[0].textEvidence.before.confidence));
  assert.ok(ocr.warnings.length);
  observations.ocr = { elapsedMs: performance.now() - ocrStarted, beforeConfidence: ocr.rows[0].textEvidence.before.confidence, afterConfidence: ocr.rows[0].textEvidence.after.confidence };
  await window.screenshot({ path: path.join(artifact, 'ocr-review.png'), fullPage: true });
  steps.push('actual offline English OCR recognizes changed numbers with confidence and uncertainty');
  const sameScan = await compare('ocr-identical-before.pdf', 'ocr-identical-after.pdf');
  assert.equal(sameScan.outcome, 'uncertain');
  steps.push('matching OCR-derived scans remain uncertain');
  await window.getByLabel('Original PDF pages', { exact: true }).fill('2');
  await window.getByLabel('Revised PDF pages', { exact: true }).fill('2');
  const mixed = await compare('ocr-mixed-before.pdf', 'ocr-mixed-after.pdf');
  assert.ok(mixed.rows.some(row => row.beforeLocation?.index === 0 && row.textEvidence.before.source === 'pdf-text'));
  assert.ok(mixed.rows.some(row => row.beforeLocation?.index === 1 && row.textEvidence.before.source === 'ocr'));
  steps.push('OCR runs only on selected empty-text pages and preserves digital text evidence');
  cdp = await window.context().newCDPSession(window);
  await window.getByLabel('Original PDF pages', { exact: true }).fill('1,2,3,4,5,6,7,8');
  await window.getByLabel('Revised PDF pages', { exact: true }).fill('1,2,3,4,5,6,7,8');
  await setPair('ocr-cancel-before.pdf', 'ocr-cancel-after.pdf');
  await window.getByRole('button', { name: /Compare pair/ }).click();
  const workerDeadline = Date.now() + 20000;
  let activeOcrTargets = [];
  while (Date.now() < workerDeadline) {
    activeOcrTargets = (await cdp.send('Target.getTargets')).targetInfos.filter(target => target.type === 'worker' && target.url.includes('/vendor/ocr/worker.min.js'));
    if (activeOcrTargets.length) break;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.ok(activeOcrTargets.length, 'Cancel test must reach a genuine OCR worker.');
  await window.getByRole('button', { name: 'Cancel batch', exact: true }).click();
  await pairSection(1).getByText('Cancelled', { exact: true }).waitFor();
  const cancelDeadline = Date.now() + 10000;
  let remaining = [];
  do {
    remaining = (await cdp.send('Target.getTargets')).targetInfos.filter(target => activeOcrTargets.some(old => old.targetId === target.targetId));
    if (!remaining.length) break;
    await new Promise(resolve => setTimeout(resolve, 100));
  } while (Date.now() < cancelDeadline);
  assert.deepEqual(remaining, [], 'The actual OCR worker must terminate after cancel.');
  assert.equal(await window.getByRole('button', { name: 'Save selected HTML' }).isDisabled(), true);
  observations.cancellation = { activeOcrWorkers: activeOcrTargets.length, allCapturedTargetsDestroyed: true };
  steps.push('actual OCR worker reached and CDP targets destroyed after cancellation; no completed result');
  let missingModelRequests = 0;
  const modelUrl = 'docdiff://app/vendor/ocr/lang/eng.traineddata';
  // HTTP routing and webRequest do not intercept this custom protocol's asset
  // reads. Delegate every other asset to the shipped server function and return
  // a 404 for only the model. The original network allowlist remains installed.
  try {
  await app.evaluate(async ({ protocol }, { modelUrl, assetServerModuleUrl }) => {
    const { createRequire } = process.getBuiltinModule('module');
    const { fileURLToPath } = process.getBuiltinModule('url');
    const { serveAppAsset } = createRequire(assetServerModuleUrl)(fileURLToPath(assetServerModuleUrl));
    if (typeof serveAppAsset !== 'function') throw new Error('The shipped asset server export is missing.');
    globalThis.__docdiffDeniedModelRequests = 0;
    protocol.unhandle('docdiff');
    protocol.handle('docdiff', request => {
      if (request.url === modelUrl) {
        globalThis.__docdiffDeniedModelRequests++;
        return new Response('Synthetic missing local model', { status: 404 });
      }
      return serveAppAsset(request.url, request.method);
    });
  }, { modelUrl, assetServerModuleUrl });
    await window.getByLabel('Original PDF pages', { exact: true }).fill('1');
    await window.getByLabel('Revised PDF pages', { exact: true }).fill('1');
    await setPair('ocr-word-before.pdf', 'ocr-number-after.pdf');
    await window.getByRole('button', { name: /Compare pair/ }).click();
    await pairSection(1).locator('.pair-failed').waitFor({ timeout: 15000 });
    missingModelRequests = await app.evaluate(() => globalThis.__docdiffDeniedModelRequests);
    assert.ok(missingModelRequests > 0, 'Failure injection must reach the actual local model request.');
    assert.ok((await pairSection(1).locator('.pair-error').innerText()).includes('OCR_FAILED'));
    assert.equal(await window.getByRole('button', { name: 'Save selected HTML' }).isDisabled(), true);
    const workerDeadline = Date.now() + 10000;
    let left;
    do {
      left = (await cdp.send('Target.getTargets')).targetInfos.filter(target => target.type === 'worker' && target.url.includes('/vendor/ocr/worker.min.js'));
      if (!left.length) break;
      await new Promise(resolve => setTimeout(resolve, 100));
    } while (Date.now() < workerDeadline);
    assert.deepEqual(left, [], 'A missing model must leave no actual OCR worker alive.');
  } finally {
    await app.evaluate(async ({ protocol }, assetServerModuleUrl) => {
      const { createRequire } = process.getBuiltinModule('module');
      const { fileURLToPath } = process.getBuiltinModule('url');
      const { serveAppAsset } = createRequire(assetServerModuleUrl)(fileURLToPath(assetServerModuleUrl));
      protocol.unhandle('docdiff');
      protocol.handle('docdiff', request => serveAppAsset(request.url, request.method));
      delete globalThis.__docdiffDeniedModelRequests;
    }, assetServerModuleUrl);
  }
  observations.missingModel = { controlledLocal404Requests: missingModelRequests, injection: 'Model-only protocol 404; every other asset delegated to shipped server; original network allowlist unchanged', failedWithoutResult: true, noRemainingOcrTargets: true };
  steps.push('unreadable local OCR model produces explicit failure, no report and no surviving OCR worker');
  await window.getByLabel('Read selected scanned PDF pages with local English OCR', { exact: true }).uncheck();
  await setPair('docx-change-before.docx', 'docx-change-after.docx');
  await window.getByRole('button', { name: /Add pair/ }).click();
  await setPair('malformed-truncated.pdf', 'identical-after.pdf', 2);
  await window.getByRole('button', { name: /Add pair/ }).click();
  await setPair('identical-before.pdf', 'identical-after.pdf', 3);
  await run();
  await pairSection(1).locator('.pair-done').waitFor();
  await pairSection(2).locator('.pair-failed').waitFor();
  await pairSection(3).locator('.pair-done').waitFor();
  const batchOutput = await save('json');
  const batch = JSON.parse(batchOutput.bytes.toString('utf8'));
  assert.equal(batch.schemaVersion, 2);
  assert.equal(batch.reportKind, 'batch');
  assert.deepEqual(batch.jobs.map(job => job.status), ['succeeded', 'failed', 'succeeded']);
  assert.ok(batch.jobs[0].result.rows.length);
  assert.equal(batch.jobs[1].result, undefined);
  assert.equal(batch.jobs[1].error.code, 'PDF_DECODE_FAILED');
  assert.equal(batch.jobs[2].result.outcome, 'identical');
  assert.ok(!batchOutput.bytes.includes(Buffer.from(root)));
  observations.batch = { statuses: batch.jobs.map(job => job.status), sha256: digest(batchOutput.bytes) };
  steps.push('sequential mixed-format batch retains successes and exports explicit failed job state');
  await setPair('cancel-workload.pdf', 'cancel-workload-copy.pdf', 1);
  await window.getByRole('button', { name: /Compare all pairs/ }).click();
  await window.getByRole('button', { name: 'Cancel batch', exact: true }).click();
  await pairSection(1).getByText('Cancelled', { exact: true }).waitFor();
  await pairSection(2).getByText('Not run', { exact: true }).waitFor();
  await pairSection(3).getByText('Not run', { exact: true }).waitFor();
  const cancelledBatch = JSON.parse((await save('json')).bytes.toString('utf8'));
  assert.equal(cancelledBatch.reportKind, 'batch');
  assert.deepEqual(cancelledBatch.jobs.map(job => job.status), ['cancelled', 'not-run', 'not-run']);
  assert.ok(cancelledBatch.jobs.every(job => !job.result));
  steps.push('batch cancellation leaves later jobs visibly not run');
  await setPair('malformed-truncated.pdf', 'identical-after.pdf', 1);
  await setPair('docx-hostile-traversal.docx', 'docx-change-before.docx', 2);
  await setPair('malformed-truncated.pdf', 'identical-after.pdf', 3);
  await run();
  const failedBatch = JSON.parse((await save('json')).bytes.toString('utf8'));
  assert.equal(failedBatch.reportKind, 'batch');
  assert.deepEqual(failedBatch.jobs.map(job => job.status), ['failed', 'failed', 'failed']);
  assert.ok(failedBatch.jobs.every(job => !job.result && job.error?.code));
  assert.equal(await window.getByRole('button', { name: 'Save selected HTML' }).isDisabled(), true);
  steps.push('all-failed zero-result batch exports explicit errors through actual desktop save IPC');
  let canaryRequests = 0;
  server = createServer((request, response) => { canaryRequests++; response.end('synthetic-canary'); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const canary = `http://127.0.0.1:${server.address().port}/`;
  assert.equal(await (await fetch(canary)).text(), 'synthetic-canary');
  canaryRequests = 0;
  assert.equal(await window.evaluate(async url => { try { await fetch(url); return false; } catch { return true; } }, canary), true);
  assert.equal(canaryRequests, 0);
  assert.ok(requests.every(url => url.startsWith('docdiff://app/') || url.startsWith('data:') || url.startsWith('blob:') || url === canary), 'An unexpected remote asset was requested.');
  assert.ok(requests.some(url => url.includes('/vendor/ocr/worker.min.js')));
  assert.ok(requests.some(url => url.includes('/vendor/ocr/lang/eng.traineddata')));
  assert.ok(requests.some(url => url.includes('/vendor/ocr/core/')));
  steps.push('only local OCR assets requested and reachable loopback canary blocked');
  for (const [filename, hash] of originals) assert.equal(digest(await readFile(filename)), hash);
  for (const file of applicationFiles) assert.equal(digest(await readFile(file.path)), file.sha256, 'Application bytes must remain unchanged during acceptance.');
  observations.applicationBytesUnchanged = true;
  assert.deepEqual(errors, []);
  steps.push('both source corpora unchanged and no renderer page errors');
  clearInterval(sampleTimer);
  const evidence = { schemaVersion: 2, suite: 'actual-desktop-v1', status: 'passed', startedAt, finishedAt: new Date().toISOString(), platform: `${process.platform}/${process.arch}`, host: { osRelease: os.release(), osVersion: os.version(), cpuModel: os.cpus()[0]?.model, logicalCpus: os.cpus().length, totalMemoryBytes: os.totalmem() }, packaged: security.packaged, security, steps, observations, localAssetRequests: [...new Set(requests.filter(url => url.includes('/vendor/ocr/')))], performance: { peakAppWorkingSetKiB, samples, sampleIntervalMs: 200, scope: 'Sampled sum of owned Electron app metrics working sets; synthetic sequential workflow, not OS memory ceiling or throughput guarantee' } };
  evidence.source = sourceIdentity;
  evidence.application = applicationIdentity;
  await writeFile(path.join(artifact, 'acceptance.json'), JSON.stringify(evidence, null, 2)+'\n');
  console.log(JSON.stringify({ status: 'passed', artifact, steps: steps.length }));
} catch (error) {
  clearInterval(sampleTimer);
  let visibleState = '';
  if (window) {
    try { visibleState = (await window.locator('body').innerText()).slice(0, 9000); await window.screenshot({ path: path.join(artifact, 'failure.png'), fullPage: true }); } catch {}
  }
  await writeFile(path.join(artifact, 'failure.json'), JSON.stringify({ status: 'failed', steps, message: String(error), errors, consoleMessages, visibleState, requests }, null, 2));
  console.error(JSON.stringify({ status: 'failed', artifact, message: String(error) }));
  process.exitCode = 1;
} finally {
  clearInterval(sampleTimer);
  if (cdp) await cdp.detach().catch(() => undefined);
  if (server) await new Promise(resolve => server.close(resolve));
  if (browser) await browser.close();
  if (app) await app.close();
}
