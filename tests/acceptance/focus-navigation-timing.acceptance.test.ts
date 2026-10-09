import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createServer as createNetServer } from 'node:net';
import { resolve } from 'node:path';
import { chromium, type Browser, type Page } from 'playwright';

type FocusProbe = Window & {
  __focusRafProbe?: {
    arm: () => void;
    pending: () => number;
    flush: () => void;
  };
};

let vite: ChildProcessWithoutNullStreams | undefined;
let browser: Browser | undefined;
let page: Page;
let origin: string;
let viteOutput = '';

function childHasExited(child: ChildProcessWithoutNullStreams): boolean {
  return child.exitCode !== null || child.signalCode !== null;
}

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
  vite = spawn(process.execPath, [resolve(process.cwd(), 'node_modules/vite/bin/vite.js'), '--host', '127.0.0.1', '--port', String(port), '--strictPort'], {
    cwd: process.cwd(),
    stdio: 'pipe',
  });
  vite.stdout.on('data', (chunk: Buffer) => { viteOutput += chunk.toString(); });
  vite.stderr.on('data', (chunk: Buffer) => { viteOutput += chunk.toString(); });
  origin = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 25_000;
  while (Date.now() < deadline) {
    if (childHasExited(vite)) throw new Error(`Vite exited before serving the app.\n${viteOutput}`);
    try {
      const response = await fetch(origin);
      if (response.ok) return;
    } catch {
      // Vite has not started listening yet.
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 150));
  }
  throw new Error(`Timed out waiting for Vite.\n${viteOutput}`);
}

async function waitForChildExit(child: ChildProcessWithoutNullStreams, timeoutMs: number): Promise<boolean> {
  if (childHasExited(child)) return true;
  return new Promise<boolean>((resolveExit) => {
    let settled = false;
    const finish = (didExit: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.removeListener('exit', onExit);
      resolveExit(didExit);
    };
    const onExit = () => finish(true);
    const timer = setTimeout(() => finish(false), timeoutMs);
    child.once('exit', onExit);
    if (childHasExited(child)) onExit();
  });
}

async function stopVite(): Promise<void> {
  const child = vite;
  if (!child || childHasExited(child)) return;
  child.kill();
  if (await waitForChildExit(child, 2_500)) return;
  child.kill('SIGKILL');
  if (!await waitForChildExit(child, 2_500)) throw new Error(`Vite server did not exit after forced termination.\n${viteOutput}`);
}

describe('real-browser keyboard focus scheduling', () => {
  beforeAll(async () => {
    await startVite();
    browser = await chromium.launch({ headless: true, chromiumSandbox: true });
    page = await browser.newPage();
    await page.goto(origin);
    await page.getByRole('heading', { name: 'Compare revision pairs' }).waitFor();

    await page.getByLabel('Pair 1 before document').setInputFiles(resolve(process.cwd(), 'examples/v1/corpus/docx-change-before.docx'));
    await page.getByLabel('Pair 1 after document').setInputFiles(resolve(process.cwd(), 'examples/v1/corpus/docx-change-after.docx'));
    await page.getByRole('button', { name: 'Compare pair' }).click();
    await page.locator('.change-item[aria-current="page"]').waitFor();
    await expectAtLeastTwoChangedRows();
    await page.getByRole('button', { name: 'Save selected HTML' }).focus();

    await page.evaluate(() => {
      const target = window as FocusProbe;
      const nativeRequestAnimationFrame = window.requestAnimationFrame.bind(window);
      let isArmed = false;
      const held: FrameRequestCallback[] = [];
      window.requestAnimationFrame = (callback: FrameRequestCallback) => {
        if (isArmed) {
          isArmed = false;
          held.push(callback);
          return -1;
        }
        return nativeRequestAnimationFrame(callback);
      };
      target.__focusRafProbe = {
        arm: () => { isArmed = true; },
        pending: () => held.length,
        flush: () => {
          const callback = held.shift();
          if (!callback) throw new Error('No focus animation-frame callback was captured');
          callback(performance.now());
        },
      };
    });
  }, 60_000);

  afterAll(async () => {
    const cleanups = [stopVite(), ...(browser ? [browser.close()] : [])];
    const results = await Promise.allSettled(cleanups);
    const failure = results.find((result): result is PromiseRejectedResult => result.status === 'rejected');
    if (failure) throw failure.reason;
  }, 10_000);

  it('shows the selection update before its deferred focus callback, then focuses the selected row', async () => {
    const selected = page.locator('.change-item[aria-current="page"]');
    const originalLabel = await selected.getAttribute('aria-label');
    expect(originalLabel).toBeTruthy();
    await page.evaluate(() => (window as FocusProbe).__focusRafProbe!.arm());
    await page.keyboard.press('Alt+ArrowDown');

    await page.waitForFunction((previous) => document.querySelector('.change-item[aria-current="page"]')?.getAttribute('aria-label') !== previous, originalLabel);
    const changedSelection = page.locator('.change-item[aria-current="page"]');
    expect(await changedSelection.getAttribute('aria-label')).not.toBe(originalLabel);
    expect(await page.evaluate(() => (window as FocusProbe).__focusRafProbe!.pending())).toBe(1);

    const deferredState = await page.evaluate(() => ({
      activeElementText: (document.activeElement as HTMLElement | null)?.textContent?.trim() ?? null,
      selectedLabel: document.querySelector('.change-item[aria-current="page"]')?.getAttribute('aria-label') ?? null,
    }));
    expect(deferredState.activeElementText).toBe('Save selected HTML');
    expect(deferredState.selectedLabel).not.toBe(originalLabel);

    await page.evaluate(() => (window as FocusProbe).__focusRafProbe!.flush());
    await expect.poll(() => changedSelection.evaluate((element) => element === document.activeElement)).toBe(true);
  }, 30_000);
});

async function expectAtLeastTwoChangedRows(): Promise<void> {
  await page.waitForFunction(() => document.querySelectorAll('.change-item[aria-current="page"]').length === 1);
  await page.waitForFunction(() => document.querySelectorAll('.change-item').length >= 2);
  const count = await page.locator('.change-item').count();
  expect(count, `expected at least two changed rows; Vite output:\n${viteOutput}`).toBeGreaterThanOrEqual(2);
}
