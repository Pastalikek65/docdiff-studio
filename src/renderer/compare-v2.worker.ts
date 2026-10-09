import { compareDocumentsV2, CompareError } from '../core/index.js';
import type { CompareOptionsV2, DocumentInputV2, CompareRequestV2 } from '../core/types.js';
import { createPortOcrRuntime } from './ocr-port-runtime.js';
import type { WorkerResponseV2 } from './worker-messages.js';

export type CompareWorkerRequestV2 = {
  type: 'compare-v2';
  before: { format: DocumentInputV2['format']; name: string; bytes: ArrayBuffer };
  after: { format: DocumentInputV2['format']; name: string; bytes: ArrayBuffer };
  options: CompareOptionsV2;
  ocrPort?: MessagePort;
};

const workerScope = self as DedicatedWorkerGlobalScope;

workerScope.onmessage = async (event: MessageEvent<CompareWorkerRequestV2>) => {
  const message = event.data;
  if (!message || message.type !== 'compare-v2' ||
    !(message.before.bytes instanceof ArrayBuffer) || !(message.after.bytes instanceof ArrayBuffer)) return;

  const request: CompareRequestV2 = {
    schemaVersion: 2,
    before: { format: message.before.format, name: message.before.name, bytes: new Uint8Array(message.before.bytes) },
    after: { format: message.after.format, name: message.after.name, bytes: new Uint8Array(message.after.bytes) },
    options: message.options,
  };
  const ocrRuntime = message.ocrPort ? createPortOcrRuntime(message.ocrPort) : undefined;

  try {
    const result = await compareDocumentsV2(
      request,
      (progress) => workerScope.postMessage({ type: 'progress', progress } satisfies WorkerResponseV2),
      ocrRuntime,
    );
    workerScope.postMessage({ type: 'complete', result } satisfies WorkerResponseV2);
  } catch (error) {
    if (error instanceof CompareError) {
      workerScope.postMessage({ type: 'error', code: error.code, message: error.message } satisfies WorkerResponseV2);
    } else if (error instanceof Error && error.name === 'AbortError') {
      workerScope.postMessage({ type: 'error', code: 'CANCELLED', message: 'Comparison cancelled. No result was produced.' } satisfies WorkerResponseV2);
    } else {
      workerScope.postMessage({
        type: 'error', code: 'WORKER_FAILED',
        message: 'The documents could not be compared. No result was produced.',
      } satisfies WorkerResponseV2);
    }
  }
};
