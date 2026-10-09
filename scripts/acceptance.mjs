import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { _electron, chromium } from 'playwright';
import { createServer } from 'node:http';
import { execFileSync } from 'node:child_process';

const root = fileURLToPath(new URL('../', import.meta.url));
const artifact = path.join(root, 'artifacts', `acceptance-${randomUUID()}`);
await mkdir(artifact, { recursive: true });
const fixture = name => path.join(root, 'examples', 'corpus', name);
const manifest = JSON.parse(await readFile(fixture('manifest.json'), 'utf8'));
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const originals = new Map();
for (const entry of manifest.files) {
  const filename = path.join(root, 'examples', entry.file);
  const bytes = await readFile(filename);
  assert.equal(bytes.length, entry.bytes);
  assert.equal(digest(bytes), entry.sha256);
  originals.set(filename, digest(bytes));
}
const env = { ...process.env };
delete env.DOC_DIFF_VITE_ORIGIN;
delete env.ELECTRON_RUN_AS_NODE;
const executableIndex = process.argv.indexOf('--executable');
const executablePath = executableIndex >= 0 ? path.resolve(process.argv[executableIndex + 1]) : undefined;
const steps = [];
const startedAt = new Date().toISOString();
let app, browser, server, window;
let peakAppWorkingSetKiB = 0;
let samples = 0;
let sampleTimer;
const errors = [];
const consoleMessages = [];
let workerMessages = [];
try {
  app = await _electron.launch({ executablePath, args: [...(executablePath ? [] : [path.join(root, 'dist-electron/electron/main.js')]), `--user-data-dir=${path.join(artifact, 'profile')}`], env, chromiumSandbox: true, timeout: 60000 });
  window = await app.firstWindow();
  window.on('pageerror', error => errors.push(error.message));
  window.on('console', message => consoleMessages.push(`${message.type()}: ${message.text()}`));
  await window.getByRole('button', { name: 'Compare PDFs' }).waitFor();
  const security = await app.evaluate(({ BrowserWindow, app }) => {
    const window = BrowserWindow.getAllWindows()[0];
    const preferences = window.webContents.getLastWebPreferences();
    return { sandbox: preferences.sandbox, contextIsolation: preferences.contextIsolation, nodeIntegration: preferences.nodeIntegration, url: window.webContents.getURL(), packaged: app.isPackaged };
  });
  assert.equal(security.sandbox, true);
  assert.equal(security.contextIsolation, true);
  assert.equal(security.nodeIntegration, false);
  assert.equal(security.url, 'docdiff://app/index.html');
  assert.equal(await window.evaluate(() => typeof window.require), 'undefined');
  steps.push('cold startup and renderer isolation');
  sampleTimer = setInterval(async () => {
    try {
      const value = await app.evaluate(({ app }) => app.getAppMetrics().reduce((sum, item) => sum + item.memory.workingSetSize, 0));
      peakAppWorkingSetKiB = Math.max(peakAppWorkingSetKiB, value);
      samples++;
    } catch {}
  }, 200);
  const select = async (before, after) => {
    await window.locator('#before-file').setInputFiles(fixture(before));
    await window.locator('#after-file').setInputFiles(fixture(after));
    await window.getByRole('button', { name: 'Compare PDFs' }).click();
  };
  const save = async format => {
    const output = path.join(artifact, `comparison.${format}`);
    await app.evaluate(({ dialog }, output) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath: output }); }, output);
    await window.getByRole('button', { name: format === 'html' ? 'Save HTML' : 'Save JSON' }).click();
    await window.getByText('Report saved.', { exact: true }).waitFor();
    return { output, bytes: await readFile(output) };
  };
  await select('word-number-before.pdf', 'word-number-after.pdf');
  await window.waitForFunction(() => document.querySelector('.result-pill') || document.querySelector('.error-symbol'), { timeout: 60000 });
  assert.equal(await window.locator('.error-symbol').count(), 0, await window.locator('.status-strip').innerText());
  await window.getByText('Differences found', { exact: true }).waitFor({ timeout: 60000 });
  await window.waitForFunction(() => [...document.querySelectorAll('.page-image')].every(image => image.complete && image.naturalWidth > 0));
  assert.equal(await window.locator('.page-image').count(), 2);
  const json = await save('json');
  const report = JSON.parse(json.bytes.toString('utf8'));
  assert.equal(report.schemaVersion, 1);
  assert.equal(report.summary.changed, 1);
  assert.ok(report.rows[0].changes.some(change => change.kind === 'added'));
  assert.ok(report.rows[0].changes.some(change => change.kind === 'removed'));
  assert.ok(report.rows[0].visual.changedPixels > 0);
  const html = await save('html');
  assert.ok(!/<script\b/i.test(html.bytes.toString()));
  await window.screenshot({ path: path.join(artifact, 'review.png'), fullPage: true });
  browser = await chromium.launch({ chromiumSandbox: true });
  const reportPage = await browser.newPage();
  await reportPage.goto(pathToFileURL(html.output).href);
  await reportPage.getByRole('heading', { name: 'DocDiff Studio comparison' }).waitFor();
  await reportPage.waitForFunction(() => [...document.images].length >= 2 && [...document.images].every(image => image.complete && image.naturalWidth > 0));
  steps.push('actual worker word/number/pixel change and native IPC save with simulated dialog selection; standalone report reopened');
  await select('insert-middle-before.pdf', 'insert-middle-after.pdf');
  await window.getByRole('button', { name: 'Added: No matching page to Page 3' }).waitFor({ timeout: 60000 });
  const insertion = JSON.parse((await save('json')).bytes.toString('utf8'));
  assert.deepEqual(insertion.summary, { unchanged: 4, changed: 0, added: 1, removed: 0 });
  assert.ok(insertion.rows.some(row => row.beforePage === 2 && row.afterPage === 3 && row.status === 'unchanged'));
  steps.push('middle insertion aligned without cascading false changes');
  await select('identical-before.pdf', 'identical-after.pdf');
  await window.getByText('No differences found', { exact: true }).waitFor({ timeout: 60000 });
  steps.push('identical real PDF without false changes');
  await select('malformed-truncated.pdf', 'identical-after.pdf');
  await window.locator('.status-strip').filter({ hasText: /could not|failed|invalid|cannot/i }).waitFor({ timeout: 60000 });
  assert.equal(await window.getByRole('button', { name: 'Save HTML' }).isDisabled(), true);
  steps.push('malformed input fails without exportable result');
  await select('cancel-workload.pdf', 'cancel-workload-copy.pdf');
  await window.getByRole('button', { name: 'Cancel', exact: true }).click();
  await window.getByText('Comparison cancelled. No result was produced.', { exact: true }).waitFor();
  steps.push('worker cancellation discards result');
  let requests = 0;
  server = createServer((request, response) => { requests++; response.end('synthetic-canary'); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const canary = `http://127.0.0.1:${server.address().port}/`;
  assert.equal(await (await fetch(canary)).text(), 'synthetic-canary');
  requests = 0;
  const blocked = await window.evaluate(async url => { try { await fetch(url); return false; } catch { return true; } }, canary);
  assert.equal(blocked, true);
  assert.equal(requests, 0);
  steps.push('renderer network blocked against reachable synthetic loopback canary');
  for (const [filename, hash] of originals) assert.equal(digest(await readFile(filename)), hash);
  assert.deepEqual(errors, []);
  steps.push('source corpus unchanged and no renderer page errors');
  clearInterval(sampleTimer);
  const evidence = { schemaVersion: 1, status: 'passed', startedAt, finishedAt: new Date().toISOString(), platform: `${process.platform}/${process.arch}`, packaged: security.packaged, security, steps, outputs: { jsonSha256: digest(json.bytes), htmlSha256: digest(html.bytes) }, performance: { peakAppWorkingSetKiB, samples, sampleIntervalMs: 200, scope: 'Sampled sum of Electron app metrics working sets; synthetic warm fixture flow, not total OS memory or a throughput guarantee' } };
  await writeFile(path.join(artifact, 'acceptance.json'), JSON.stringify(evidence, null, 2) + '\n');
  console.log(JSON.stringify({ status: 'passed', artifact, steps: steps.length }));
} catch (error) {
  clearInterval(sampleTimer);
  let visibleState = '';
  if (window) {
    try { visibleState = (await window.locator('body').innerText()).slice(0, 6000); workerMessages = await window.evaluate(() => window.__acceptanceWorkerMessages ?? []); await window.screenshot({ path: path.join(artifact, 'failure.png'), fullPage: true }); } catch {}
  }
  await writeFile(path.join(artifact, 'failure.json'), JSON.stringify({ status: 'failed', steps, message: String(error), errors, consoleMessages, workerMessages, visibleState }, null, 2));
  console.error(JSON.stringify({ status: 'failed', artifact, message: String(error) }));
  process.exitCode = 1;
} finally {
  clearInterval(sampleTimer);
  if (server) await new Promise(resolve => server.close(resolve));
  if (browser) await browser.close();
  if (app) await app.close();
}
