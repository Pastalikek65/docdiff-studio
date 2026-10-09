import { compareDocuments, CompareError } from '../core/index.js';
import type { CompareOptions } from '../core/types.js';
import type { WorkerResponse } from './worker-messages.js';

type WorkerRequest = {
  type: 'compare';
  before: { name: string; bytes: ArrayBuffer };
  after: { name: string; bytes: ArrayBuffer };
  options: CompareOptions;
};

const workerScope = self as DedicatedWorkerGlobalScope;

workerScope.onmessage = async (event: MessageEvent<WorkerRequest>) => {
  const request = event.data;
  if (!request || request.type !== 'compare') return;

  try {
    const result = await compareDocuments(
      { name: request.before.name, bytes: new Uint8Array(request.before.bytes) },
      { name: request.after.name, bytes: new Uint8Array(request.after.bytes) },
      request.options,
      (progress) => workerScope.postMessage({ type: 'progress', progress } satisfies WorkerResponse),
    );
    workerScope.postMessage({ type: 'complete', result } satisfies WorkerResponse);
  } catch (error) {
    if (error instanceof CompareError) {
      workerScope.postMessage({ type: 'error', code: error.code, message: error.message } satisfies WorkerResponse);
    } else {
      workerScope.postMessage({
        type: 'error',
        code: 'COMPARE_FAILED',
        message: 'The documents could not be compared. No result was produced.',
      } satisfies WorkerResponse);
    }
  }
};
