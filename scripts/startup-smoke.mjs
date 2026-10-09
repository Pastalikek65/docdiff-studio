import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import assert from 'node:assert/strict';
import electron from 'electron';
import { chromium } from 'playwright';

// Exercise the documented `electron .` entry, without the Electron automation
// inspector handshake. The debug endpoint is ephemeral and loopback-only.
const root = fileURLToPath(new URL('../', import.meta.url));
const artifact = path.join(root, 'artifacts', `startup-${randomUUID()}`);
await mkdir(artifact, { recursive: true });
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
delete env.DOC_DIFF_VITE_ORIGIN;
const child = spawn(electron, ['.', `--user-data-dir=${path.join(artifact, 'profile')}`, '--remote-debugging-address=127.0.0.1', '--remote-debugging-port=0'], { cwd: root, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
let browser, diagnostic = '';
try {
  const endpoint = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('The documented source entry did not open a debugging endpoint.')), 15000);
    const inspect = chunk => {
      diagnostic = (diagnostic + chunk.toString()).slice(-8192);
      const match = /DevTools listening on (ws:\/\/127\.0\.0\.1:[0-9]+\/devtools\/browser\/[^\s]+)/.exec(diagnostic);
      if (match) { clearTimeout(timer); resolve(match[1]); }
    };
    child.stdout.on('data', inspect);
    child.stderr.on('data', inspect);
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('exit', code => { clearTimeout(timer); reject(new Error(`Source app exited before startup: ${code}`)); });
  });
  browser = await chromium.connectOverCDP(endpoint, { timeout: 15000 });
  const context = browser.contexts()[0];
  const page = context.pages()[0] ?? await context.waitForEvent('page', { timeout: 15000 });
  await page.getByRole('button', { name: 'Compare PDFs' }).waitFor({ timeout: 15000 });
  assert.equal(page.url(), 'docdiff://app/index.html');
  assert.equal(await page.evaluate(() => typeof window.require), 'undefined');
  const url = page.url();
  const exited = child.exitCode === null
    ? new Promise(resolve => child.once('exit', resolve))
    : Promise.resolve();
  await page.close({ runBeforeUnload: false });
  let timeout;
  await Promise.race([exited, new Promise((_, reject) => { timeout = setTimeout(() => reject(new Error('The source app did not exit after its window closed.')), 5000); })]).finally(() => clearTimeout(timeout));
  await writeFile(path.join(artifact, 'startup.json'), JSON.stringify({ status: 'passed', entry: 'electron .', platform: `${process.platform}/${process.arch}`, url, nodeIntegrationExposed: false, directProcessExitedAfterWindowClose: true }, null, 2));
  console.log(JSON.stringify({ status: 'passed', artifact }));
} catch (error) {
  await writeFile(path.join(artifact, 'failure.json'), JSON.stringify({ status: 'failed', message: String(error), diagnostic }, null, 2));
  throw error;
} finally {
  if (browser) await browser.close().catch(() => undefined);
  if (child.exitCode === null) {
    const exited = new Promise(resolve => child.once('exit', resolve));
    child.kill();
    let timeout;
    await Promise.race([exited, new Promise((_, reject) => { timeout = setTimeout(() => reject(new Error('The owned source app did not exit after termination.')), 5000); })]).finally(() => clearTimeout(timeout));
  }
}
