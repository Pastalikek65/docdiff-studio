import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Dispatch, SetStateAction } from 'react';
import { COMPARISON_LIMITS, DEFAULT_COMPARE_OPTIONS_V2, renderHtmlReportV2, serializeReportV2 } from '../core/index.js';
import type {
  CompareOptionsV2,
  ComparisonResultV2,
  ComparisonRowV2,
  DocumentLocationV2,
  SourceFormatV2,
} from '../core/types.js';
import { attachOcrHost } from './ocr-host.js';
import { batchReportFits, serializeBatchReport } from './batch-report.js';
import type { BatchJob } from './batch-report.js';
import { isReadyHandshake, isWorkerResponseV2 } from './worker-messages.js';
import type { CompareWorkerRequestV2 } from './compare-v2.worker.js';

type PairStatus = 'empty' | 'ready' | 'not-run' | 'working' | 'succeeded' | 'failed' | 'cancelled';
type Pair = {
  id: string;
  before: File | null;
  after: File | null;
  status: PairStatus;
  result: ComparisonResultV2 | null;
  error: { code: string; message: string } | null;
  progress: string;
};
type RunState = { kind: 'idle' } | { kind: 'working'; completed: number; total: number; phase: string } | { kind: 'done' } | { kind: 'cancelled' };
type ActiveRun = { cancel: () => void };
type DisplayMode = 'side-by-side' | 'overlay';

const DEFAULT_OPTIONS: CompareOptionsV2 = {
  ...DEFAULT_COMPARE_OPTIONS_V2,
  ocr: {
    ...DEFAULT_COMPARE_OPTIONS_V2.ocr,
    beforePageIndexes: [...DEFAULT_COMPARE_OPTIONS_V2.ocr.beforePageIndexes],
    afterPageIndexes: [...DEFAULT_COMPARE_OPTIONS_V2.ocr.afterPageIndexes],
  },
};
const ACCEPTED_FILES = '.pdf,.docx,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document';
const MAX_OCR_SELECTION = 20;
const MAX_BATCH_PAIRS = 20;

function newPair(number: number): Pair {
  return { id: `pair-${number}`, before: null, after: null, status: 'empty', result: null, error: null, progress: '' };
}

function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(0)} MB`;
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

function detectFormat(file: File): SourceFormatV2 | null {
  const name = file.name.toLowerCase();
  if (name.endsWith('.pdf')) return 'pdf';
  if (name.endsWith('.docx')) return 'docx';
  return null;
}

function formatName(format: SourceFormatV2 | undefined): string {
  return format === 'docx' ? 'DOCX' : 'PDF';
}

function locationLabel(location: DocumentLocationV2 | null): string {
  if (!location) return 'No matching unit';
  if (location.kind === 'page') return `Page ${location.index + 1}`;
  if (location.kind === 'paragraph') return `Paragraph ${location.index + 1}`;
  return `Table ${location.tableIndex + 1}, row ${location.rowIndex + 1}`;
}

function statusLabel(status: ComparisonRowV2['status']): string {
  switch (status) {
    case 'unchanged': return 'Unchanged';
    case 'changed': return 'Changed';
    case 'added': return 'Added';
    case 'removed': return 'Removed';
    case 'moved': return 'Moved';
  }
}

function safeImageSource(value: string | undefined): string | null {
  if (!value || value.length > COMPARISON_LIMITS.maxImageOutputCharacters) return null;
  return /^data:image\/(?:png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/.test(value) ? value : null;
}

function shortenedText(text: string): string {
  return text.length > 15_000 ? `${text.slice(0, 15_000)}\n\nPreview shortened.` : text;
}

function parsePageList(value: string): number[] | null {
  const source = value.trim();
  if (!source) return [];
  const parts = source.split(',').map((part) => part.trim());
  if (parts.length > MAX_OCR_SELECTION || parts.some((part) => !/^\d{1,3}$/.test(part))) return null;
  const pages = parts.map(Number);
  if (pages.some((page) => page < 1 || page > 200) || new Set(pages).size !== pages.length) return null;
  return pages.map((page) => page - 1);
}

function showPageList(indexes: number[]): string {
  return indexes.map((index) => String(index + 1)).join(', ');
}

function isPairReady(pair: Pair): boolean {
  return !!pair.before && !!pair.after && detectFormat(pair.before) === detectFormat(pair.after);
}

function isBatchExportState(status: PairStatus): boolean {
  return status === 'not-run' || status === 'succeeded' || status === 'failed' || status === 'cancelled';
}

function batchJobsFromState(pairs: Pair[], ids: string[]): BatchJob[] {
  return ids.flatMap((id) => {
    const pair = pairs.find((candidate) => candidate.id === id);
    if (!pair) return [];
    const status: BatchJob['status'] = pair.status === 'succeeded' ? 'succeeded'
      : pair.status === 'failed' ? 'failed' : pair.status === 'cancelled' ? 'cancelled' : 'not-run';
    return [{
      id: pair.id,
      status,
      beforeName: pair.before?.name ?? pair.result?.documents.before.name ?? 'Untitled before document',
      afterName: pair.after?.name ?? pair.result?.documents.after.name ?? 'Untitled after document',
      ...(status === 'succeeded' && pair.result ? { result: pair.result } : {}),
      ...(pair.error ? { error: pair.error } : status === 'cancelled' ? { error: { code: 'CANCELLED', message: 'This pair was cancelled before a result was produced.' } } : {}),
    } satisfies BatchJob];
  });
}

function progressText(phase: string, completed: number, total: number): string {
  return total > 0 ? `${phase} · ${Math.min(100, Math.round(completed / total * 100))}%` : phase;
}

function OptionsPanel({
  options,
  setOptions,
  disabled,
  pageInputInvalid,
  onPageInputValidity,
}: {
  options: CompareOptionsV2;
  setOptions: Dispatch<SetStateAction<CompareOptionsV2>>;
  disabled: boolean;
  pageInputInvalid: boolean;
  onPageInputValidity: (invalid: boolean) => void;
}) {
  const [beforePageText, setBeforePageText] = useState(showPageList(options.ocr.beforePageIndexes));
  const [afterPageText, setAfterPageText] = useState(showPageList(options.ocr.afterPageIndexes));
  const [beforeInvalid, setBeforeInvalid] = useState(false);
  const [afterInvalid, setAfterInvalid] = useState(false);
  const previousBeforePages = useRef(options.ocr.beforePageIndexes);
  const previousAfterPages = useRef(options.ocr.afterPageIndexes);

  useEffect(() => {
    let nextBeforeText = beforePageText;
    let nextAfterText = afterPageText;
    if (previousBeforePages.current !== options.ocr.beforePageIndexes) {
      previousBeforePages.current = options.ocr.beforePageIndexes;
      nextBeforeText = showPageList(options.ocr.beforePageIndexes);
      setBeforePageText(nextBeforeText);
    }
    if (previousAfterPages.current !== options.ocr.afterPageIndexes) {
      previousAfterPages.current = options.ocr.afterPageIndexes;
      nextAfterText = showPageList(options.ocr.afterPageIndexes);
      setAfterPageText(nextAfterText);
    }
    const parsedBefore = parsePageList(nextBeforeText);
    const parsedAfter = parsePageList(nextAfterText);
    const totalInvalid = parsedBefore !== null && parsedAfter !== null &&
      parsedBefore.length + parsedAfter.length > COMPARISON_LIMITS.maxOcrPages;
    const beforeBad = parsedBefore === null || totalInvalid;
    const afterBad = parsedAfter === null || totalInvalid;
    setBeforeInvalid(beforeBad);
    setAfterInvalid(afterBad);
    onPageInputValidity(beforeBad || afterBad);
  }, [options.ocr.beforePageIndexes, options.ocr.afterPageIndexes, onPageInputValidity]);

  const updatePageList = (side: 'before' | 'after', text: string) => {
    (side === 'before' ? setBeforePageText : setAfterPageText)(text);
    const indexes = parsePageList(text);
    const parsedBefore = side === 'before' ? indexes : parsePageList(beforePageText);
    const parsedAfter = side === 'after' ? indexes : parsePageList(afterPageText);
    const totalInvalid = parsedBefore !== null && parsedAfter !== null &&
      parsedBefore.length + parsedAfter.length > COMPARISON_LIMITS.maxOcrPages;
    const beforeBad = parsedBefore === null || totalInvalid;
    const afterBad = parsedAfter === null || totalInvalid;
    setBeforeInvalid(beforeBad);
    setAfterInvalid(afterBad);
    onPageInputValidity(beforeBad || afterBad);
    if (indexes === null) return;
    setOptions((current) => ({
      ...current,
      ocr: { ...current.ocr, [side === 'before' ? 'beforePageIndexes' : 'afterPageIndexes']: indexes },
    }));
  };

  return (
    <details className="compare-settings">
      <summary>Comparison options</summary>
      <div className="settings-grid v2-settings">
        <label className="option-check"><input type="checkbox" disabled={disabled} checked={options.ignoreWhitespace} onChange={(event) => setOptions((value) => ({ ...value, ignoreWhitespace: event.target.checked }))} /> Ignore whitespace-only text changes</label>
        <label className="option-check"><input type="checkbox" disabled={disabled} checked={options.detectMoves} onChange={(event) => setOptions((value) => ({ ...value, detectMoves: event.target.checked }))} /> Detect exact moved paragraphs or pages</label>
        <label>Ignore first lines on each PDF page<input type="number" disabled={disabled} min={0} max={COMPARISON_LIMITS.maxIgnoredLines} value={options.ignoreHeaderLines} onChange={(event) => setOptions((value) => ({ ...value, ignoreHeaderLines: Math.max(0, Math.min(COMPARISON_LIMITS.maxIgnoredLines, Number(event.target.value) || 0)) }))} /></label>
        <label>Ignore last lines on each PDF page<input type="number" disabled={disabled} min={0} max={COMPARISON_LIMITS.maxIgnoredLines} value={options.ignoreFooterLines} onChange={(event) => setOptions((value) => ({ ...value, ignoreFooterLines: Math.max(0, Math.min(COMPARISON_LIMITS.maxIgnoredLines, Number(event.target.value) || 0)) }))} /></label>
        <label>Visual pixel tolerance <strong>{options.visualThreshold}</strong><input type="range" disabled={disabled} min={0} max={80} value={options.visualThreshold} onChange={(event) => setOptions((value) => ({ ...value, visualThreshold: Number(event.target.value) }))} /></label>
        <div className="ocr-settings">
          <label className="option-check"><input type="checkbox" disabled={disabled} checked={options.ocr.enabled} onChange={(event) => setOptions((value) => ({ ...value, ocr: { ...value.ocr, enabled: event.target.checked } }))} /> Read selected scanned PDF pages with local English OCR</label>
          {options.ocr.enabled && (
            <div className="ocr-page-fields">
              <label>Original PDF pages<input disabled={disabled} value={beforePageText} onChange={(event) => updatePageList('before', event.target.value)} placeholder="1, 3" aria-invalid={beforeInvalid || pageInputInvalid} /></label>
              <label>Revised PDF pages<input disabled={disabled} value={afterPageText} onChange={(event) => updatePageList('after', event.target.value)} placeholder="1, 3" aria-invalid={afterInvalid || pageInputInvalid} /></label>
              <label className="confidence-field">Minimum OCR confidence <strong>{options.ocr.minimumConfidence}/100</strong><input type="range" disabled={disabled} min={0} max={100} value={options.ocr.minimumConfidence} onChange={(event) => setOptions((value) => ({ ...value, ocr: { ...value.ocr, minimumConfidence: Number(event.target.value) } }))} /></label>
            </div>
          )}
          <p>OCR runs locally with the bundled English model. Select up to {COMPARISON_LIMITS.maxOcrPages} pages total across both sides (no more than {MAX_OCR_SELECTION} per side). Confidence is an engine score, not a probability; low-confidence text remains marked uncertain.</p>
        </div>
        <p>Header/footer line filters apply to PDF pages. DOCX files are compared as paragraphs and table rows without invented page numbers.</p>
        {pageInputInvalid && <p className="field-error" role="alert">Enter unique page numbers from 1 to 200, with no more than {COMPARISON_LIMITS.maxOcrPages} selected total.</p>}
      </div>
    </details>
  );
}

function ChangeText({ row }: { row: ComparisonRowV2 }) {
  if (!row.changes.length || row.changes.every((change) => change.kind === 'equal')) {
    if (row.status === 'unchanged') return <p className="no-text-change">No text change detected in this unit.</p>;
    return (
      <div className="text-fallback">
        <section><h4>Before text</h4><pre>{shortenedText(row.beforeText) || 'No text was extracted from this unit.'}</pre></section>
        <section><h4>After text</h4><pre>{shortenedText(row.afterText) || 'No text was extracted from this unit.'}</pre></section>
      </div>
    );
  }
  return (
    <div className="change-text" aria-label="Text differences">
      {row.changes.map((change, index) => {
        if (change.kind === 'added') return <ins key={`${index}-${change.text}`}><span className="change-word">Added</span>{change.text}</ins>;
        if (change.kind === 'removed') return <del key={`${index}-${change.text}`}><span className="change-word">Removed</span>{change.text}</del>;
        return <span key={`${index}-${change.text}`}>{change.text}</span>;
      })}
    </div>
  );
}

function EvidenceLabel({ side, source, confidence }: { side: string; source: string; confidence?: number }) {
  const label = source === 'pdf-text' ? 'PDF text' : source === 'docx-xml' ? 'DOCX text' : source === 'ocr' ? 'English OCR' : 'No text evidence';
  return <span className="evidence-label">{side}: {label}{source === 'ocr' && confidence !== undefined ? ` · ${Math.round(confidence)}/100 confidence` : ''}</span>;
}

function TextSourceCard({ title, location, image, text, format }: {
  title: string;
  location: DocumentLocationV2 | null;
  image: string | undefined;
  text: string;
  format: SourceFormatV2;
}) {
  const source = safeImageSource(image);
  return (
    <section className="page-card" aria-label={`${title}, ${locationLabel(location)}`}>
      <header className="page-card-heading"><span>{title}</span><span className="page-index">{locationLabel(location)}</span></header>
      {format === 'pdf' && source ? (
        <div className="page-image-wrap"><img className="page-image" src={source} alt={`${title}, ${locationLabel(location)} preview`} /></div>
      ) : (
        <div className={`unit-text-card ${format === 'docx' ? 'docx-unit-card' : ''}`}>
          <p>{format === 'docx' ? 'DOCX content unit · pagination is not inferred' : location ? 'No page image was produced for this page.' : 'This document has no matching page here.'}</p>
          <pre>{shortenedText(text) || (format === 'docx' ? 'No paragraph text is available for this table row.' : 'No text was extracted.')}</pre>
        </div>
      )}
    </section>
  );
}

function ChangeDetails({ row }: { row: ComparisonRowV2 }) {
  if (!row.beforeCells && !row.afterCells) return null;
  return (
    <section className="table-cell-review" aria-label="Table row cell comparison">
      <h4>Table row cells</h4>
      <div className="table-cell-columns">
        <div><strong>Before</strong><ol>{(row.beforeCells ?? []).map((cell, index) => <li key={`before-${index}`}>{cell || 'Empty cell'}</li>)}</ol></div>
        <div><strong>After</strong><ol>{(row.afterCells ?? []).map((cell, index) => <li key={`after-${index}`}>{cell || 'Empty cell'}</li>)}</ol></div>
      </div>
      {row.cellChanges?.length ? <p>{row.cellChanges.length} cell{row.cellChanges.length === 1 ? '' : 's'} changed. Cell positions are shown in source order.</p> : <p>No cell-level text change was reported.</p>}
    </section>
  );
}

function PairStateLabel({ pair }: { pair: Pair }) {
  switch (pair.status) {
    case 'empty': return <span className="pair-state pair-idle">Add two documents</span>;
    case 'ready': return <span className="pair-state pair-ready">Ready</span>;
    case 'not-run': return <span className="pair-state pair-queued">Not run</span>;
    case 'working': return <span className="pair-state pair-working">{pair.progress || 'Comparing'}</span>;
    case 'succeeded': return <span className="pair-state pair-done">{pair.result?.summary.moved ? `${pair.result.summary.moved} moved` : 'Succeeded'}</span>;
    case 'failed': return <span className="pair-state pair-failed">{pair.error?.code ?? 'Failed'}</span>;
    case 'cancelled': return <span className="pair-state pair-cancelled">Cancelled</span>;
  }
}

export default function App() {
  const [pairs, setPairs] = useState<Pair[]>([newPair(1)]);
  const [selectedPairId, setSelectedPairId] = useState('pair-1');
  const [lastBatchIds, setLastBatchIds] = useState<string[]>([]);
  const [run, setRun] = useState<RunState>({ kind: 'idle' });
  const [options, setOptions] = useState<CompareOptionsV2>({ ...DEFAULT_OPTIONS, ocr: { ...DEFAULT_OPTIONS.ocr } });
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [displayMode, setDisplayMode] = useState<DisplayMode>('side-by-side');
  const [showAllRows, setShowAllRows] = useState(false);
  const [exportMessage, setExportMessage] = useState('');
  const [pageInputInvalid, setPageInputInvalid] = useState(false);
  const [batchError, setBatchError] = useState('');
  const activeTask = useRef<ActiveRun | null>(null);
  const activeTimer = useRef<number | null>(null);
  const runToken = useRef(0);
  const rowButtons = useRef<Array<HTMLButtonElement | null>>([]);

  const selectedPair = pairs.find((pair) => pair.id === selectedPairId) ?? pairs[0];
  const result = selectedPair?.result ?? null;
  const rows = result?.rows ?? [];
  const changeIndices = useMemo(() => rows.flatMap((row, index) => row.status === 'unchanged' ? [] : [index]), [rows]);
  const selectedRow = rows[selectedIndex] ?? null;
  const visibleIndices = useMemo(() => rows.flatMap((row, index) => showAllRows || row.status !== 'unchanged' ? [index] : []), [rows, showAllRows]);
  const completedPairs = pairs.filter((pair) => pair.result !== null);
  const batchJobs = useMemo(() => {
    // Preserve the visible attempted states if the last-run id list was
    // cleared while a cancelled/failed batch was being interrupted.
    const ids = lastBatchIds.length
      ? lastBatchIds
      : pairs.filter((pair) => isBatchExportState(pair.status)).map((pair) => pair.id);
    return batchJobsFromState(pairs, ids);
  }, [pairs, lastBatchIds]);
  const batchCounts = useMemo(() => ({
    succeeded: batchJobs.filter((job) => job.status === 'succeeded').length,
    failed: batchJobs.filter((job) => job.status === 'failed').length,
    cancelled: batchJobs.filter((job) => job.status === 'cancelled').length,
    notRun: batchJobs.filter((job) => job.status === 'not-run').length,
  }), [batchJobs]);
  const isWorking = run.kind === 'working';
  const optionsChanged = !!result && JSON.stringify(result.options) !== JSON.stringify(options);
  const beforePageIndexes = parsePageList(showPageList(options.ocr.beforePageIndexes));
  const afterPageIndexes = parsePageList(showPageList(options.ocr.afterPageIndexes));
  const invalidPageSelection = pageInputInvalid || beforePageIndexes === null || afterPageIndexes === null;

  const updatePair = useCallback((id: string, updater: (pair: Pair) => Pair) => {
    setPairs((current) => current.map((pair) => pair.id === id ? updater(pair) : pair));
  }, []);

  const selectRow = useCallback((index: number, focus = false) => {
    if (index < 0 || index >= rows.length) return;
    setSelectedIndex(index);
    if (focus) requestAnimationFrame(() => rowButtons.current[index]?.focus());
  }, [rows.length]);

  const moveToChange = useCallback((direction: -1 | 1) => {
    if (!changeIndices.length) return;
    const current = changeIndices.indexOf(selectedIndex);
    const next = current < 0
      ? (direction > 0 ? changeIndices[0] : changeIndices[changeIndices.length - 1])
      : changeIndices[(current + direction + changeIndices.length) % changeIndices.length];
    selectRow(next, true);
  }, [changeIndices, selectedIndex, selectRow]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target;
      if (target instanceof HTMLElement && (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName))) return;
      if (event.altKey && event.key === 'ArrowDown') { event.preventDefault(); moveToChange(1); }
      else if (event.altKey && event.key === 'ArrowUp') { event.preventDefault(); moveToChange(-1); }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [moveToChange]);

  const stopCurrentTask = useCallback(() => {
    activeTask.current?.cancel();
    activeTask.current = null;
    if (activeTimer.current !== null) window.clearTimeout(activeTimer.current);
    activeTimer.current = null;
  }, []);

  const cancelBatch = useCallback(() => {
    runToken.current += 1;
    stopCurrentTask();
    setPairs((current) => current.map((pair) => pair.status === 'working'
      ? { ...pair, status: 'cancelled', progress: '', error: null }
      : pair));
    setRun({ kind: 'cancelled' });
  }, [stopCurrentTask]);

  useEffect(() => () => {
    runToken.current += 1;
    stopCurrentTask();
  }, [stopCurrentTask]);

  const setFile = (pairId: string, side: 'before' | 'after', file: File | undefined) => {
    if (!file) return;
    const format = detectFormat(file);
    if (!format) {
      updatePair(pairId, (pair) => ({ ...pair, [side]: null, status: 'failed', error: { code: 'UNSUPPORTED_FORMAT', message: 'Choose a PDF or DOCX file.' }, result: null }));
      setLastBatchIds((current) => current.filter((id) => id !== pairId));
      return;
    }
    if (file.size > COMPARISON_LIMITS.maxInputBytesPerDocument) {
      updatePair(pairId, (pair) => ({ ...pair, [side]: null, status: 'failed', error: { code: 'INPUT_TOO_LARGE', message: `Each file must be ${formatBytes(COMPARISON_LIMITS.maxInputBytesPerDocument)} or smaller.` }, result: null }));
      setLastBatchIds((current) => current.filter((id) => id !== pairId));
      return;
    }
    updatePair(pairId, (pair) => {
      const next = { ...pair, [side]: file, result: null, error: null, progress: '' };
      const before = side === 'before' ? file : pair.before;
      const after = side === 'after' ? file : pair.after;
      if (before && after && detectFormat(before) !== detectFormat(after)) {
        return { ...next, status: 'failed', error: { code: 'FORMAT_MISMATCH', message: 'A comparison pair must contain two PDFs or two DOCX files of the same format.' } };
      }
      return { ...next, status: before && after ? 'ready' : 'empty' };
    });
    setExportMessage('');
    setBatchError('');
    setLastBatchIds((current) => current.filter((id) => id !== pairId));
  };

  const addPair = () => {
    if (isWorking || pairs.length >= MAX_BATCH_PAIRS) return;
    const nextNumber = pairs.reduce((maximum, pair) => Math.max(maximum, Number(pair.id.slice(5)) || 0), 0) + 1;
    const pair = newPair(nextNumber);
    setPairs((current) => [...current, pair]);
    setLastBatchIds((current) => current.filter((id) => id !== pair.id));
    setSelectedPairId(pair.id);
    setSelectedIndex(0);
  };

  const removePair = (pairId: string) => {
    if (isWorking || pairs.length === 1) return;
    const remaining = pairs.filter((pair) => pair.id !== pairId);
    setPairs(remaining);
    setLastBatchIds((current) => current.filter((id) => id !== pairId));
    if (selectedPairId === pairId) setSelectedPairId(remaining[0].id);
  };

  const runPair = async (pair: Pair, token: number): Promise<ComparisonResultV2> => {
    const beforeFile = pair.before;
    const afterFile = pair.after;
    if (!beforeFile || !afterFile) throw new Error('Both documents are required.');
    if (beforeFile.size + afterFile.size > COMPARISON_LIMITS.maxCombinedInputBytes) {
      throw Object.assign(new Error(`The two files together must be ${formatBytes(COMPARISON_LIMITS.maxCombinedInputBytes)} or smaller.`), { code: 'INPUT_TOO_LARGE' });
    }
    setRun({ kind: 'working', completed: 0, total: 0, phase: `Reading ${beforeFile.name} and ${afterFile.name}` });
    let beforeBytes: ArrayBuffer;
    let afterBytes: ArrayBuffer;
    try {
      [beforeBytes, afterBytes] = await Promise.all([beforeFile.arrayBuffer(), afterFile.arrayBuffer()]);
    } catch {
      throw Object.assign(new Error('The selected documents could not be read from this device.'), { code: 'FILE_READ_FAILED' });
    }
    if (token !== runToken.current) throw Object.assign(new Error('Comparison cancelled.'), { code: 'CANCELLED' });

    const format = detectFormat(beforeFile);
    if (!format || format !== detectFormat(afterFile)) throw Object.assign(new Error('A comparison pair must contain two documents of the same format.'), { code: 'FORMAT_MISMATCH' });
    const effectiveOptions: CompareOptionsV2 = format === 'docx'
      ? { ...options, ocr: { ...options.ocr, enabled: false, beforePageIndexes: [], afterPageIndexes: [] } }
      : options;
    let ocrCleanup: (() => void) | null = null;
    let channel: MessageChannel | null = null;
    if (effectiveOptions.ocr.enabled) {
      if (typeof MessageChannel === 'undefined') throw Object.assign(new Error('Local OCR is unavailable in this desktop session.'), { code: 'OCR_UNAVAILABLE' });
      channel = new MessageChannel();
      ocrCleanup = attachOcrHost(channel.port1, (_requestId, progress) => {
        if (token !== runToken.current) return;
        const percent = Math.round(progress.progress * 100);
        const phase = `${progress.phase} · ${percent}%`;
        updatePair(pair.id, (current) => ({ ...current, progress: phase }));
        setRun({ kind: 'working', completed: 0, total: 0, phase });
      });
    }

    return await new Promise<ComparisonResultV2>((resolve, reject) => {
      let settled = false;
      let worker: Worker;
      try {
        worker = new Worker(new URL('./compare-v2.worker.ts', import.meta.url), { type: 'module', name: 'docdiff-comparison-v2' });
      } catch {
        ocrCleanup?.();
        channel?.port2.close();
        reject(Object.assign(new Error('The comparison worker could not be started in this desktop session.'), { code: 'WORKER_UNAVAILABLE' }));
        return;
      }
      const cleanup = () => {
        if (activeTimer.current !== null) window.clearTimeout(activeTimer.current);
        activeTimer.current = null;
        ocrCleanup?.();
        ocrCleanup = null;
        channel?.port2.close();
        worker.terminate();
        if (activeTask.current?.cancel === cancel) activeTask.current = null;
      };
      const finish = (error?: Error, result?: ComparisonResultV2) => {
        if (settled) return;
        settled = true;
        cleanup();
        if (error) reject(error);
        else if (result) resolve(result);
        else reject(new Error('The comparison returned no result.'));
      };
      const cancel = () => finish(Object.assign(new Error('Comparison cancelled.'), { code: 'CANCELLED' }));
      activeTask.current = { cancel };
      activeTimer.current = window.setTimeout(() => finish(Object.assign(
        new Error('The comparison reached its two-minute limit and was stopped. Try fewer or smaller documents.'),
        { code: 'TIME_LIMIT_EXCEEDED' },
      )), COMPARISON_LIMITS.maxWallTimeMs);

      worker.onmessage = (event: MessageEvent<unknown>) => {
        if (token !== runToken.current || settled) return;
        if (isReadyHandshake(event.data)) return;
        if (!isWorkerResponseV2(event.data)) {
          finish(Object.assign(new Error('The comparison returned an unreadable response. No result was produced.'), { code: 'WORKER_FAILED' }));
          return;
        }
        const message = event.data;
        if (message.type === 'progress') {
          const phase = progressText(message.progress.phase, message.progress.completed, message.progress.total);
          updatePair(pair.id, (current) => ({ ...current, progress: phase }));
          setRun({ kind: 'working', completed: message.progress.completed, total: message.progress.total, phase });
        } else if (message.type === 'ocr-progress') {
          const phase = `${message.progress.phase} · ${Math.round(message.progress.progress * 100)}%`;
          updatePair(pair.id, (current) => ({ ...current, progress: phase }));
          setRun({ kind: 'working', completed: 0, total: 0, phase });
        } else if (message.type === 'error') {
          finish(Object.assign(new Error(message.message), { code: message.code }));
        } else {
          finish(undefined, message.result);
        }
      };
      worker.onerror = (event) => {
        event.preventDefault();
        finish(Object.assign(new Error('The comparison worker stopped unexpectedly. No result was produced.'), { code: 'WORKER_FAILED' }));
      };
      worker.onmessageerror = () => finish(Object.assign(
        new Error('The comparison result could not be read. No result was produced.'), { code: 'WORKER_FAILED' },
      ));

      const request: CompareWorkerRequestV2 = {
        type: 'compare-v2',
        before: { format, name: beforeFile.name, bytes: beforeBytes },
        after: { format, name: afterFile.name, bytes: afterBytes },
        options: effectiveOptions,
        ...(channel ? { ocrPort: channel.port2 } : {}),
      };
      const transfer: Transferable[] = [beforeBytes, afterBytes];
      if (channel) transfer.push(channel.port2);
      try { worker.postMessage(request, transfer); }
      catch { finish(Object.assign(new Error('The comparison could not be started.'), { code: 'WORKER_UNAVAILABLE' })); }
    });
  };

  const startBatch = async () => {
    if (isWorking) return;
    setBatchError('');
    const incomplete = pairs.find((pair) => (pair.before || pair.after) && !isPairReady(pair));
    if (incomplete) {
      setBatchError(`Complete Pair ${pairs.indexOf(incomplete) + 1} with two documents in the same format, or remove it.`);
      return;
    }
    const targets = pairs.filter(isPairReady);
    if (targets.length === 0) {
      setBatchError('Add at least one complete PDF or DOCX pair before comparing.');
      return;
    }
    if (invalidPageSelection) {
      setBatchError('Fix the selected OCR page numbers before comparing.');
      return;
    }
    if (options.ocr.enabled && options.ocr.beforePageIndexes.length + options.ocr.afterPageIndexes.length === 0) {
      setBatchError('Select at least one page for English OCR, or turn OCR off.');
      return;
    }
    if (options.ocr.enabled && options.ocr.beforePageIndexes.length + options.ocr.afterPageIndexes.length > COMPARISON_LIMITS.maxOcrPages) {
      setBatchError(`Select no more than ${COMPARISON_LIMITS.maxOcrPages} pages total for OCR across both sides.`);
      return;
    }
    if (options.ocr.enabled && targets.some((pair) => detectFormat(pair.before!) === 'docx')) {
      setBatchError('English OCR is available for PDF pages only. Turn OCR off before comparing a DOCX batch.');
      return;
    }

    stopCurrentTask();
    const token = ++runToken.current;
    setExportMessage('');
    const batchJobs: BatchJob[] = targets.map((pair) => ({
      id: pair.id,
      status: 'not-run',
      beforeName: pair.before?.name ?? 'Untitled before document',
      afterName: pair.after?.name ?? 'Untitled after document',
    }));
    setLastBatchIds(targets.map((pair) => pair.id));
    let outputLimitReached = false;
    setPairs((current) => current.map((pair) => isPairReady(pair)
      ? { ...pair, status: 'not-run', result: null, error: null, progress: '' }
      : pair));
    setRun({ kind: 'working', completed: 0, total: targets.length, phase: `Starting ${targets.length} comparison${targets.length === 1 ? '' : 's'}` });

    for (let index = 0; index < targets.length; index += 1) {
      if (runToken.current !== token) break;
      const pair = targets[index];
      setSelectedPairId(pair.id);
      setSelectedIndex(0);
      updatePair(pair.id, (current) => ({ ...current, status: 'working', error: null, progress: 'Starting comparison' }));
      setRun({ kind: 'working', completed: index, total: targets.length, phase: `Pair ${index + 1} of ${targets.length} · Starting comparison` });
      try {
        const result = await runPair(pair, token);
        if (runToken.current !== token) break;
        const successfulJob: BatchJob = { ...batchJobs[index], status: 'succeeded', result };
        const candidateJobs = batchJobs.map((job, jobIndex) => jobIndex === index ? successfulJob : job);
        if (!batchReportFits(serializeBatchReport(candidateJobs))) {
          outputLimitReached = true;
          const message = 'This result would push retained batch outputs above 64 MiB. Earlier results are preserved; clear the workspace or run smaller batches.';
          batchJobs[index] = { ...batchJobs[index], status: 'failed', error: { code: 'BATCH_OUTPUT_LIMIT', message } };
          updatePair(pair.id, (current) => ({ ...current, status: 'failed', result: null, error: { code: 'BATCH_OUTPUT_LIMIT', message }, progress: '' }));
        } else {
          batchJobs[index] = successfulJob;
          updatePair(pair.id, (current) => ({ ...current, status: 'succeeded', result, error: null, progress: '' }));
          const firstChange = result.rows.findIndex((row) => row.status !== 'unchanged');
          setSelectedIndex(firstChange >= 0 ? firstChange : 0);
        }
      } catch (error) {
        if (runToken.current !== token) break;
        const failure = error instanceof Error ? error as Error & { code?: string } : new Error('Comparison failed.') as Error & { code?: string };
        const code = failure.code ?? 'COMPARE_FAILED';
        const status = code === 'CANCELLED' ? 'cancelled' : 'failed';
        batchJobs[index] = { ...batchJobs[index], status, error: { code, message: failure.message } };
        updatePair(pair.id, (current) => ({
          ...current,
          status,
          result: null,
          error: { code, message: failure.message },
          progress: '',
        }));
      }
      if (outputLimitReached) break;
      setRun({ kind: 'working', completed: index + 1, total: targets.length, phase: `Finished pair ${index + 1} of ${targets.length}` });
    }
    if (runToken.current === token) setRun({ kind: 'done' });
  };

  const saveReport = async (format: 'html' | 'json') => {
    if (!window.docDiffDesktop) {
      setExportMessage('Report saving is available in the DocDiff desktop app.');
      return;
    }
    const report = format === 'html' ? result : null;
    if (format === 'html' && !report) return;
    try {
      const content = format === 'html'
        ? renderHtmlReportV2(report!)
        : pairs.length === 1 && lastBatchIds.length === 1 && lastBatchIds[0] === pairs[0].id && pairs[0].result
          ? serializeReportV2(pairs[0].result)
          : serializeBatchReport(batchJobs);
      if (!batchReportFits(content)) {
        setExportMessage(format === 'json'
          ? 'The batch JSON exceeds the 64 MiB report limit. Save fewer completed pairs at once.'
          : 'The HTML report exceeds the 64 MiB save limit.');
        return;
      }
      const stem = format === 'html'
        ? `${report!.documents.before.name}-vs-${report!.documents.after.name}`
        : `docdiff-${batchJobs.length}-comparison-results`;
      const response = await window.docDiffDesktop.saveReport({ format, fileName: stem, content });
      setExportMessage(response.ok ? 'Report saved.' : response.canceled ? '' : response.message);
    } catch {
      setExportMessage('The report could not be prepared or saved.');
    }
  };

  const clearWorkspace = () => {
    if (isWorking) return;
    runToken.current += 1;
    stopCurrentTask();
    setPairs([newPair(1)]);
    setSelectedPairId('pair-1');
    setLastBatchIds([]);
    setOptions({ ...DEFAULT_OPTIONS, ocr: { ...DEFAULT_OPTIONS.ocr } });
    setRun({ kind: 'idle' });
    setExportMessage('');
    setBatchError('');
    setSelectedIndex(0);
  };

  const statusMessage = run.kind === 'working'
    ? run.phase
    : run.kind === 'cancelled'
      ? 'Batch cancelled. Completed pair results remain available.'
      : run.kind === 'done'
        ? `Batch finished · ${batchCounts.succeeded} succeeded · ${batchCounts.failed} failed · ${batchCounts.cancelled} cancelled · ${batchCounts.notRun} not run.`
        : 'Choose matching PDFs or DOCX files to compare locally.';
  return (
    <div className="app-shell v2-shell">
      <header className="topbar">
        <div className="brand" aria-label="DocDiff Studio"><span className="brand-mark" aria-hidden="true"><i /><i /><i /></span><span><strong>DocDiff</strong><small>STUDIO</small></span></div>
        <div className="topbar-actions">
          {result && <span className={`result-pill result-${result.outcome}`}><span className="status-dot" />{result.outcome === 'identical' ? 'No differences found' : result.outcome === 'uncertain' || result.certainty === 'incomplete' ? 'Review needed' : 'Differences found'}</span>}
          <button className="button button-quiet" type="button" onClick={clearWorkspace} disabled={isWorking}>Clear workspace</button>
        </div>
      </header>

      <section className="batch-toolbar" aria-label="Comparison batch">
        <div className="batch-heading">
          <div><p className="eyebrow">LOCAL DOCUMENT REVIEW</p><h1>Compare revision pairs</h1><p>Pair each original with its revision. Comparisons run one at a time and stay on this device.</p></div>
          <div className="batch-actions">
            <button className="button button-quiet" type="button" onClick={addPair} disabled={isWorking || pairs.length >= MAX_BATCH_PAIRS}>＋ Add pair</button>
            {isWorking ? <button className="button button-cancel" type="button" onClick={cancelBatch}>Cancel batch</button> : <button className="button button-primary" type="button" onClick={() => void startBatch()}>⌕ Compare {pairs.filter(isPairReady).length > 1 ? 'all pairs' : 'pair'}</button>}
            <button className="button button-quiet" type="button" disabled={!result || isWorking} onClick={() => void saveReport('html')}>Save selected HTML</button>
            <button className="button button-quiet" type="button" disabled={!batchJobs.length || isWorking} onClick={() => void saveReport('json')}>Save batch JSON</button>
          </div>
        </div>
        <div className="batch-pairs">
          {pairs.map((pair, index) => (
            <section className={`batch-pair ${selectedPairId === pair.id ? 'batch-pair-selected' : ''}`} key={pair.id} aria-label={`Pair ${index + 1}`}>
              <button type="button" className="pair-select" aria-pressed={selectedPairId === pair.id} onClick={() => { setSelectedPairId(pair.id); setSelectedIndex(0); }} disabled={isWorking}>
                <span>Pair {index + 1}</span><PairStateLabel pair={pair} />
              </button>
              <label className={`pair-file ${pair.before ? 'has-file' : ''}`}>
                <span>BEFORE</span><strong title={pair.before?.name}>{pair.before?.name ?? 'Choose original PDF or DOCX'}</strong><small>{pair.before ? `${formatName(detectFormat(pair.before) ?? undefined)} · ${formatBytes(pair.before.size)}` : 'Browse files'}</small>
                <input type="file" accept={ACCEPTED_FILES} disabled={isWorking} aria-label={`Pair ${index + 1} before document`} onChange={(event) => { setFile(pair.id, 'before', event.currentTarget.files?.[0]); event.currentTarget.value = ''; }} />
              </label>
              <span className="pair-arrow" aria-hidden="true">→</span>
              <label className={`pair-file ${pair.after ? 'has-file' : ''}`}>
                <span>AFTER</span><strong title={pair.after?.name}>{pair.after?.name ?? 'Choose revised PDF or DOCX'}</strong><small>{pair.after ? `${formatName(detectFormat(pair.after) ?? undefined)} · ${formatBytes(pair.after.size)}` : 'Browse files'}</small>
                <input type="file" accept={ACCEPTED_FILES} disabled={isWorking} aria-label={`Pair ${index + 1} after document`} onChange={(event) => { setFile(pair.id, 'after', event.currentTarget.files?.[0]); event.currentTarget.value = ''; }} />
              </label>
              <div className="pair-trailing">
                {(pair.before || pair.after) && pair.before && pair.after && detectFormat(pair.before) !== detectFormat(pair.after) ? <span className="format-warning" role="status">PDF and DOCX files cannot be paired.</span> : null}
                {pair.error && <span className="pair-error" title={pair.error.message}>{pair.error.code}: {pair.error.message}</span>}
                {pairs.length > 1 && <button className="icon-button remove-pair" type="button" aria-label={`Remove pair ${index + 1}`} disabled={isWorking} onClick={() => removePair(pair.id)}>×</button>}
              </div>
            </section>
          ))}
        </div>
        <div className="batch-options-row">
          <OptionsPanel options={options} setOptions={setOptions} disabled={isWorking} pageInputInvalid={invalidPageSelection} onPageInputValidity={setPageInputInvalid} />
          <span className="batch-limit-note">Up to {MAX_BATCH_PAIRS} pairs · {formatBytes(COMPARISON_LIMITS.maxInputBytesPerDocument)} per file · processed sequentially</span>
        </div>
      </section>

      <div className="status-strip" aria-live="polite" aria-atomic="true">
        {run.kind === 'working' ? <><span className="spinner" aria-hidden="true" /><span>{statusMessage}</span>{run.total > 0 && <progress value={run.completed} max={run.total} aria-label="Batch comparison progress" />}</>
          : run.kind === 'cancelled' ? <><span className="status-symbol muted-symbol" aria-hidden="true">Ⅱ</span><span>{statusMessage}</span></>
            : run.kind === 'done' ? <><span className="status-symbol ok-symbol" aria-hidden="true">✓</span><span>{statusMessage}</span></>
              : <><span className="status-symbol muted-symbol" aria-hidden="true">i</span><span>{statusMessage}</span></>}
        {exportMessage && <span className="export-status" role="status">{exportMessage}</span>}
      </div>
      {batchError && <p className="batch-error-banner" role="alert">{batchError}</p>}
      {optionsChanged && <div className="options-outdated" role="status">Settings changed after this comparison. Compare again to apply them. Saved reports contain the completed run’s settings.</div>}

      {result?.warnings.length ? <section className="warning-banner" role="status" aria-label="Comparison warnings"><strong>Review notes</strong><ul>{result.warnings.map((warning, index) => <li key={`${index}-${warning}`}>{warning}</li>)}</ul></section> : null}

      <div className="workspace" id="workspace">
        <aside className="change-sidebar" aria-label="Document changes">
          <div className="sidebar-heading"><div><h2>{result?.documents.before.format === 'docx' ? 'Content changes' : 'Page changes'}</h2><span className="change-count">{changeIndices.length}</span></div>{result && <button className="icon-button" type="button" title="Show all units" aria-label={showAllRows ? 'Show changes only' : 'Show all units'} onClick={() => setShowAllRows((value) => !value)}>{showAllRows ? '≠' : '☷'}</button>}</div>
          {result ? <>
            <div className="sidebar-summary" aria-label="Comparison summary"><span><b>{result.summary.changed}</b> changed</span><span><b>{result.summary.added}</b> added</span><span><b>{result.summary.removed}</b> removed</span>{result.summary.moved > 0 && <span><b>{result.summary.moved}</b> moved</span>}</div>
            <div className="change-list" role="region" aria-label={showAllRows ? 'All document units' : 'Changed document units'}>
              {visibleIndices.map((index) => {
                const row = rows[index];
                const selected = index === selectedIndex;
                return <button className={`change-item ${selected ? 'selected' : ''}`} key={row.id} type="button" aria-current={selected ? 'page' : undefined} aria-label={`${statusLabel(row.status)}: ${locationLabel(row.beforeLocation)} to ${locationLabel(row.afterLocation)}`} onClick={() => selectRow(index)} ref={(node) => { rowButtons.current[index] = node; }}>
                  <span className={`change-indicator indicator-${row.status}`} aria-hidden="true">{row.status === 'added' ? '+' : row.status === 'removed' ? '−' : row.status === 'moved' ? '↗' : row.status === 'changed' ? '↔' : '✓'}</span>
                  <span className="change-item-copy"><strong>{locationLabel(row.beforeLocation)} <span aria-hidden="true">→</span> {locationLabel(row.afterLocation)}</strong><small>{statusLabel(row.status)}{row.visual && row.visual.changedPixels > 0 ? ' · visual change' : ''}</small></span><span className="list-chevron" aria-hidden="true">›</span>
                </button>;
              })}
              {visibleIndices.length === 0 && <div className="list-empty"><span aria-hidden="true">✓</span><p>No content changes were found.</p><small>Use the list control to show every compared unit.</small></div>}
            </div>
            <div className="sidebar-footer"><button className="button button-quiet button-small" type="button" onClick={() => moveToChange(-1)} disabled={!changeIndices.length}>↑ Previous change</button><button className="button button-quiet button-small" type="button" onClick={() => moveToChange(1)} disabled={!changeIndices.length}>↓ Next change</button><small>Keyboard: Alt + ↑ / ↓</small></div>
          </> : <div className="sidebar-empty"><span className="empty-stack" aria-hidden="true"><i /><i /><i /></span><h3>Your review list</h3><p>Page changes, paragraph edits and moved blocks will appear here after comparison.</p></div>}
        </aside>

        <main className="review-canvas" aria-label="Document comparison" aria-busy={isWorking}>
          {!result ? <section className="welcome-card v2-welcome">
            <div className="welcome-art" aria-hidden="true"><span className="art-page page-left"><i /><i /><i /><b>−</b></span><span className="art-page page-right"><i /><i /><i /><b>+</b></span><span className="art-spark">✦</span></div>
            <p className="eyebrow">PRIVATE · OFFLINE REVIEW</p><h2>See what changed,<br />unit by unit.</h2>
            <p className="welcome-copy">Compare matching PDF or DOCX files. PDF reviews include page images; DOCX reviews follow paragraphs and table rows without guessing page layout.</p>
            <div className="welcome-steps"><span><b>1</b> Pair revisions</span><span><b>2</b> Compare locally</span><span><b>3</b> Review evidence</span></div>
            <div className="empty-feature-grid"><span>PDF · text + visual review</span><span>DOCX · paragraphs + tables</span><span>Optional local English OCR</span></div>
          </section> : rows.length === 0 ? <section className="welcome-card compact-empty"><span className="large-check" aria-hidden="true">✓</span><p className="eyebrow">COMPARISON COMPLETE</p><h2>No matching units</h2><p className="welcome-copy">No document units were returned. Review the notes above before treating the result as complete.</p></section> : selectedRow ? <>
            <div className="review-heading">
              <div><p className="eyebrow">{result.documents.before.format === 'docx' ? 'DOCX CONTENT REVIEW' : 'PDF PAGE REVIEW'}</p><h2>{locationLabel(selectedRow.beforeLocation)} <span aria-hidden="true">→</span> {locationLabel(selectedRow.afterLocation)}</h2></div>
              <div className="review-controls"><span className={`change-tag tag-${selectedRow.status}`}>{statusLabel(selectedRow.status)}</span>
                {result.documents.before.format === 'pdf' && <div className="segmented-control" role="group" aria-label="Page preview layout"><button type="button" className={displayMode === 'side-by-side' ? 'active' : ''} aria-pressed={displayMode === 'side-by-side'} onClick={() => setDisplayMode('side-by-side')}>Side by side</button><button type="button" className={displayMode === 'overlay' ? 'active' : ''} aria-pressed={displayMode === 'overlay'} onClick={() => setDisplayMode('overlay')}>Overlay</button></div>}
              </div>
            </div>
            {result.certainty === 'incomplete' && <div className="certainty-warning" role="status"><strong>Incomplete evidence.</strong> Some content was not fully verified. Review the notes and source evidence before relying on this comparison.</div>}
            {displayMode === 'overlay' && result.documents.before.format === 'pdf' ? <section className="overlay-card" aria-label="Overlaid page previews">
              <div className="overlay-labels"><span>Before · {locationLabel(selectedRow.beforeLocation)}</span><span>After · {locationLabel(selectedRow.afterLocation)}</span></div>
              {safeImageSource(selectedRow.beforeImageDataUrl) && safeImageSource(selectedRow.afterImageDataUrl) ? <div className="overlay-stage"><img src={safeImageSource(selectedRow.beforeImageDataUrl)!} alt={`Before ${locationLabel(selectedRow.beforeLocation)}`} /><img src={safeImageSource(selectedRow.afterImageDataUrl)!} alt={`After ${locationLabel(selectedRow.afterLocation)}, overlaid`} /></div> : <div className="page-placeholder"><p>Overlay needs a page image from both documents.</p><p>Choose “Side by side” to review available images and text.</p></div>}
              <p className="overlay-note">The page images are blended at equal opacity. Compare text and labels in side-by-side mode.</p>
            </section> : <div className="page-grid">
              <TextSourceCard title={`Before · ${result.documents.before.name}`} location={selectedRow.beforeLocation} image={selectedRow.beforeImageDataUrl} text={selectedRow.beforeText} format={result.documents.before.format} />
              <TextSourceCard title={`After · ${result.documents.after.name}`} location={selectedRow.afterLocation} image={selectedRow.afterImageDataUrl} text={selectedRow.afterText} format={result.documents.after.format} />
            </div>}
            {selectedRow.visual && <div className="visual-summary"><span className="visual-swatch" aria-hidden="true" /><span><strong>Visual difference</strong> · {selectedRow.visual.changedPixels.toLocaleString()} changed pixels ({(selectedRow.visual.ratio * 100).toFixed(2)}%)</span>{safeImageSource(selectedRow.visual.diffImageDataUrl) && <details><summary>View pixel difference</summary><img src={safeImageSource(selectedRow.visual.diffImageDataUrl)!} alt="Pixels that differ between the two pages" /></details>}</div>}
            <section className="text-change-panel" aria-labelledby="text-change-title"><div className="text-panel-heading"><div><p className="eyebrow">TEXT EVIDENCE</p><h3 id="text-change-title">What changed in this unit</h3></div><div className="legend"><span><i className="legend-removed" />Removed</span><span><i className="legend-added" />Added</span></div></div>
              <div className="evidence-source-row"><EvidenceLabel side="Before" source={selectedRow.textEvidence.before.source} confidence={selectedRow.textEvidence.before.confidence} /><EvidenceLabel side="After" source={selectedRow.textEvidence.after.source} confidence={selectedRow.textEvidence.after.confidence} /></div>
              {selectedRow.textEvidence.before.source === 'ocr' && selectedRow.textEvidence.before.confidence !== undefined && selectedRow.textEvidence.before.confidence < result.options.ocr.minimumConfidence || selectedRow.textEvidence.after.source === 'ocr' && selectedRow.textEvidence.after.confidence !== undefined && selectedRow.textEvidence.after.confidence < result.options.ocr.minimumConfidence
                ? <p className="uncertain-note">OCR confidence is below the selected threshold. Treat this extracted text as uncertain and inspect the page image.</p>
                : null}
              {selectedRow.changes.length === 0 && !selectedRow.beforeText && !selectedRow.afterText ? <p className="uncertain-note">No text was extracted from one or both units. Review the original content above.</p> : <ChangeText row={selectedRow} />}
            </section>
            <ChangeDetails row={selectedRow} />
            <div className="page-position">Unit {selectedIndex + 1} of {rows.length}{selectedRow.moveId && <span> · Move pair {selectedRow.moveId}</span>}</div>
          </> : null}
        </main>
      </div>
      <footer className="app-footer"><span>DocDiff Studio</span><span>Files stay on this device</span><span>{completedPairs.length} completed pair{completedPairs.length === 1 ? '' : 's'}</span></footer>
    </div>
  );
}
