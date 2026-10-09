import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { createWorkerMock } = vi.hoisted(() => ({ createWorkerMock: vi.fn() }));

vi.mock('tesseract.js', () => ({
  createWorker: createWorkerMock,
  OEM: { LSTM_ONLY: 1 },
}));

import { attachOcrHost } from '../../src/renderer/ocr-host.js';

class CapturedTestWorker {
  static instances: CapturedTestWorker[] = [];
  terminated = false;

  constructor(_scriptUrl: string | URL, _options?: WorkerOptions) {
    CapturedTestWorker.instances.push(this);
  }

  terminate() { this.terminated = true; }
}

type TestPort = MessagePort & {
  messages: unknown[];
  receive: (data: unknown) => void;
};

function makePort(): TestPort {
  const port = {
    onmessage: null as ((event: MessageEvent<unknown>) => void) | null,
    messages: [] as unknown[],
    postMessage(message: unknown) { this.messages.push(message); },
    start() {},
    close() {},
    receive(data: unknown) { this.onmessage?.({ data } as MessageEvent<unknown>); },
  };
  return port as unknown as TestPort;
}

function recognize(requestId: number) {
  return {
    type: 'recognize',
    requestId,
    request: { side: 'before', pageIndex: requestId - 1, image: new Blob(['bounded image'], { type: 'image/png' }) },
  };
}

beforeEach(() => {
  CapturedTestWorker.instances = [];
  createWorkerMock.mockReset();
  vi.stubGlobal('Worker', CapturedTestWorker as unknown as typeof Worker);
  vi.stubGlobal('window', { location: { href: 'docdiff://app/index.html' } });
});

afterEach(() => vi.unstubAllGlobals());

describe('renderer OCR host startup failures', () => {
  it('rejects every pending page request and terminates the child when Tesseract reports a model-load error', async () => {
    let reportWorkerError: ((error: unknown) => void) | undefined;
    createWorkerMock.mockImplementation((_languages: unknown, _oem: unknown, options: { errorHandler?: (error: unknown) => void }) => {
      // Tesseract 7 creates its child synchronously, then may leave its
      // createWorker promise pending after a rejected loadLanguage job.
      new Worker('mock-local-tesseract-worker.js');
      reportWorkerError = options.errorHandler;
      return new Promise(() => undefined);
    });

    const port = makePort();
    const detach = attachOcrHost(port, () => undefined);
    port.receive(recognize(1));
    port.receive(recognize(2));
    await vi.waitFor(() => expect(createWorkerMock).toHaveBeenCalledOnce());
    expect(CapturedTestWorker.instances).toHaveLength(1);

    reportWorkerError?.(new Error('Network error while fetching local eng.traineddata. Response code: 404'));
    await vi.waitFor(() => expect(port.messages.filter((message) => (
      !!message && typeof message === 'object' && (message as { type?: unknown }).type === 'recognition-error'
    ))).toHaveLength(2));

    const failures = port.messages.filter((message) => (
      !!message && typeof message === 'object' && (message as { type?: unknown }).type === 'recognition-error'
    )) as Array<{ requestId: number; message: string }>;
    expect(failures.map((message) => message.requestId).sort()).toEqual([1, 2]);
    expect(failures.every((message) => message.message === 'Local English OCR could not read this selected page.')).toBe(true);
    expect(CapturedTestWorker.instances[0].terminated).toBe(true);
    detach();
  });
});
