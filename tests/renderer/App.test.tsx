// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import App from '../../src/renderer/App.js';
import type { CompareOptions, ComparisonResult } from '../../src/core/types.js';

type FakeRequest = {
  type: 'compare';
  before: { name: string; bytes: ArrayBuffer };
  after: { name: string; bytes: ArrayBuffer };
  options: CompareOptions;
};

const makeResult = (): ComparisonResult => ({
  schemaVersion: 1,
  documents: {
    before: { name: 'original.pdf', format: 'pdf', sha256: 'a'.repeat(64), pageCount: 1 },
    after: { name: 'revised.pdf', format: 'pdf', sha256: 'b'.repeat(64), pageCount: 2 },
  },
  options: { ignoreWhitespace: false, ignoreHeaderLines: 0, ignoreFooterLines: 0, visualThreshold: 24 },
  rows: [
    {
      id: 'page-0', status: 'changed', beforePage: 0, afterPage: 0,
      beforeText: 'old headline', afterText: 'new headline',
      changes: [{ kind: 'removed', text: 'old headline' }, { kind: 'added', text: 'new headline' }],
      beforeImageDataUrl: 'data:image/png;base64,AAAA', afterImageDataUrl: 'data:image/png;base64,BBBB',
    },
    {
      id: 'page-1', status: 'added', beforePage: null, afterPage: 1,
      beforeText: '', afterText: 'A new appendix page',
      changes: [{ kind: 'added', text: 'A new appendix page' }],
      afterImageDataUrl: 'data:image/png;base64,CCCC',
    },
  ],
  summary: { unchanged: 0, changed: 1, added: 1, removed: 0 },
  warnings: [],
  outcome: 'changed',
});

class ControlledWorker {
  static latest: ControlledWorker | null = null;
  static nextResult: ComparisonResult | null = null;
  static respond = true;
  static initialEnvelope: unknown = undefined;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;
  onmessageerror: ((event: MessageEvent) => void) | null = null;
  request: FakeRequest | null = null;
  transfer: Transferable[] = [];
  terminated = false;

  constructor(_url: URL, _options?: WorkerOptions) {
    ControlledWorker.latest = this;
  }

  postMessage(message: FakeRequest, transfer: Transferable[] = []) {
    this.request = message;
    this.transfer = transfer;
    if (!ControlledWorker.respond) return;
    if (ControlledWorker.initialEnvelope !== undefined) {
      setTimeout(() => this.onmessage?.({ data: ControlledWorker.initialEnvelope } as MessageEvent), 0);
    }
    setTimeout(() => this.onmessage?.({ data: { type: 'progress', progress: { phase: 'Rendering pages', completed: 1, total: 2 } } } as MessageEvent), 0);
    setTimeout(() => this.onmessage?.({ data: { type: 'complete', result: ControlledWorker.nextResult ?? makeResult() } } as MessageEvent), 8);
  }

  terminate() { this.terminated = true; }
}

const originalArrayBuffer = Object.getOwnPropertyDescriptor(File.prototype, 'arrayBuffer');

beforeEach(() => {
  ControlledWorker.latest = null;
  ControlledWorker.nextResult = makeResult();
  ControlledWorker.respond = true;
  ControlledWorker.initialEnvelope = undefined;
  vi.stubGlobal('Worker', ControlledWorker as unknown as typeof Worker);
  Object.defineProperty(File.prototype, 'arrayBuffer', {
    configurable: true,
    value: async function (this: File) { return new TextEncoder().encode(this.name).buffer as ArrayBuffer; },
  });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  if (originalArrayBuffer) Object.defineProperty(File.prototype, 'arrayBuffer', originalArrayBuffer);
  else delete (File.prototype as Partial<File>).arrayBuffer;
});

function selectedPdfs() {
  return [
    new File(['before bytes'], 'original.pdf', { type: 'application/pdf' }),
    new File(['after bytes'], 'revised.pdf', { type: 'application/pdf' }),
  ] as const;
}

describe('document review workspace', () => {
  it('compares selected PDFs, jumps between changes and saves the generated HTML report', async () => {
    ControlledWorker.initialEnvelope = { sourceName: 'worker', targetName: 'main', action: 'ready', data: new Uint8Array() };
    const user = userEvent.setup();
    const saveReport = vi.fn().mockResolvedValue({ ok: true });
    Object.defineProperty(window, 'docDiffDesktop', { configurable: true, value: { saveReport } });
    const { container } = render(<App />);
    const [before, after] = selectedPdfs();
    await user.upload(container.querySelector('#before-file') as HTMLInputElement, before);
    await user.upload(container.querySelector('#after-file') as HTMLInputElement, after);
    await user.click(screen.getByRole('button', { name: /Compare PDFs/ }));

    await screen.findByText('Rendering pages, 50%');
    expect(await screen.findByRole('heading', { name: 'What changed in the text' })).toBeTruthy();
    expect(ControlledWorker.latest?.request?.before.name).toBe('original.pdf');
    expect(ControlledWorker.latest?.request?.after.name).toBe('revised.pdf');
    expect(ControlledWorker.latest?.transfer).toHaveLength(2);
    expect(container.querySelector('del')?.textContent).toContain('old headline');
    expect(container.querySelector('ins')?.textContent).toContain('new headline');

    await user.click(screen.getByRole('button', { name: /Next change/ }));
    expect(screen.getByRole('heading', { name: 'No matching page Page 2' })).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Save HTML' }));
    await waitFor(() => expect(saveReport).toHaveBeenCalledOnce());
    expect(saveReport.mock.calls[0][0]).toMatchObject({ format: 'html' });
    expect(saveReport.mock.calls[0][0].content).toContain('<!doctype html>');
  });

  it('terminates the active comparison worker when the user cancels', async () => {
    ControlledWorker.respond = false;
    const user = userEvent.setup();
    const { container } = render(<App />);
    const [before, after] = selectedPdfs();
    await user.upload(container.querySelector('#before-file') as HTMLInputElement, before);
    await user.upload(container.querySelector('#after-file') as HTMLInputElement, after);
    await user.click(screen.getByRole('button', { name: /Compare PDFs/ }));
    await waitFor(() => expect(ControlledWorker.latest).not.toBeNull());

    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(ControlledWorker.latest?.terminated).toBe(true);
    expect(screen.getByText('Comparison cancelled. No result was produced.')).toBeTruthy();
  });

  it('ignores a queued result after a selected file changes', async () => {
    ControlledWorker.respond = false;
    const user = userEvent.setup();
    const { container } = render(<App />);
    const [before, after] = selectedPdfs();
    const afterInput = container.querySelector('#after-file') as HTMLInputElement;
    await user.upload(container.querySelector('#before-file') as HTMLInputElement, before);
    await user.upload(afterInput, after);
    await user.click(screen.getByRole('button', { name: /Compare PDFs/ }));
    await waitFor(() => expect(ControlledWorker.latest?.request).not.toBeNull());
    const oldWorker = ControlledWorker.latest!;

    await user.upload(afterInput, new File(['new input'], 'revised-again.pdf', { type: 'application/pdf' }));
    expect(oldWorker.terminated).toBe(true);
    oldWorker.onmessage?.({ data: { type: 'complete', result: makeResult() } } as MessageEvent);
    expect(screen.queryByRole('heading', { name: 'What changed in the text' })).toBeNull();
    expect(screen.getByRole('heading', { name: 'See what changed, page by page.' })).toBeTruthy();
  });

  it('fails clearly on a worker envelope that is not the exact ready handshake or a typed result', async () => {
    ControlledWorker.initialEnvelope = { sourceName: 'worker', targetName: 'main', action: 'ready', data: new Uint8Array([1]) };
    const user = userEvent.setup();
    const { container } = render(<App />);
    const [before, after] = selectedPdfs();
    await user.upload(container.querySelector('#before-file') as HTMLInputElement, before);
    await user.upload(container.querySelector('#after-file') as HTMLInputElement, after);
    await user.click(screen.getByRole('button', { name: /Compare PDFs/ }));

    expect(await screen.findByText(/WORKER_FAILED/)).toBeTruthy();
    expect(screen.queryByRole('heading', { name: 'What changed in the text' })).toBeNull();
    expect(ControlledWorker.latest?.terminated).toBe(true);
  });

  it('terminates the worker and rejects late results after a message decode failure', async () => {
    ControlledWorker.respond = false;
    const user = userEvent.setup();
    const { container } = render(<App />);
    const [before, after] = selectedPdfs();
    await user.upload(container.querySelector('#before-file') as HTMLInputElement, before);
    await user.upload(container.querySelector('#after-file') as HTMLInputElement, after);
    await user.click(screen.getByRole('button', { name: /Compare PDFs/ }));
    await waitFor(() => expect(ControlledWorker.latest?.onmessageerror).not.toBeNull());
    const worker = ControlledWorker.latest!;

    worker.onmessageerror?.({ data: undefined } as MessageEvent);
    expect(worker.terminated).toBe(true);
    expect(await screen.findByText(/WORKER_FAILED/)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Save HTML' }).hasAttribute('disabled')).toBe(true);

    worker.onmessage?.({ data: { type: 'complete', result: makeResult() } } as MessageEvent);
    expect(screen.queryByRole('heading', { name: 'What changed in the text' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Save HTML' }).hasAttribute('disabled')).toBe(true);
  });
});
