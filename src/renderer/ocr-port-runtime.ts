import type { OcrPageRequestV2, OcrPageResultV2, OcrProgressV2, OcrRuntimeV2 } from '../core/types.js';

type PendingRequest = {
  resolve: (result: OcrPageResultV2) => void;
  reject: (error: Error) => void;
  onProgress?: (progress: OcrProgressV2) => void;
};

function abortError(message = 'OCR was cancelled.'): Error {
  const error = new Error(message);
  error.name = 'AbortError';
  return error;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

/** A comparison-worker adapter whose OCR implementation remains on the renderer side. */
export function createPortOcrRuntime(port: MessagePort): OcrRuntimeV2 {
  let nextId = 0;
  let terminated = false;
  let termination: Promise<void> | null = null;
  const pending = new Map<number, PendingRequest>();
  let resolveTermination: (() => void) | null = null;
  const terminationAck = new Promise<void>((resolve) => { resolveTermination = resolve; });

  const failPending = (error: Error) => {
    for (const request of pending.values()) request.reject(error);
    pending.clear();
  };

  port.onmessage = (event: MessageEvent<unknown>) => {
    const message = event.data;
    if (!isRecord(message) || typeof message.type !== 'string') return;
    if (message.type === 'terminated') {
      resolveTermination?.();
      return;
    }
    if (!Number.isSafeInteger(message.requestId)) return;
    const requestId = message.requestId as number;
    const request = pending.get(requestId);
    if (!request) return;
    if (message.type === 'recognition-progress') {
      const progress = message.progress;
      if (!isRecord(progress) || typeof progress.phase !== 'string' || typeof progress.progress !== 'number' || !Number.isFinite(progress.progress)) return;
      request.onProgress?.({ phase: progress.phase.slice(0, 120), progress: Math.max(0, Math.min(1, progress.progress)) });
      return;
    }
    pending.delete(requestId);
    if (message.type === 'recognition-result' && isRecord(message.result) && typeof message.result.text === 'string') {
      const confidence = message.result.confidence;
      request.resolve({
        text: message.result.text,
        ...(typeof confidence === 'number' && Number.isFinite(confidence) ? { confidence } : {}),
      });
    } else if (message.type === 'recognition-error') {
      const safeMessage = typeof message.message === 'string' ? message.message.slice(0, 180) : 'Local OCR failed.';
      request.reject(safeMessage.toLowerCase().includes('cancel')
        ? abortError(safeMessage)
        : new Error(safeMessage));
    }
  };
  port.start();

  return {
    recognizePage(request: OcrPageRequestV2, onProgress?: (progress: OcrProgressV2) => void) {
      if (terminated) return Promise.reject(abortError());
      const requestId = ++nextId;
      return new Promise<OcrPageResultV2>((resolve, reject) => {
        pending.set(requestId, { resolve, reject, onProgress });
        try {
          port.postMessage({ type: 'recognize', requestId, request });
        } catch {
          pending.delete(requestId);
          reject(new Error('The local OCR request could not be sent.'));
        }
      });
    },
    terminate() {
      if (termination) return termination;
      terminated = true;
      failPending(abortError());
      termination = new Promise<void>((resolve) => {
        const timeout = setTimeout(resolve, 1_500);
        void terminationAck.then(() => { clearTimeout(timeout); resolve(); });
      }).finally(() => {
        port.onmessage = null;
        port.close();
      });
      try { port.postMessage({ type: 'terminate' }); } catch { resolveTermination?.(); }
      return termination;
    },
  };
}
