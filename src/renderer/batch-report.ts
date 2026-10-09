import { serializeReportV2 } from '../core/index.js';
import type { ComparisonResultV2 } from '../core/types.js';

export type BatchJobStatus = 'succeeded' | 'failed' | 'cancelled' | 'not-run';

export type BatchJob = {
  id: string;
  status: BatchJobStatus;
  beforeName: string;
  afterName: string;
  result?: ComparisonResultV2;
  error?: { code: string; message: string };
};

export const MAX_BATCH_REPORT_BYTES = 64 * 1024 * 1024;
export const MAX_BATCH_REPORT_JOBS = 20;

function safeName(value: string): string {
  const leaf = value.replace(/\\/gu, '/').split('/').pop() ?? '';
  return leaf.replace(/[\u0000-\u001f\u007f]/gu, '_').trim().slice(0, 120) || 'Untitled document';
}

function safeError(error: BatchJob['error']): { code: string; message: string } | undefined {
  if (error === undefined) return undefined;
  if (!error || typeof error !== 'object' || typeof error.code !== 'string' || typeof error.message !== 'string') {
    return undefined;
  }
  return {
    code: /^[A-Z0-9_]{1,64}$/u.test(error.code) ? error.code : 'COMPARE_FAILED',
    message: error.message.replace(/[\u0000-\u001f\u007f]/gu, ' ').slice(0, 240),
  };
}

/** Serialize the whole attempted batch without exposing source bytes or path fields. */
export function serializeBatchReport(jobs: BatchJob[]): string {
  if (!Array.isArray(jobs) || jobs.length === 0 || jobs.length > MAX_BATCH_REPORT_JOBS) {
    throw invalidBatchState();
  }
  const ids = new Set<string>();
  const projectedJobs = jobs.map((job) => {
    if (!job || typeof job !== 'object'
      || !['succeeded', 'failed', 'cancelled', 'not-run'].includes(job.status)
      || typeof job.id !== 'string' || !/^pair-\d{1,6}$/u.test(job.id)
      || typeof job.beforeName !== 'string' || typeof job.afterName !== 'string') {
      throw invalidBatchState();
    }
    const base = {
      id: job.id,
      status: job.status,
      beforeName: safeName(job.beforeName),
      afterName: safeName(job.afterName),
    };
    if (ids.has(base.id)) throw invalidBatchState();
    ids.add(base.id);
    if (job.status === 'succeeded') {
      if (!job.result || job.error !== undefined) throw invalidBatchState();
      return { ...base, result: JSON.parse(serializeReportV2(job.result)) as unknown };
    }
    if (job.result !== undefined) throw invalidBatchState();
    const error = safeError(job.error);
    if ((job.error !== undefined && !error) || (job.status === 'failed' && !error)
      || (job.status === 'not-run' && error)) throw invalidBatchState();
    return error ? { ...base, error } : base;
  });
  const summary = {
    succeeded: jobs.filter((job) => job.status === 'succeeded').length,
    failed: jobs.filter((job) => job.status === 'failed').length,
    cancelled: jobs.filter((job) => job.status === 'cancelled').length,
    notRun: jobs.filter((job) => job.status === 'not-run').length,
  };
  return JSON.stringify({ schemaVersion: 2, reportKind: 'batch', jobs: projectedJobs, summary }, null, 2);
}

export function batchReportFits(content: string, limit = MAX_BATCH_REPORT_BYTES): boolean {
  return new TextEncoder().encode(content).byteLength <= limit;
}

function invalidBatchState(): Error {
  return new Error('The batch report state is inconsistent. Compare the pairs again before exporting.');
}
