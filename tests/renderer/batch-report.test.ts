import { describe, expect, it } from 'vitest';
import { DEFAULT_COMPARE_OPTIONS_V2 } from '../../src/core/index.js';
import type { ComparisonResultV2 } from '../../src/core/types.js';
import { MAX_BATCH_REPORT_JOBS, serializeBatchReport, type BatchJob } from '../../src/renderer/batch-report.js';

function emptyResult(): ComparisonResultV2 {
  return {
    schemaVersion: 2,
    documents: {
      before: { name: 'before.pdf', format: 'pdf', sha256: 'a'.repeat(64), unitKind: 'pdf-page', unitCount: 1, physicalPageCount: 1 },
      after: { name: 'after.pdf', format: 'pdf', sha256: 'b'.repeat(64), unitKind: 'pdf-page', unitCount: 1, physicalPageCount: 1 },
    },
    options: DEFAULT_COMPARE_OPTIONS_V2,
    rows: [],
    summary: { unchanged: 0, changed: 0, added: 0, removed: 0, moved: 0 },
    warnings: [],
    outcome: 'identical',
    certainty: 'complete',
  };
}

describe('serializeBatchReport', () => {
  it('exports every queued and attempted state, including a batch with no completed result', () => {
    const jobs: BatchJob[] = [
      { id: 'pair-1', status: 'cancelled', beforeName: 'folder/before.pdf', afterName: 'after.pdf', error: { code: 'CANCELLED', message: 'Stopped by user' } },
      { id: 'pair-2', status: 'not-run', beforeName: 'later.pdf', afterName: 'later-revised.pdf' },
      { id: 'pair-3', status: 'failed', beforeName: 'bad.pdf', afterName: 'other.pdf', error: { code: 'PDF_DECODE_FAILED', message: 'Could not read document' } },
    ];

    const report = JSON.parse(serializeBatchReport(jobs)) as {
      reportKind: string;
      jobs: Array<{ id: string; status: string; result?: unknown; error?: { code: string; message: string } }>;
      summary: { succeeded: number; failed: number; cancelled: number; notRun: number };
    };

    expect(report.reportKind).toBe('batch');
    expect(report.jobs.map(({ id, status }) => [id, status])).toEqual([
      ['pair-1', 'cancelled'], ['pair-2', 'not-run'], ['pair-3', 'failed'],
    ]);
    expect(report.jobs[2].error).toEqual({ code: 'PDF_DECODE_FAILED', message: 'Could not read document' });
    expect(report.jobs[0].error).toEqual({ code: 'CANCELLED', message: 'Stopped by user' });
    expect(report.jobs.every((job) => job.result === undefined)).toBe(true);
    expect(report.summary).toEqual({ succeeded: 0, failed: 1, cancelled: 1, notRun: 1 });
  });

  it('includes a projected result only for a successful job', () => {
    const report = JSON.parse(serializeBatchReport([
      { id: 'pair-1', status: 'succeeded', beforeName: 'C:\\private\\before.pdf', afterName: 'after.pdf', result: emptyResult() },
    ])) as { jobs: Array<{ beforeName: string; result?: ComparisonResultV2 }> };

    expect(report.jobs[0].beforeName).toBe('before.pdf');
    expect(report.jobs[0].result?.schemaVersion).toBe(2);
    expect(report.jobs[0].result).not.toHaveProperty('sourceBytes');
  });

  it.each([
    ['success without a result', [{ id: 'pair-1', status: 'succeeded', beforeName: 'a.pdf', afterName: 'b.pdf' }]],
    ['result attached to a cancelled job', [{ id: 'pair-1', status: 'cancelled', beforeName: 'a.pdf', afterName: 'b.pdf', result: emptyResult() }]],
    ['failed job without a safe error', [{ id: 'pair-1', status: 'failed', beforeName: 'a.pdf', afterName: 'b.pdf', error: { code: 4, message: null } }]],
    ['duplicate job ids', [
      { id: 'pair-1', status: 'cancelled', beforeName: 'a.pdf', afterName: 'b.pdf' },
      { id: 'pair-1', status: 'not-run', beforeName: 'c.pdf', afterName: 'd.pdf' },
    ]],
    ['unknown status', [{ id: 'pair-1', status: 'skipped', beforeName: 'a.pdf', afterName: 'b.pdf' }]],
    ['more than the supported batch size', Array.from({ length: MAX_BATCH_REPORT_JOBS + 1 }, (_, index) => ({
      id: `pair-${index + 1}`, status: 'not-run', beforeName: 'a.pdf', afterName: 'b.pdf',
    }))],
  ])('rejects inconsistent batch state: %s', (_label, jobs) => {
    expect(() => serializeBatchReport(jobs as BatchJob[])).toThrow(/state is inconsistent/u);
  });
});
