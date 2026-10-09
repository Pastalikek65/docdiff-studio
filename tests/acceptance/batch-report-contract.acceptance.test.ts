import { describe, expect, it } from 'vitest';
import { serializeBatchReport, type BatchJob } from '../../src/renderer/batch-report.js';

describe('schema-2 batch JSON projection', () => {
  it('exports an all-failed batch with explicit errors and no pretend results', () => {
    const jobs: BatchJob[] = [
      {
        id: 'pair-1',
        status: 'failed',
        beforeName: 'C:\\private\\first-before.docx',
        afterName: 'C:\\private\\first-after.docx',
        error: { code: 'DOCX_XML_INVALID', message: 'The DOCX XML is malformed.' },
      },
      {
        id: 'pair-2',
        status: 'failed',
        beforeName: 'second-before.pdf',
        afterName: 'second-after.pdf',
        error: { code: 'PDF_DECODE_FAILED', message: 'The PDF could not be decoded.' },
      },
    ];

    const content = serializeBatchReport(jobs);
    const report = JSON.parse(content) as {
      schemaVersion: number;
      reportKind: string;
      jobs: Array<{ status: string; beforeName: string; afterName: string; result?: unknown; error?: { code: string } }>;
      summary: { succeeded: number; failed: number; cancelled: number; notRun: number };
    };
    expect(report).toMatchObject({
      schemaVersion: 2,
      reportKind: 'batch',
      summary: { succeeded: 0, failed: 2, cancelled: 0, notRun: 0 },
    });
    expect(report.jobs.map(({ status }) => status)).toEqual(['failed', 'failed']);
    expect(report.jobs.map(({ beforeName, afterName }) => [beforeName, afterName])).toEqual([
      ['first-before.docx', 'first-after.docx'],
      ['second-before.pdf', 'second-after.pdf'],
    ]);
    expect(report.jobs.map(({ error }) => error?.code)).toEqual(['DOCX_XML_INVALID', 'PDF_DECODE_FAILED']);
    expect(report.jobs.every((job) => job.result === undefined)).toBe(true);
    expect(content).not.toContain('C:\\private\\');
    expect(content).not.toContain('bytes');
  });

  it('preserves cancelled and not-run-only jobs when a batch has no result', () => {
    const content = serializeBatchReport([
      {
        id: 'pair-1',
        status: 'cancelled',
        beforeName: 'before.pdf',
        afterName: 'after.pdf',
        error: { code: 'CANCELLED', message: 'This pair was cancelled before a result was produced.' },
      },
      { id: 'pair-2', status: 'not-run', beforeName: 'later-before.pdf', afterName: 'later-after.pdf' },
    ]);
    const report = JSON.parse(content) as {
      jobs: Array<{ status: string; result?: unknown; error?: { code: string } }>;
      summary: { succeeded: number; failed: number; cancelled: number; notRun: number };
    };
    expect(report.summary).toEqual({ succeeded: 0, failed: 0, cancelled: 1, notRun: 1 });
    expect(report.jobs.map(({ status }) => status)).toEqual(['cancelled', 'not-run']);
    expect(report.jobs[0].error?.code).toBe('CANCELLED');
    expect(report.jobs.every((job) => job.result === undefined)).toBe(true);
  });
});
