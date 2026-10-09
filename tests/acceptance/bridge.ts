import { renderHtmlReport, serializeReport } from '../../src/core/report.js';
import type { CompareOptions, ComparisonResult, CompareProgress } from '../../src/core/types.js';

type FixtureRequest = {
  beforeFile: string;
  afterFile: string;
  beforeName?: string;
  afterName?: string;
  padBeforeBytes?: number;
  options?: Partial<CompareOptions>;
};

type WorkerResponse =
  | { type: 'progress'; progress: CompareProgress }
  | { type: 'complete'; result: ComparisonResult }
  | { type: 'error'; code: string; message: string }
  | { sourceName: 'worker'; targetName: 'main'; action: 'ready'; data: Record<string, never> };

type PublicComparison = {
  documents: ComparisonResult['documents'];
  outcome: ComparisonResult['outcome'];
  summary: ComparisonResult['summary'];
  warnings: string[];
  rows: Array<{
    status: ComparisonResult['rows'][number]['status'];
    beforePage: number | null;
    afterPage: number | null;
    beforeText: string;
    afterText: string;
    changes: ComparisonResult['rows'][number]['changes'];
    visual?: { changedPixels: number; totalPixels: number; ratio: number; hasDiffImage: boolean };
    hasBeforeImage: boolean;
    hasAfterImage: boolean;
  }>;
};

type Finished = {
  state: 'complete' | 'error' | 'terminated';
  result?: PublicComparison;
  error?: { code: string; message: string };
  progress: CompareProgress[];
  report?: {
    html: string;
    json: string;
    containsOriginalPdfBase64: boolean;
    rawNameAppearsInHtml: boolean;
    activeElementCount: number;
    eventHandlerAttributeCount: number;
  };
};

type Job = {
  id: string;
  worker?: Worker;
  state: 'loading' | 'running' | 'complete' | 'error' | 'terminated';
  progress: CompareProgress[];
  promise: Promise<Finished>;
  resolve: (finished: Finished) => void;
  beforeName: string;
  beforeBase64?: string;
};

declare global {
  interface Window {
    docdiffAcceptance: {
      start: (request: FixtureRequest) => Promise<string>;
      compare: (request: FixtureRequest) => Promise<Finished>;
      state: (id: string) => { state: Job['state']; progress: CompareProgress[] } | undefined;
      terminate: (id: string) => Finished | undefined;
    };
  }
}

const jobs = new Map<string, Job>();
const defaultOptions: CompareOptions = {
  ignoreWhitespace: false,
  ignoreHeaderLines: 0,
  ignoreFooterLines: 0,
  visualThreshold: 24,
};

async function loadFixture(filename: string, overrideName: string | undefined, padBytes = 0): Promise<{ name: string; bytes: Uint8Array }> {
  const response = await fetch(`/examples/corpus/${encodeURIComponent(filename)}`);
  if (!response.ok) throw new Error(`Could not load local fixture (${response.status}).`);
  const source = new Uint8Array(await response.arrayBuffer());
  if (padBytes > 0) {
    const padded = new Uint8Array(source.length + padBytes);
    padded.set(source);
    return { name: overrideName ?? filename, bytes: padded };
  }
  return { name: overrideName ?? filename, bytes: source };
}

function publicResult(result: ComparisonResult): PublicComparison {
  return {
    documents: result.documents,
    outcome: result.outcome,
    summary: result.summary,
    warnings: result.warnings,
    rows: result.rows.map((row) => ({
      status: row.status,
      beforePage: row.beforePage,
      afterPage: row.afterPage,
      beforeText: row.beforeText,
      afterText: row.afterText,
      changes: row.changes,
      visual: row.visual ? {
        changedPixels: row.visual.changedPixels,
        totalPixels: row.visual.totalPixels,
        ratio: row.visual.ratio,
        hasDiffImage: Boolean(row.visual.diffImageDataUrl),
      } : undefined,
      hasBeforeImage: Boolean(row.beforeImageDataUrl),
      hasAfterImage: Boolean(row.afterImageDataUrl),
    })),
  };
}

function htmlAudit(html: string, json: string, rawName: string, sourceBase64?: string) {
  const parsed = new DOMParser().parseFromString(html, 'text/html');
  const activeNodes = parsed.querySelectorAll('script, iframe, object, embed, svg, math');
  const eventAttributes = parsed.querySelectorAll('*');
  let eventHandlerAttributeCount = 0;
  for (const element of eventAttributes) {
    for (const attribute of element.attributes) {
      if (/^on/iu.test(attribute.name)) eventHandlerAttributeCount += 1;
    }
  }
  return {
    html,
    containsOriginalPdfBase64: Boolean(sourceBase64 && (html.includes(sourceBase64) || json.includes(sourceBase64))),
    rawNameAppearsInHtml: rawName.length > 0 && html.includes(rawName),
    activeElementCount: activeNodes.length,
    eventHandlerAttributeCount,
  };
}

async function start(request: FixtureRequest): Promise<string> {
  const id = crypto.randomUUID();
  let resolve!: (finished: Finished) => void;
  const promise = new Promise<Finished>((done) => { resolve = done; });
  const job: Job = {
    id,
    state: 'loading',
    progress: [],
    promise,
    resolve,
    beforeName: request.beforeName ?? request.beforeFile,
  };
  jobs.set(id, job);

  try {
    const [before, after] = await Promise.all([
      loadFixture(request.beforeFile, request.beforeName, request.padBeforeBytes),
      loadFixture(request.afterFile, request.afterName),
    ]);
    if (before.bytes.length <= 64 * 1024) {
      let binary = '';
      for (let offset = 0; offset < before.bytes.length; offset += 0x8000) {
        binary += String.fromCharCode(...before.bytes.subarray(offset, Math.min(offset + 0x8000, before.bytes.length)));
      }
      job.beforeBase64 = btoa(binary);
    }
    const worker = new Worker(new URL('../../src/renderer/compare.worker.ts', import.meta.url), { type: 'module' });
    job.worker = worker;
    job.state = 'running';
    worker.onmessage = (event: MessageEvent<WorkerResponse>) => {
      const response = event.data;
      if ('action' in response) {
        if (response.action === 'ready') return;
        job.worker?.terminate();
        job.state = 'error';
        job.resolve({ state: 'error', error: { code: 'WORKER_PROTOCOL_ERROR', message: 'The comparison worker sent an unexpected control message.' }, progress: [...job.progress] });
        return;
      }
      if (response.type === 'progress') {
        job.progress.push(response.progress);
        return;
      }
      worker.terminate();
      if (response.type === 'error') {
        job.state = 'error';
        job.resolve({ state: 'error', error: { code: response.code, message: response.message }, progress: [...job.progress] });
        return;
      }
      if (response.type !== 'complete') {
        job.state = 'error';
        job.resolve({ state: 'error', error: { code: 'WORKER_PROTOCOL_ERROR', message: 'The comparison worker returned an unknown response.' }, progress: [...job.progress] });
        return;
      }
      job.state = 'complete';
      try {
        const html = renderHtmlReport(response.result);
        const json = serializeReport(response.result);
        const report = htmlAudit(html, json, job.beforeName, job.beforeBase64);
        job.resolve({
          state: 'complete',
          result: publicResult(response.result),
          progress: [...job.progress],
          report: { ...report, json },
        });
      } catch (error) {
        job.state = 'error';
        const candidate = error as Error;
        const result = response.result as unknown as Record<string, unknown>;
        job.resolve({
          state: 'error',
          error: {
            code: 'REPORT_FAILURE',
            message: `${candidate.message}; result keys=${Object.keys(result ?? {}).join(',')}; schema=${String(result?.schemaVersion)}; rowsArray=${String(Array.isArray(result?.rows))}`,
          },
          progress: [...job.progress],
        });
      }
    };
    worker.onerror = (event) => {
      event.preventDefault();
      worker.terminate();
      job.state = 'error';
      job.resolve({ state: 'error', error: { code: 'WORKER_FAILED', message: event.message }, progress: [...job.progress] });
    };
    worker.postMessage({
      type: 'compare',
      before: { name: before.name, bytes: before.bytes.buffer },
      after: { name: after.name, bytes: after.bytes.buffer },
      options: { ...defaultOptions, ...request.options },
    }, [before.bytes.buffer, after.bytes.buffer]);
  } catch (error) {
    job.state = 'error';
    job.resolve({ state: 'error', error: { code: 'HARNESS_FAILED', message: error instanceof Error ? error.message : String(error) }, progress: [...job.progress] });
  }
  return id;
}

window.docdiffAcceptance = {
  start,
  async compare(request) {
    const id = await start(request);
    return jobs.get(id)!.promise;
  },
  state(id) {
    const job = jobs.get(id);
    return job ? { state: job.state, progress: [...job.progress] } : undefined;
  },
  terminate(id) {
    const job = jobs.get(id);
    if (!job || job.state !== 'running') return undefined;
    job.worker?.terminate();
    job.state = 'terminated';
    const finished: Finished = { state: 'terminated', progress: [...job.progress] };
    job.resolve(finished);
    return finished;
  },
};
