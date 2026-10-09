import { createWorker, OEM } from 'tesseract.js';
import type { OcrPageRequestV2, OcrPageResultV2, OcrProgressV2 } from '../core/types.js';

type Recognizer = {
  recognize: (
    image: Blob,
    options?: Record<string, unknown>,
    output?: { text?: boolean },
    jobId?: string,
  ) => Promise<{ data: { text: string; confidence: number } }>;
  terminate: () => void | Promise<unknown>;
};

type CapturedRecognizer = {
  ready: Promise<Recognizer>;
  terminateChild: () => void;
};

type OcrLoggerMessage = { userJobId?: string; progress?: number };
export type OcrHostProgress = (requestId: number, progress: OcrProgressV2) => void;

const MAX_OCR_IMAGE_BYTES = 12 * 1024 * 1024;

function abortError(): Error {
  const error = new Error('OCR was cancelled.');
  error.name = 'AbortError';
  return error;
}

function localAsset(path: string): string {
  return new URL(path, window.location.href).toString();
}

/**
 * Start the pinned, locally vendored Tesseract runtime. Tesseract's public
 * createWorker promise does not expose its Worker until initialization ends,
 * so capture the one Worker synchronously while createWorker constructs it.
 * This lets cancellation stop language/model loading as well as recognition.
 */
function createCapturedRecognizer(onLog: (message: OcrLoggerMessage) => void): CapturedRecognizer {
  let child: Worker | null = null;
  const NativeWorker = globalThis.Worker;
  class CapturingWorker extends NativeWorker {
    constructor(scriptURL: string | URL, options?: WorkerOptions) {
      super(scriptURL, options);
      child = this;
    }
  }
  const terminateChild = () => {
    // TypeScript cannot see constructor side effects from `createWorker`.
    const capturedChild = child as Worker | null;
    if (capturedChild) capturedChild.terminate();
  };

  let ready: Promise<Recognizer>;
  try {
    globalThis.Worker = CapturingWorker;
    try {
      ready = new Promise<Recognizer>((resolve, reject) => {
        let startupSettled = false;
        let startupFailed = false;
        const rejectStartup = () => {
          if (startupSettled) return;
          startupSettled = true;
          startupFailed = true;
          reject(new Error('Local English OCR could not start.'));
        };
        const resolveStartup = (instance: Recognizer) => {
          if (startupFailed) {
            // A late createWorker resolution must not resurrect a worker after
            // its initialization error has already failed the OCR request.
            try { terminateChild(); } catch { /* Preserve the initialization failure. */ }
            void Promise.resolve(instance.terminate()).catch(() => undefined);
            return;
          }
          if (startupSettled) return;
          startupSettled = true;
          resolve(instance);
        };

        let nativeReady: Promise<unknown>;
        try {
          nativeReady = createWorker('eng', OEM.LSTM_ONLY, {
            workerPath: localAsset('./vendor/ocr/worker.min.js'),
            corePath: localAsset('./vendor/ocr/core/'),
            langPath: localAsset('./vendor/ocr/lang/'),
            workerBlobURL: false,
            cacheMethod: 'none',
            gzip: false,
            logger: onLog,
            // Tesseract 7 calls errorHandler for a rejected loadLanguage job,
            // but its createWorker readiness promise can remain pending: its
            // internal catch only rejects workerRes for the initial `load`
            // action. Race the initialization callback into our own promise.
            errorHandler: () => rejectStartup(),
          }) as unknown as Promise<unknown>;
        } catch {
          rejectStartup();
          try { terminateChild(); } catch { /* Preserve the setup failure. */ }
          return;
        }
        void Promise.resolve(nativeReady).then(
          (instance) => resolveStartup(instance as Recognizer),
          () => rejectStartup(),
        );
      });
    } catch (error) {
      // A synchronous setup failure can occur after Tesseract has constructed
      // its worker. Do not leave that worker alive when no recognizer handle
      // will be returned to the caller.
      try { terminateChild(); } catch { /* Preserve the setup error. */ }
      throw error;
    }
  } finally {
    globalThis.Worker = NativeWorker;
  }

  return {
    ready,
    terminateChild,
  };
}

/**
 * Main-renderer OCR host. The comparison worker talks to this host through a
 * MessagePort; this side owns and explicitly terminates the actual Tesseract
 * Web Worker so terminating the comparison worker cannot orphan OCR work.
 */
export function attachOcrHost(port: MessagePort, onProgress: OcrHostProgress): () => void {
  let terminated = false;
  let recognizer: CapturedRecognizer | null = null;
  let instance: Recognizer | null = null;
  let initPromise: Promise<Recognizer> | null = null;
  const pending = new Map<number, (error: Error) => void>();
  let rejectStopped: ((error: Error) => void) | null = null;
  const stopped = new Promise<never>((_resolve, reject) => { rejectStopped = reject; });
  // If initialization or recognition fails before a consumer awaits `stopped`,
  // this handler prevents an unhandled rejection; Promise.race still receives it.
  void stopped.catch(() => undefined);

  const terminateHost = () => {
    if (terminated) return;
    terminated = true;
    rejectStopped?.(abortError());
    recognizer?.terminateChild();
    if (instance) void Promise.resolve(instance.terminate()).catch(() => undefined);
    for (const reject of pending.values()) reject(abortError());
    pending.clear();
  };

  const ensureRecognizer = (): Promise<Recognizer> => {
    if (terminated) return Promise.reject(abortError());
    if (!initPromise) {
      const current = createCapturedRecognizer((message) => {
        if (terminated) return;
        const value = typeof message.progress === 'number' && Number.isFinite(message.progress)
          ? Math.max(0, Math.min(1, message.progress))
          : 0;
        for (const requestId of pending.keys()) {
          const progress = { phase: 'Loading local English OCR', progress: value };
          try { port.postMessage({ type: 'recognition-progress', requestId, progress }); } catch { /* Caller may be closing. */ }
          onProgress(requestId, progress);
        }
      });
      recognizer = current;
      initPromise = current.ready.then((readyInstance) => {
        instance = readyInstance;
        if (terminated) {
          current.terminateChild();
          void Promise.resolve(readyInstance.terminate()).catch(() => undefined);
          throw abortError();
        }
        return readyInstance;
      }, (error: unknown) => {
        // Failed language/model loading leaves no public recognizer handle.
        // Terminate the captured child directly before reporting the failure.
        current.terminateChild();
        throw error;
      });
      // The consumer uses a stopped race. Observe late init failure after cancel.
      void initPromise.catch(() => undefined);
    }
    return Promise.race([initPromise, stopped]);
  };

  const send = (message: unknown) => {
    if (!terminated) port.postMessage(message);
  };

  port.onmessage = (event: MessageEvent<unknown>) => {
    const message = event.data as Record<string, unknown> | null;
    if (!message || typeof message !== 'object') return;
    if (message.type === 'terminate') {
      terminateHost();
      try { port.postMessage({ type: 'terminated' }); } catch { /* Port may have closed. */ }
      return;
    }
    if (message.type !== 'recognize' || typeof message.requestId !== 'number' || !Number.isSafeInteger(message.requestId) || message.requestId < 1) return;
    const requestId = message.requestId;
    const request = message.request as OcrPageRequestV2 | undefined;
    if (!request || (request.side !== 'before' && request.side !== 'after') ||
      !Number.isSafeInteger(request.pageIndex) || request.pageIndex < 0 ||
      !(request.image instanceof Blob) || request.image.size <= 0 || request.image.size > MAX_OCR_IMAGE_BYTES) {
      send({ type: 'recognition-error', requestId, message: 'OCR could not read this selected page image.' });
      return;
    }
    if (pending.has(requestId) || terminated) return;

    const recognition = new Promise<void>((resolve, reject) => {
      pending.set(requestId, reject);
      void (async () => {
        try {
          const worker = await ensureRecognizer();
          const jobId = `docdiff-${requestId}`;
          const result = await worker.recognize(request.image, {}, { text: true }, jobId);
          if (terminated) throw abortError();
          const text = typeof result.data?.text === 'string' ? result.data.text : '';
          const confidence = typeof result.data?.confidence === 'number' && Number.isFinite(result.data.confidence)
            ? Math.max(0, Math.min(100, result.data.confidence))
            : undefined;
          send({ type: 'recognition-result', requestId, result: { text, confidence } satisfies OcrPageResultV2 });
          resolve();
        } catch (error) {
          if (!terminated) {
            send({
              type: 'recognition-error', requestId,
              message: error instanceof Error && error.name === 'AbortError'
                ? 'OCR was cancelled.'
                : 'Local English OCR could not read this selected page.',
            });
          }
          reject(error instanceof Error ? error : new Error('OCR failed.'));
        } finally {
          pending.delete(requestId);
        }
      })();
    });
    // A rejection handler is attached because the worker side receives the
    // error over the port; this promise only tracks in-flight local work.
    void recognition.catch(() => undefined);
  };

  port.start();
  return () => {
    terminateHost();
    port.onmessage = null;
    port.close();
  };
}
