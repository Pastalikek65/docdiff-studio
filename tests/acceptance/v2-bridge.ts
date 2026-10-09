import { renderHtmlReportV2, serializeReportV2 } from '../../src/core/report-v2.js';
import { DEFAULT_COMPARE_OPTIONS_V2 } from '../../src/core/limits.js';
import type { CompareOptionsV2, CompareProgress, ComparisonResultV2, SourceFormatV2 } from '../../src/core/types.js';
import { attachOcrHost } from '../../src/renderer/ocr-host.js';
import { isReadyHandshake } from '../../src/renderer/worker-messages.js';

history.replaceState(null, '', '/__docdiff_v2_acceptance__.html');

type FixtureRequest = {
  format: SourceFormatV2;
  beforeFormat?: SourceFormatV2;
  afterFormat?: SourceFormatV2;
  beforeFile: string;
  afterFile: string;
  beforeBytesBase64?: string;
  afterBytesBase64?: string;
  beforeName?: string;
  afterName?: string;
  options?: Partial<CompareOptionsV2>;
};

type V2Response =
  | { type: 'progress'; progress: CompareProgress }
  | { type: 'ocr-progress'; progress: { phase: string; progress: number } }
  | { type: 'complete'; result: ComparisonResultV2 }
  | { type: 'error'; code: string; message: string };

type BrowserResult = {
  state: 'complete' | 'error' | 'terminated';
  error?: { code: string; message: string };
  progress: CompareProgress[];
  ocrProgress: Array<{ phase: string; progress: number }>;
  workerTerminationCounts: number[];
  result?: ComparisonResultV2;
  beforeSourceSha256?: string;
  afterSourceSha256?: string;
  report?: {
    html: string;
    json: string;
    activeElementCount: number;
    eventHandlerAttributeCount: number;
    rawNameAppearsInHtml: boolean;
    inputBase64AppearsInReport: boolean;
    htmlTextContainsName: boolean;
  };
  trackedWorkersAtFinish?: number;
};

type TrackedWorker = Worker & { terminateCalls: number };
type Job = {
  id: string;
  state: 'loading' | 'running' | 'complete' | 'error' | 'terminated';
  progress: CompareProgress[];
  ocrProgress: Array<{ phase: string; progress: number }>;
  worker?: TrackedWorker;
  cleanupOcr?: () => void;
  promise: Promise<BrowserResult>;
  resolve: (result: BrowserResult) => void;
  beforeSourceSha256?: string;
  afterSourceSha256?: string;
  workerStartIndex: number;
};

declare global {
  interface Window {
    docdiffV2Acceptance: {
      compare(request: FixtureRequest): Promise<BrowserResult>;
      wait(id: string): Promise<BrowserResult> | undefined;
      start(request: FixtureRequest): Promise<string>;
      state(id: string): { state: Job['state']; progress: CompareProgress[]; ocrProgress: Job['ocrProgress']; trackedWorkers: number } | undefined;
      cancel(id: string): { state: 'terminated'; childWorkerTerminateCalls: number } | undefined;
    };
    __docdiffTrackedWorkers: TrackedWorker[];
  }
}

const NativeWorker = globalThis.Worker;
class TrackingWorker extends NativeWorker {
  terminateCalls = 0;

  constructor(scriptURL: string | URL, options?: WorkerOptions) {
    super(scriptURL, options);
    window.__docdiffTrackedWorkers.push(this as TrackedWorker);
  }

  override terminate(): void {
    this.terminateCalls += 1;
    super.terminate();
  }
}

window.__docdiffTrackedWorkers = [];
globalThis.Worker = TrackingWorker;

const jobs = new Map<string, Job>();

function hex(bytes: ArrayBuffer): string {
  return Array.from(new Uint8Array(bytes), (value) => value.toString(16).padStart(2, '0')).join('');
}

async function sha256(bytes: Uint8Array): Promise<string> {
  const copy = Uint8Array.from(bytes);
  return hex(await crypto.subtle.digest('SHA-256', copy.buffer));
}

function base64(bytes: Uint8Array): string {
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, Math.min(offset + 0x8000, bytes.length)));
  }
  return btoa(binary);
}

async function loadFixture(filename: string, name: string, providedBase64?: string): Promise<{ name: string; bytes: Uint8Array }> {
  if (providedBase64 !== undefined) {
    const binary = atob(providedBase64);
    const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
    return { name, bytes };
  }
  const response = await fetch(`/examples/v1/corpus/${encodeURIComponent(filename)}`);
  if (!response.ok) throw new Error(`Could not load local v1 fixture (${response.status}).`);
  return { name, bytes: new Uint8Array(await response.arrayBuffer()) };
}

function auditReport(html: string, json: string, name: string, sourceBase64: string[]): BrowserResult['report'] {
  const document = new DOMParser().parseFromString(html, 'text/html');
  let eventHandlerAttributeCount = 0;
  for (const element of document.querySelectorAll('*')) {
    for (const attribute of element.attributes) {
      if (/^on/iu.test(attribute.name)) eventHandlerAttributeCount += 1;
    }
  }
  const bodyText = document.body.textContent ?? '';
  return {
    html,
    json,
    activeElementCount: document.querySelectorAll('script,iframe,object,embed,svg,math').length,
    eventHandlerAttributeCount,
    rawNameAppearsInHtml: name.length > 0 && html.includes(name),
    inputBase64AppearsInReport: sourceBase64.some((encoded) => encoded.length > 64 && (html.includes(encoded) || json.includes(encoded))),
    htmlTextContainsName: bodyText.includes(name),
  };
}

function finish(job: Job, result: Omit<BrowserResult, 'progress' | 'ocrProgress' | 'workerTerminationCounts' | 'beforeSourceSha256' | 'afterSourceSha256'>): void {
  job.cleanupOcr?.();
  job.cleanupOcr = undefined;
  job.resolve({
    ...result,
    progress: [...job.progress],
    ocrProgress: [...job.ocrProgress],
    workerTerminationCounts: window.__docdiffTrackedWorkers.slice(job.workerStartIndex).map((worker) => worker.terminateCalls),
    beforeSourceSha256: job.beforeSourceSha256,
    afterSourceSha256: job.afterSourceSha256,
    trackedWorkersAtFinish: window.__docdiffTrackedWorkers.length,
  });
}

async function start(request: FixtureRequest): Promise<string> {
  const id = crypto.randomUUID();
  let resolve!: (result: BrowserResult) => void;
  const promise = new Promise<BrowserResult>((done) => { resolve = done; });
  const job: Job = {
    id, state: 'loading', progress: [], ocrProgress: [], promise, resolve,
    workerStartIndex: window.__docdiffTrackedWorkers.length,
  };
  jobs.set(id, job);

  try {
    const beforeName = request.beforeName ?? request.beforeFile;
    const afterName = request.afterName ?? request.afterFile;
    const [before, after] = await Promise.all([
      loadFixture(request.beforeFile, beforeName, request.beforeBytesBase64),
      loadFixture(request.afterFile, afterName, request.afterBytesBase64),
    ]);
    job.beforeSourceSha256 = await sha256(before.bytes);
    job.afterSourceSha256 = await sha256(after.bytes);
    const beforeBase64 = base64(before.bytes);
    const afterBase64 = base64(after.bytes);
    const comparisonWorker = new Worker(new URL('../../src/renderer/compare-v2.worker.ts', import.meta.url), { type: 'module' }) as TrackedWorker;
    job.worker = comparisonWorker;
    job.state = 'running';

    const channel = new MessageChannel();
    job.cleanupOcr = attachOcrHost(channel.port1, (_requestId, progress) => {
      job.ocrProgress.push(progress);
    });
    comparisonWorker.onmessage = (event: MessageEvent<V2Response>) => {
      const response = event.data;
      if (isReadyHandshake(response)) return;
      if (!response || typeof response !== 'object') {
        comparisonWorker.terminate();
        job.state = 'error';
        finish(job, { state: 'error', error: { code: 'WORKER_PROTOCOL_ERROR', message: 'The comparison worker sent an invalid response.' } });
        return;
      }
      if (response.type === 'progress') {
        job.progress.push(response.progress);
        return;
      }
      if (response.type === 'ocr-progress') {
        job.ocrProgress.push(response.progress);
        return;
      }
      comparisonWorker.terminate();
      if (response.type === 'error') {
        job.state = 'error';
        finish(job, { state: 'error', error: { code: response.code, message: response.message } });
        return;
      }
      if (response.type !== 'complete') {
        job.state = 'error';
        finish(job, { state: 'error', error: { code: 'WORKER_PROTOCOL_ERROR', message: `The comparison worker returned an unknown response: ${JSON.stringify(response).slice(0, 300)}` } });
        return;
      }
      job.state = 'complete';
      try {
        const html = renderHtmlReportV2(response.result);
        const json = serializeReportV2(response.result);
        const report = auditReport(html, json, beforeName, [beforeBase64, afterBase64]);
        finish(job, { state: 'complete', result: response.result, report });
      } catch (error) {
        job.state = 'error';
        finish(job, { state: 'error', error: { code: 'REPORT_FAILURE', message: error instanceof Error ? error.message : String(error) } });
      }
    };
    comparisonWorker.onerror = (event) => {
      event.preventDefault();
      comparisonWorker.terminate();
      job.state = 'error';
      finish(job, { state: 'error', error: { code: 'WORKER_FAILED', message: event.message } });
    };
    comparisonWorker.postMessage({
      type: 'compare-v2',
      before: { format: request.beforeFormat ?? request.format, name: before.name, bytes: before.bytes.buffer },
      after: { format: request.afterFormat ?? request.format, name: after.name, bytes: after.bytes.buffer },
      options: {
        ...DEFAULT_COMPARE_OPTIONS_V2,
        ...request.options,
        ocr: { ...DEFAULT_COMPARE_OPTIONS_V2.ocr, ...request.options?.ocr },
      } satisfies CompareOptionsV2,
      ocrPort: channel.port2,
    }, [before.bytes.buffer, after.bytes.buffer, channel.port2]);
  } catch (error) {
    job.state = 'error';
    finish(job, { state: 'error', error: { code: 'HARNESS_FAILED', message: error instanceof Error ? error.message : String(error) } });
  }
  return id;
}

window.docdiffV2Acceptance = {
  start,
  async compare(request) {
    const id = await start(request);
    return jobs.get(id)!.promise;
  },
  wait(id) {
    return jobs.get(id)?.promise;
  },
  state(id) {
    const job = jobs.get(id);
    return job ? {
      state: job.state,
      progress: [...job.progress],
      ocrProgress: [...job.ocrProgress],
      trackedWorkers: window.__docdiffTrackedWorkers.length,
    } : undefined;
  },
  cancel(id) {
    const job = jobs.get(id);
    if (!job || job.state !== 'running') return undefined;
    job.cleanupOcr?.();
    job.cleanupOcr = undefined;
    const childWorkerTerminateCalls = window.__docdiffTrackedWorkers.slice(job.workerStartIndex + 1)
      .reduce((sum, worker) => sum + worker.terminateCalls, 0);
    job.worker?.terminate();
    job.state = 'terminated';
    finish(job, { state: 'terminated', trackedWorkersAtFinish: window.__docdiffTrackedWorkers.length });
    return { state: 'terminated', childWorkerTerminateCalls };
  },
};
