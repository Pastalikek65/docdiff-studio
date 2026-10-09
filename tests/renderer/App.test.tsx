// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import App from '../../src/renderer/App.js';
import { DEFAULT_COMPARE_OPTIONS_V2 } from '../../src/core/index.js';
import type { ComparisonResultV2 } from '../../src/core/types.js';
import type { CompareWorkerRequestV2 } from '../../src/renderer/compare-v2.worker.js';

type FakeRequest = CompareWorkerRequestV2;

const makePdfResult = (beforeName = 'original.pdf', afterName = 'revised.pdf'): ComparisonResultV2 => ({
  schemaVersion: 2,
  documents: {
    before: { name: beforeName, format: 'pdf', sha256: 'a'.repeat(64), unitKind: 'pdf-page', unitCount: 1, physicalPageCount: 1 },
    after: { name: afterName, format: 'pdf', sha256: 'b'.repeat(64), unitKind: 'pdf-page', unitCount: 2, physicalPageCount: 2 },
  },
  options: { ...DEFAULT_COMPARE_OPTIONS_V2, ocr: { ...DEFAULT_COMPARE_OPTIONS_V2.ocr, beforePageIndexes: [], afterPageIndexes: [] } },
  rows: [
    {
      id: 'page-0', status: 'changed', beforeLocation: { format: 'pdf', kind: 'page', index: 0 }, afterLocation: { format: 'pdf', kind: 'page', index: 0 },
      beforeText: 'old headline', afterText: 'new headline',
      changes: [{ kind: 'removed', text: 'old headline' }, { kind: 'added', text: 'new headline' }],
      textEvidence: { before: { source: 'pdf-text' }, after: { source: 'pdf-text' } },
      beforeImageDataUrl: 'data:image/png;base64,AAAA', afterImageDataUrl: 'data:image/png;base64,BBBB',
    },
    {
      id: 'page-1', status: 'added', beforeLocation: null, afterLocation: { format: 'pdf', kind: 'page', index: 1 },
      beforeText: '', afterText: 'A new appendix page', changes: [{ kind: 'added', text: 'A new appendix page' }],
      textEvidence: { before: { source: 'none' }, after: { source: 'pdf-text' } },
      afterImageDataUrl: 'data:image/png;base64,CCCC',
    },
  ],
  summary: { unchanged: 0, changed: 1, added: 1, removed: 0, moved: 0 },
  warnings: [], outcome: 'changed', certainty: 'complete',
});

const makeDocxMoveResult = (beforeName = 'before.docx', afterName = 'after.docx'): ComparisonResultV2 => ({
  schemaVersion: 2,
  documents: {
    before: { name: beforeName, format: 'docx', sha256: 'c'.repeat(64), unitKind: 'docx-block', unitCount: 2 },
    after: { name: afterName, format: 'docx', sha256: 'd'.repeat(64), unitKind: 'docx-block', unitCount: 2 },
  },
  options: { ...DEFAULT_COMPARE_OPTIONS_V2, ocr: { enabled: false, beforePageIndexes: [], afterPageIndexes: [], minimumConfidence: 70 } },
  rows: [{
    id: 'move-1-before', status: 'moved', moveId: 'move-1',
    beforeLocation: { format: 'docx', kind: 'paragraph', index: 0 },
    afterLocation: { format: 'docx', kind: 'paragraph', index: 1 },
    beforeText: 'Moved policy clause', afterText: 'Moved policy clause',
    changes: [{ kind: 'equal', text: 'Moved policy clause' }],
    textEvidence: { before: { source: 'docx-xml' }, after: { source: 'docx-xml' } },
  }],
  summary: { unchanged: 0, changed: 0, added: 0, removed: 0, moved: 1 },
  warnings: [], outcome: 'changed', certainty: 'complete',
});

class ControlledWorker {
  static instances: ControlledWorker[] = [];
  static respond = true;
  static completeDelay = 80;
  static initialEnvelope: unknown = undefined;
  static resultFactory: (request: FakeRequest) => ComparisonResultV2 = (request) => makePdfResult(request.before.name, request.after.name);
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;
  onmessageerror: ((event: MessageEvent) => void) | null = null;
  request: FakeRequest | null = null;
  transfer: Transferable[] = [];
  terminated = false;

  constructor(_url: URL, _options?: WorkerOptions) { ControlledWorker.instances.push(this); }

  postMessage(message: FakeRequest, transfer: Transferable[] = []) {
    this.request = message;
    this.transfer = transfer;
    if (!ControlledWorker.respond) return;
    if (ControlledWorker.initialEnvelope !== undefined) {
      setTimeout(() => this.onmessage?.({ data: ControlledWorker.initialEnvelope } as MessageEvent), 0);
    }
    setTimeout(() => this.onmessage?.({ data: { type: 'progress', progress: { phase: 'Extracting document text', completed: 1, total: 2 } } } as MessageEvent), 0);
    setTimeout(() => this.onmessage?.({ data: { type: 'complete', result: ControlledWorker.resultFactory(message) } } as MessageEvent), ControlledWorker.completeDelay);
  }

  terminate() { this.terminated = true; }
}

const originalArrayBuffer = Object.getOwnPropertyDescriptor(File.prototype, 'arrayBuffer');

beforeEach(() => {
  ControlledWorker.instances = [];
  ControlledWorker.respond = true;
  ControlledWorker.completeDelay = 80;
  ControlledWorker.initialEnvelope = undefined;
  ControlledWorker.resultFactory = (request) => request.before.format === 'docx'
    ? makeDocxMoveResult(request.before.name, request.after.name)
    : makePdfResult(request.before.name, request.after.name);
  vi.stubGlobal('Worker', ControlledWorker as unknown as typeof Worker);
  Object.defineProperty(File.prototype, 'arrayBuffer', {
    configurable: true,
    value: async function (this: File) { return new TextEncoder().encode(this.name).buffer as ArrayBuffer; },
  });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  delete (window as Window & { docDiffDesktop?: unknown }).docDiffDesktop;
  if (originalArrayBuffer) Object.defineProperty(File.prototype, 'arrayBuffer', originalArrayBuffer);
  else delete (File.prototype as Partial<File>).arrayBuffer;
});

async function uploadPair(container: HTMLElement, before: File, after: File, pair = 1) {
  await userEvent.upload(screen.getByLabelText(`Pair ${pair} before document`) as HTMLInputElement, before);
  await userEvent.upload(screen.getByLabelText(`Pair ${pair} after document`) as HTMLInputElement, after);
}

describe('document review workspace v2', () => {
  it('compares a PDF pair, jumps to a changed page and saves a local HTML report', async () => {
    ControlledWorker.respond = false;
    const user = userEvent.setup();
    const saveReport = vi.fn().mockResolvedValue({ ok: true });
    Object.defineProperty(window, 'docDiffDesktop', { configurable: true, value: { saveReport } });
    const { container } = render(<App />);
    await uploadPair(container, new File(['before'], 'original.pdf', { type: 'application/pdf' }), new File(['after'], 'revised.pdf', { type: 'application/pdf' }));
    await user.click(screen.getByRole('button', { name: /Compare pair/ }));

    await waitFor(() => expect(ControlledWorker.instances[0]?.request).not.toBeNull());
    act(() => ControlledWorker.instances[0].onmessage?.({ data: { type: 'progress', progress: { phase: 'Extracting document text', completed: 1, total: 2 } } } as MessageEvent));
    await waitFor(() => expect(screen.getAllByText('Extracting document text · 50%')).toHaveLength(2));
    act(() => ControlledWorker.instances[0].onmessage?.({ data: { type: 'complete', result: makePdfResult('original.pdf', 'revised.pdf') } } as MessageEvent));
    expect(await screen.findByRole('heading', { name: 'What changed in this unit' })).toBeTruthy();
    expect(ControlledWorker.instances[0].request?.before.name).toBe('original.pdf');
    expect(ControlledWorker.instances[0].request?.after.name).toBe('revised.pdf');
    expect(ControlledWorker.instances[0].request?.before.format).toBe('pdf');
    expect(ControlledWorker.instances[0].transfer).toHaveLength(2);
    expect(container.querySelector('del')?.textContent).toContain('old headline');
    expect(container.querySelector('ins')?.textContent).toContain('new headline');

    await user.click(screen.getByRole('button', { name: /Next change/ }));
    expect(screen.getByRole('heading', { name: /No matching unit.*Page 2/ })).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Save selected HTML' }));
    await waitFor(() => expect(saveReport).toHaveBeenCalledOnce());
    expect(saveReport.mock.calls[0][0]).toMatchObject({ format: 'html' });
    expect(saveReport.mock.calls[0][0].content).toContain('DocDiff Studio comparison');
  });

  it('compares multiple pairs sequentially and exports schema-2 results with per-job statuses', async () => {
    const user = userEvent.setup();
    const saveReport = vi.fn().mockResolvedValue({ ok: true });
    Object.defineProperty(window, 'docDiffDesktop', { configurable: true, value: { saveReport } });
    const { container } = render(<App />);
    await uploadPair(container, new File(['a1'], 'a-before.pdf'), new File(['a2'], 'a-after.pdf'));
    await user.click(screen.getByRole('button', { name: '＋ Add pair' }));
    await uploadPair(container, new File(['b1'], 'b-before.docx'), new File(['b2'], 'b-after.docx'), 2);
    await user.click(screen.getByRole('button', { name: /Compare all pairs/ }));

    await waitFor(() => expect(ControlledWorker.instances).toHaveLength(2));
    await screen.findByText(/Batch finished/);
    expect(ControlledWorker.instances.map((worker) => [worker.request?.before.name, worker.request?.after.name])).toEqual([
      ['a-before.pdf', 'a-after.pdf'], ['b-before.docx', 'b-after.docx'],
    ]);
    expect(ControlledWorker.instances.every((worker) => worker.terminated)).toBe(true);
    expect(screen.getByText('Succeeded')).toBeTruthy();

    await user.click(screen.getByRole('button', { name: 'Save batch JSON' }));
    await waitFor(() => expect(saveReport).toHaveBeenCalledOnce());
    const content = saveReport.mock.calls[0][0].content as string;
    const batch = JSON.parse(content) as { schemaVersion: number; reportKind: string; jobs: Array<{ status: string; result?: { schemaVersion: number } }>; summary: { succeeded: number } };
    expect(batch).toMatchObject({ schemaVersion: 2, reportKind: 'batch', summary: { succeeded: 2, failed: 0, cancelled: 0, notRun: 0 } });
    expect(batch.jobs.map((job) => job.status)).toEqual(['succeeded', 'succeeded']);
    expect(batch.jobs.every((job) => job.result?.schemaVersion === 2)).toBe(true);
    expect(content).not.toContain('bytes');
    expect(content).not.toContain('C:\\');
  });

  it('shows DOCX paragraph moves as logical units without fake page previews', async () => {
    const user = userEvent.setup();
    const { container } = render(<App />);
    await uploadPair(container, new File(['before'], 'old.docx'), new File(['after'], 'new.docx'));
    await user.click(screen.getByRole('button', { name: /Compare pair/ }));

    expect(await screen.findByRole('heading', { name: /Paragraph 1.*Paragraph 2/ })).toBeTruthy();
    expect(screen.getAllByText('DOCX content unit · pagination is not inferred')).toHaveLength(2);
    expect(screen.getAllByText('Moved').length).toBeGreaterThan(0);
    expect(screen.queryByText(/^Page \d+/)).toBeNull();
    expect(container.querySelector('.page-image')).toBeNull();
    expect(screen.getByText('Before: DOCX text')).toBeTruthy();
  });

  it('counts changed table cells separately from all compared cells', async () => {
    ControlledWorker.resultFactory = () => {
      const result = makeDocxMoveResult();
      const equalCellChange = (index: number, text: string) => ({
        beforeCellIndex: index,
        afterCellIndex: index,
        changes: [{ kind: 'equal' as const, text }],
      });
      return {
        ...result,
        rows: [{
          ...result.rows[0],
          id: 'table-row-1',
          status: 'changed',
          moveId: undefined,
          beforeLocation: { format: 'docx', kind: 'table-row', index: 0, tableIndex: 0, rowIndex: 0 },
          afterLocation: { format: 'docx', kind: 'table-row', index: 0, tableIndex: 0, rowIndex: 0 },
          beforeText: 'Widget A 2 500',
          afterText: 'Widget A 2 600',
          beforeCells: ['Widget A', '2', '500'],
          afterCells: ['Widget A', '2', '600'],
          changes: [
            { kind: 'equal', text: 'Widget A 2 ' },
            { kind: 'removed', text: '500' },
            { kind: 'added', text: '600' },
          ],
          cellChanges: [
            equalCellChange(0, 'Widget A'),
            equalCellChange(1, '2'),
            {
              beforeCellIndex: 2,
              afterCellIndex: 2,
              changes: [{ kind: 'removed', text: '500' }, { kind: 'added', text: '600' }],
            },
          ],
        }],
        summary: { unchanged: 0, changed: 1, added: 0, removed: 0, moved: 0 },
      };
    };
    const user = userEvent.setup();
    const { container } = render(<App />);
    await uploadPair(container, new File(['before'], 'before.docx'), new File(['after'], 'after.docx'));
    await user.click(screen.getByRole('button', { name: /Compare pair/ }));

    expect(await screen.findByText(/1 of 3 cells changed/)).toBeTruthy();
    expect(screen.getAllByText('Widget A')).toHaveLength(2);
    expect(screen.getAllByText('500').length).toBeGreaterThan(0);
    expect(screen.getAllByText('600').length).toBeGreaterThan(0);
  });

  it('counts structural empty-cell additions and removals and labels their positions', async () => {
    const baseRow = makeDocxMoveResult().rows[0];
    const addedEmptyCell: ComparisonResultV2['rows'][number] = {
      ...baseRow,
      id: 'table-row-added-empty-cell',
      status: 'changed',
      moveId: undefined,
      beforeLocation: { format: 'docx', kind: 'table-row', index: 0, tableIndex: 0, rowIndex: 0 },
      afterLocation: { format: 'docx', kind: 'table-row', index: 0, tableIndex: 0, rowIndex: 0 },
      beforeText: 'Widget A 2', afterText: 'Widget A 2',
      changes: [{ kind: 'equal', text: 'Widget A 2' }],
      beforeCells: ['Widget A', '2'],
      afterCells: ['Widget A', '2', ''],
      cellChanges: [
        { beforeCellIndex: 0, afterCellIndex: 0, changes: [{ kind: 'equal', text: 'Widget A' }] },
        { beforeCellIndex: 1, afterCellIndex: 1, changes: [{ kind: 'equal', text: '2' }] },
        { beforeCellIndex: null, afterCellIndex: 2, changes: [{ kind: 'equal', text: '' }] },
      ],
    };
    const removedEmptyCell: ComparisonResultV2['rows'][number] = {
      ...baseRow,
      id: 'table-row-removed-empty-cell',
      status: 'changed',
      moveId: undefined,
      beforeLocation: { format: 'docx', kind: 'table-row', index: 1, tableIndex: 0, rowIndex: 1 },
      afterLocation: { format: 'docx', kind: 'table-row', index: 1, tableIndex: 0, rowIndex: 1 },
      beforeText: 'Widget B 2', afterText: 'Widget B 2',
      changes: [{ kind: 'equal', text: 'Widget B 2' }],
      beforeCells: ['Widget B', '2', ''],
      afterCells: ['Widget B', '2'],
      cellChanges: [
        { beforeCellIndex: 0, afterCellIndex: 0, changes: [{ kind: 'equal', text: 'Widget B' }] },
        { beforeCellIndex: 1, afterCellIndex: 1, changes: [{ kind: 'equal', text: '2' }] },
        { beforeCellIndex: 2, afterCellIndex: null, changes: [{ kind: 'equal', text: '' }] },
      ],
    };
    ControlledWorker.resultFactory = () => ({
      ...makeDocxMoveResult(),
      rows: [addedEmptyCell, removedEmptyCell],
      summary: { unchanged: 0, changed: 2, added: 0, removed: 0, moved: 0 },
    });
    const user = userEvent.setup();
    const { container } = render(<App />);
    await uploadPair(container, new File(['before'], 'before.docx'), new File(['after'], 'after.docx'));
    await user.click(screen.getByRole('button', { name: /Compare pair/ }));

    expect(await screen.findByText(/1 of 3 cells changed/)).toBeTruthy();
    expect(screen.getByText('Added · after position 3')).toBeTruthy();
    expect(screen.getByText('Added · after position 3').closest('li')?.textContent).toContain('Empty cell');

    await user.click(screen.getByRole('button', { name: /Next change/ }));
    expect(await screen.findByText(/1 of 3 cells changed/)).toBeTruthy();
    expect(screen.getByText('Removed · before position 3')).toBeTruthy();
    expect(screen.getByText('Removed · before position 3').closest('li')?.textContent).toContain('Empty cell');
  });

  it('describes incomplete OCR evidence without implying that unit matching failed', async () => {
    ControlledWorker.resultFactory = () => {
      const result = makePdfResult();
      return {
        ...result,
        outcome: 'uncertain',
        certainty: 'incomplete',
        warnings: ['OCR-derived text is heuristic evidence.'],
        rows: result.rows.map((row, index) => index === 0 ? {
          ...row,
          textEvidence: {
            before: { source: 'ocr', confidence: 95 },
            after: { source: 'ocr', confidence: 95 },
          },
        } : row),
      };
    };
    const user = userEvent.setup();
    const { container } = render(<App />);
    await uploadPair(container, new File(['before'], 'before.pdf'), new File(['after'], 'after.pdf'));
    await user.click(screen.getByRole('button', { name: /Compare pair/ }));

    expect(await screen.findByText('Some content was not fully verified. Review the notes and source evidence before relying on this comparison.')).toBeTruthy();
    expect(screen.queryByText(/Some units could not be matched with confidence/)).toBeNull();
  });

  it('passes selected local OCR pages through the worker port with the shared confidence setting', async () => {
    const user = userEvent.setup();
    const { container } = render(<App />);
    await uploadPair(container, new File(['before'], 'scan-before.pdf'), new File(['after'], 'scan-after.pdf'));
    await user.click(screen.getByLabelText('Read selected scanned PDF pages with local English OCR'));
    await user.type(screen.getByLabelText('Original PDF pages'), '1, 3');
    await user.type(screen.getByLabelText('Revised PDF pages'), '2');
    await user.click(screen.getByRole('button', { name: /Compare pair/ }));

    await waitFor(() => expect(ControlledWorker.instances[0]?.request).not.toBeNull());
    expect(ControlledWorker.instances[0].request?.options.ocr).toMatchObject({ enabled: true, beforePageIndexes: [0, 2], afterPageIndexes: [1], minimumConfidence: 70 });
    expect(ControlledWorker.instances[0].transfer).toHaveLength(3);
    expect(ControlledWorker.instances[0].transfer[2]).toBeInstanceOf(MessagePort);
    expect(await screen.findByRole('heading', { name: 'What changed in this unit' })).toBeTruthy();
  });

  it('terminates the active worker on cancellation and keeps queued pairs not run', async () => {
    ControlledWorker.respond = false;
    const user = userEvent.setup();
    const saveReport = vi.fn().mockResolvedValue({ ok: true });
    Object.defineProperty(window, 'docDiffDesktop', { configurable: true, value: { saveReport } });
    const { container } = render(<App />);
    await uploadPair(container, new File(['a1'], 'a-before.pdf'), new File(['a2'], 'a-after.pdf'));
    await user.click(screen.getByRole('button', { name: '＋ Add pair' }));
    await uploadPair(container, new File(['b1'], 'b-before.pdf'), new File(['b2'], 'b-after.pdf'), 2);
    await user.click(screen.getByRole('button', { name: /Compare all pairs/ }));
    await waitFor(() => expect(ControlledWorker.instances.length).toBe(1));

    await user.click(screen.getByRole('button', { name: 'Cancel batch' }));
    expect(ControlledWorker.instances[0].terminated).toBe(true);
    expect(screen.getByText('Batch cancelled. Completed pair results remain available.')).toBeTruthy();
    expect(screen.getAllByText('Cancelled')).toHaveLength(1);
    expect(screen.getAllByText('Not run')).toHaveLength(1);
    expect(ControlledWorker.instances).toHaveLength(1);
    const saveBatch = screen.getByRole('button', { name: 'Save batch JSON' });
    expect(saveBatch.hasAttribute('disabled')).toBe(false);
    await user.click(saveBatch);
    await waitFor(() => expect(saveReport).toHaveBeenCalledOnce());
    const batch = JSON.parse(saveReport.mock.calls[0][0].content as string) as { jobs: Array<{ status: string }> };
    expect(batch.jobs.map((job) => job.status)).toEqual(['cancelled', 'not-run']);
  });

  it('fails closed on an inexact worker handshake', async () => {
    ControlledWorker.initialEnvelope = { sourceName: 'worker', targetName: 'main', action: 'ready', data: new Uint8Array([1]) };
    ControlledWorker.respond = false;
    const user = userEvent.setup();
    const { container } = render(<App />);
    await uploadPair(container, new File(['before'], 'before.pdf'), new File(['after'], 'after.pdf'));
    await user.click(screen.getByRole('button', { name: /Compare pair/ }));
    await waitFor(() => expect(ControlledWorker.instances[0]?.request).not.toBeNull());
    ControlledWorker.instances[0].onmessage?.({ data: ControlledWorker.initialEnvelope } as MessageEvent);
    expect(await screen.findAllByText(/WORKER_FAILED/)).toHaveLength(2);
    expect(ControlledWorker.instances[0].terminated).toBe(true);
    expect(screen.getByRole('button', { name: 'Save selected HTML' }).hasAttribute('disabled')).toBe(true);
  });

  it('terminates on message decoding failure and ignores a late completion', async () => {
    ControlledWorker.respond = false;
    const user = userEvent.setup();
    const { container } = render(<App />);
    await uploadPair(container, new File(['before'], 'before.pdf'), new File(['after'], 'after.pdf'));
    await user.click(screen.getByRole('button', { name: /Compare pair/ }));
    await waitFor(() => expect(ControlledWorker.instances[0]?.request).not.toBeNull());

    const worker = ControlledWorker.instances[0];
    act(() => worker.onmessageerror?.({ data: null } as MessageEvent));
    await waitFor(() => expect(worker.terminated).toBe(true));
    expect(await screen.findAllByText(/WORKER_FAILED/)).toHaveLength(2);

    act(() => worker.onmessage?.({ data: { type: 'complete', result: makePdfResult() } } as MessageEvent));
    expect(screen.queryByRole('heading', { name: 'What changed in this unit' })).toBeNull();
    expect(await screen.findAllByText(/WORKER_FAILED/)).toHaveLength(2);
  });
});
