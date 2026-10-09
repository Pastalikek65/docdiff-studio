import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Dispatch, SetStateAction } from 'react';
import { DEFAULT_COMPARE_OPTIONS, COMPARISON_LIMITS, renderHtmlReport, serializeReport } from '../core/index.js';
import type { CompareOptions, ComparisonResult, ComparisonRow } from '../core/types.js';
import { isReadyHandshake, isWorkerResponse } from './worker-messages.js';

type RunState =
  | { kind: 'idle' }
  | { kind: 'working'; phase: string; completed: number; total: number }
  | { kind: 'done' }
  | { kind: 'cancelled' }
  | { kind: 'failed'; code: string; message: string };

type WorkerRequest = {
  type: 'compare';
  before: { name: string; bytes: ArrayBuffer };
  after: { name: string; bytes: ArrayBuffer };
  options: CompareOptions;
};

type DisplayMode = 'side-by-side' | 'overlay';

const EMPTY_RUN: RunState = { kind: 'idle' };
const PDF_ACCEPT = '.pdf,application/pdf';

function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(0)} MB`;
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

function pageLabel(page: number | null): string {
  return page === null ? 'No matching page' : `Page ${page + 1}`;
}

function statusLabel(status: ComparisonRow['status']): string {
  switch (status) {
    case 'unchanged': return 'Unchanged';
    case 'changed': return 'Changed';
    case 'added': return 'Added';
    case 'removed': return 'Removed';
  }
}

function imageSource(value: string | undefined): string | null {
  if (!value || value.length > COMPARISON_LIMITS.maxImageOutputCharacters) return null;
  return /^data:image\/(?:png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/.test(value) ? value : null;
}

function displayName(file: File | null, side: string): string {
  return file?.name ?? `Choose ${side.toLowerCase()} PDF`;
}

function safeTextPreview(text: string): string {
  return text.length > 15_000 ? `${text.slice(0, 15_000)}\n\nPreview shortened.` : text;
}

function ChangeText({ row }: { row: ComparisonRow }) {
  if (!row.changes.length || row.changes.every((change) => change.kind === 'equal')) {
    if (row.status === 'unchanged') return <p className="no-text-change">No text change detected on this page.</p>;
    return (
      <div className="text-fallback">
        <section><h4>Before text</h4><pre>{safeTextPreview(row.beforeText) || 'No text was extracted from this page.'}</pre></section>
        <section><h4>After text</h4><pre>{safeTextPreview(row.afterText) || 'No text was extracted from this page.'}</pre></section>
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

function PageCard({
  title,
  page,
  source,
  text,
}: {
  title: string;
  page: number | null;
  source: string | null;
  text: string;
}) {
  return (
    <section className="page-card" aria-label={`${title}, ${pageLabel(page)}`}>
      <header className="page-card-heading">
        <span>{title}</span>
        <span className="page-index">{pageLabel(page)}</span>
      </header>
      {source ? (
        <div className="page-image-wrap"><img className="page-image" src={source} alt={`${title}, ${pageLabel(page)} preview`} /></div>
      ) : (
        <div className="page-placeholder">
          <span className="placeholder-icon" aria-hidden="true">▤</span>
          <p>{page === null ? 'This document has no aligned page here.' : 'No page image was produced.'}</p>
          <details><summary>Show extracted text</summary><pre>{safeTextPreview(text) || 'No text was extracted.'}</pre></details>
        </div>
      )}
    </section>
  );
}

function resultLabel(result: ComparisonResult): string {
  if (result.outcome === 'identical') return 'No differences found';
  if (result.outcome === 'uncertain') return 'Review needed';
  return 'Differences found';
}

function ComparisonOptions({
  options,
  setOptions,
  compact = false,
  disabled = false,
}: {
  options: CompareOptions;
  setOptions: Dispatch<SetStateAction<CompareOptions>>;
  compact?: boolean;
  disabled?: boolean;
}) {
  return (
    <details className={`compare-settings ${compact ? 'compact-settings' : ''}`}>
      <summary>Options</summary>
      <div className="settings-grid">
        <label className="option-check"><input type="checkbox" disabled={disabled} checked={options.ignoreWhitespace} onChange={(event) => setOptions((value) => ({ ...value, ignoreWhitespace: event.target.checked }))} /> Ignore whitespace-only text changes</label>
        <label>Ignore first lines on each page<input type="number" disabled={disabled} min={0} max={COMPARISON_LIMITS.maxIgnoredLines} value={options.ignoreHeaderLines} onChange={(event) => setOptions((value) => ({ ...value, ignoreHeaderLines: Math.max(0, Math.min(COMPARISON_LIMITS.maxIgnoredLines, Number(event.target.value) || 0)) }))} /></label>
        <label>Ignore last lines on each page<input type="number" disabled={disabled} min={0} max={COMPARISON_LIMITS.maxIgnoredLines} value={options.ignoreFooterLines} onChange={(event) => setOptions((value) => ({ ...value, ignoreFooterLines: Math.max(0, Math.min(COMPARISON_LIMITS.maxIgnoredLines, Number(event.target.value) || 0)) }))} /></label>
        <label>Visual pixel tolerance <strong>{options.visualThreshold}</strong><input type="range" disabled={disabled} min={0} max={80} value={options.visualThreshold} onChange={(event) => setOptions((value) => ({ ...value, visualThreshold: Number(event.target.value) }))} /></label>
        <p>Text ignore settings do not hide visible page appearance changes.</p>
      </div>
    </details>
  );
}

export default function App() {
  const [beforeFile, setBeforeFile] = useState<File | null>(null);
  const [afterFile, setAfterFile] = useState<File | null>(null);
  const [run, setRun] = useState<RunState>(EMPTY_RUN);
  const [result, setResult] = useState<ComparisonResult | null>(null);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [displayMode, setDisplayMode] = useState<DisplayMode>('side-by-side');
  const [showAllRows, setShowAllRows] = useState(false);
  const [exportMessage, setExportMessage] = useState('');
  const [options, setOptions] = useState<CompareOptions>({ ...DEFAULT_COMPARE_OPTIONS });
  const activeWorker = useRef<Worker | null>(null);
  const activeTimer = useRef<number | null>(null);
  const runToken = useRef(0);
  const rowButtons = useRef<Array<HTMLButtonElement | null>>([]);

  const cancelComparison = useCallback((announce = true) => {
    runToken.current += 1;
    activeWorker.current?.terminate();
    activeWorker.current = null;
    if (activeTimer.current !== null) window.clearTimeout(activeTimer.current);
    activeTimer.current = null;
    if (announce) setRun({ kind: 'cancelled' });
  }, []);

  useEffect(() => () => cancelComparison(false), [cancelComparison]);

  const rows = result?.rows ?? [];
  const changeIndices = useMemo(
    () => rows.flatMap((row, index) => row.status === 'unchanged' ? [] : [index]),
    [rows],
  );
  const selectedRow = rows[selectedIndex] ?? null;
  const optionsChanged = !!result && (
    options.ignoreWhitespace !== result.options.ignoreWhitespace ||
    options.ignoreHeaderLines !== result.options.ignoreHeaderLines ||
    options.ignoreFooterLines !== result.options.ignoreFooterLines ||
    options.visualThreshold !== result.options.visualThreshold
  );
  const visibleIndices = useMemo(
    () => rows.flatMap((row, index) => showAllRows || row.status !== 'unchanged' ? [index] : []),
    [rows, showAllRows],
  );

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
      if (event.altKey && event.key === 'ArrowDown') {
        event.preventDefault();
        moveToChange(1);
      } else if (event.altKey && event.key === 'ArrowUp') {
        event.preventDefault();
        moveToChange(-1);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [moveToChange]);

  const changeFile = (side: 'before' | 'after', file: File | undefined) => {
    cancelComparison(false);
    setResult(null);
    setSelectedIndex(0);
    setExportMessage('');
    if (!file) {
      (side === 'before' ? setBeforeFile : setAfterFile)(null);
      setRun(EMPTY_RUN);
      return;
    }
    if (!file.name.toLowerCase().endsWith('.pdf')) {
      (side === 'before' ? setBeforeFile : setAfterFile)(null);
      setRun({ kind: 'failed', code: 'UNSUPPORTED_FORMAT', message: 'Please choose a PDF file. DOCX comparison is not available in this build.' });
      return;
    }
    if (file.size > COMPARISON_LIMITS.maxInputBytesPerDocument) {
      (side === 'before' ? setBeforeFile : setAfterFile)(null);
      setRun({ kind: 'failed', code: 'INPUT_TOO_LARGE', message: `Each PDF must be ${formatBytes(COMPARISON_LIMITS.maxInputBytesPerDocument)} or smaller.` });
      return;
    }
    (side === 'before' ? setBeforeFile : setAfterFile)(file);
    setRun(EMPTY_RUN);
  };

  const startComparison = async () => {
    if (!beforeFile || !afterFile || run.kind === 'working') return;
    if (beforeFile.size + afterFile.size > COMPARISON_LIMITS.maxCombinedInputBytes) {
      setRun({ kind: 'failed', code: 'INPUT_TOO_LARGE', message: `The two PDFs together must be ${formatBytes(COMPARISON_LIMITS.maxCombinedInputBytes)} or smaller.` });
      return;
    }

    const token = ++runToken.current;
    setResult(null);
    setSelectedIndex(0);
    setExportMessage('');
    setRun({ kind: 'working', phase: 'Reading selected PDFs', completed: 0, total: 0 });
    try {
      const [beforeBytes, afterBytes] = await Promise.all([beforeFile.arrayBuffer(), afterFile.arrayBuffer()]);
      if (token !== runToken.current) return;

      setRun({ kind: 'working', phase: 'Starting comparison', completed: 0, total: 0 });
      const worker = new Worker(new URL('./compare.worker.ts', import.meta.url), { type: 'module', name: 'docdiff-comparison' });
      activeWorker.current = worker;
      activeTimer.current = window.setTimeout(() => {
        if (runToken.current !== token) return;
        runToken.current += 1;
        worker.terminate();
        activeWorker.current = null;
        activeTimer.current = null;
        setRun({ kind: 'failed', code: 'TIME_LIMIT_EXCEEDED', message: 'The comparison took longer than two minutes and was stopped. Try smaller PDFs.' });
      }, COMPARISON_LIMITS.maxWallTimeMs);

      worker.onmessage = (event: MessageEvent<unknown>) => {
        if (runToken.current !== token) return;
        const response = event.data;
        if (isReadyHandshake(response)) return;
        if (!isWorkerResponse(response)) {
          runToken.current += 1;
          if (activeTimer.current !== null) window.clearTimeout(activeTimer.current);
          activeTimer.current = null;
          activeWorker.current = null;
          worker.terminate();
          setRun({ kind: 'failed', code: 'WORKER_FAILED', message: 'The comparison returned an unreadable response. No result was produced.' });
          return;
        }
        const message = response;
        if (message.type === 'progress') {
          setRun({ kind: 'working', phase: message.progress.phase, completed: message.progress.completed, total: message.progress.total });
          return;
        }
        if (activeTimer.current !== null) window.clearTimeout(activeTimer.current);
        activeTimer.current = null;
        activeWorker.current = null;
        worker.terminate();
        if (message.type === 'error') {
          runToken.current += 1;
          setRun(message.code === 'CANCELLED'
            ? { kind: 'cancelled' }
            : { kind: 'failed', code: message.code, message: message.message });
          return;
        }
        runToken.current += 1;
        setResult(message.result);
        const firstChange = message.result.rows.findIndex((row) => row.status !== 'unchanged');
        setSelectedIndex(firstChange >= 0 ? firstChange : 0);
        setRun({ kind: 'done' });
      };
      worker.onerror = () => {
        if (runToken.current !== token) return;
        runToken.current += 1;
        if (activeTimer.current !== null) window.clearTimeout(activeTimer.current);
        activeTimer.current = null;
        activeWorker.current = null;
        worker.terminate();
        setRun({ kind: 'failed', code: 'WORKER_FAILED', message: 'The comparison worker stopped unexpectedly. No result was produced.' });
      };
      worker.onmessageerror = () => {
        if (runToken.current !== token) return;
        runToken.current += 1;
        if (activeTimer.current !== null) window.clearTimeout(activeTimer.current);
        activeTimer.current = null;
        activeWorker.current = null;
        worker.terminate();
        setRun({ kind: 'failed', code: 'WORKER_FAILED', message: 'The comparison result could not be read. No result was produced.' });
      };

      const request: WorkerRequest = {
        type: 'compare',
        before: { name: beforeFile.name, bytes: beforeBytes },
        after: { name: afterFile.name, bytes: afterBytes },
        options,
      };
      worker.postMessage(request, [beforeBytes, afterBytes]);
    } catch (error) {
      if (token !== runToken.current) return;
      runToken.current += 1;
      activeWorker.current?.terminate();
      activeWorker.current = null;
      if (activeTimer.current !== null) window.clearTimeout(activeTimer.current);
      activeTimer.current = null;
      setRun({ kind: 'failed', code: 'FILE_READ_FAILED', message: 'The selected PDFs could not be read or the comparison could not start.' });
    }
  };

  const exportReport = async (format: 'html' | 'json') => {
    if (!result) return;
    setExportMessage('');
    if (!window.docDiffDesktop) {
      setExportMessage('Report saving is unavailable in this browser session. Open the desktop app to save reports.');
      return;
    }
    try {
      const content = format === 'html' ? renderHtmlReport(result) : serializeReport(result);
      const fileName = `${beforeFile?.name ?? result.documents.before.name}-vs-${afterFile?.name ?? result.documents.after.name}`;
      const response = await window.docDiffDesktop.saveReport({ format, fileName, content });
      setExportMessage(response.ok ? 'Report saved.' : response.canceled ? '' : response.message);
    } catch {
      setExportMessage('The report could not be prepared or saved.');
    }
  };

  const clearWorkspace = () => {
    cancelComparison(false);
    setBeforeFile(null);
    setAfterFile(null);
    setResult(null);
    setRun(EMPTY_RUN);
    setExportMessage('');
    setSelectedIndex(0);
  };

  const progressValue = run.kind === 'working' && run.total > 0
    ? Math.min(100, Math.round((run.completed / run.total) * 100))
    : null;
  const canCompare = !!beforeFile && !!afterFile && run.kind !== 'working';
  const statusMessage = run.kind === 'failed'
    ? run.message
    : run.kind === 'cancelled'
      ? 'Comparison cancelled. No result was produced.'
      : run.kind === 'working'
        ? `${run.phase}${progressValue === null ? '…' : `, ${progressValue}%`}`
        : '';

  return (
    <div className="app-shell">
      <header className="topbar">
        <div className="brand" aria-label="DocDiff Studio">
          <span className="brand-mark" aria-hidden="true"><i /><i /><i /></span>
          <span><strong>DocDiff</strong><small>STUDIO</small></span>
        </div>
        <div className="topbar-actions">
          {result && <span className={`result-pill result-${result.outcome}`}><span className="status-dot" />{resultLabel(result)}</span>}
          <button className="button button-quiet" type="button" onClick={clearWorkspace} disabled={run.kind === 'working'}>Clear workspace</button>
        </div>
      </header>

      <section className="import-toolbar" aria-label="Document selection and report actions">
        <div className="file-slot">
          <label className="file-label" htmlFor="before-file">BEFORE</label>
          <label className={`file-picker ${beforeFile ? 'has-file' : ''}`} htmlFor="before-file">
            <span className="file-glyph" aria-hidden="true">↥</span>
            <span className="file-picker-copy"><strong>{displayName(beforeFile, 'Before')}</strong><small>{beforeFile ? formatBytes(beforeFile.size) : 'Select original PDF'}</small></span>
            <span className="picker-action">Browse</span>
          </label>
          <input id="before-file" className="visually-hidden" type="file" accept={PDF_ACCEPT} onChange={(event) => { changeFile('before', event.currentTarget.files?.[0]); event.currentTarget.value = ''; }} />
        </div>
        <span className="compare-arrow" aria-hidden="true">→</span>
        <div className="file-slot">
          <label className="file-label" htmlFor="after-file">AFTER</label>
          <label className={`file-picker ${afterFile ? 'has-file' : ''}`} htmlFor="after-file">
            <span className="file-glyph" aria-hidden="true">↥</span>
            <span className="file-picker-copy"><strong>{displayName(afterFile, 'After')}</strong><small>{afterFile ? formatBytes(afterFile.size) : 'Select revised PDF'}</small></span>
            <span className="picker-action">Browse</span>
          </label>
          <input id="after-file" className="visually-hidden" type="file" accept={PDF_ACCEPT} onChange={(event) => { changeFile('after', event.currentTarget.files?.[0]); event.currentTarget.value = ''; }} />
        </div>
        <div className="toolbar-divider" />
        <div className="toolbar-buttons">
          <button className="button button-primary" type="button" onClick={() => void startComparison()} disabled={!canCompare}>
            <span aria-hidden="true">⌕</span> Compare PDFs
          </button>
          {run.kind === 'working' ? (
            <button className="button button-cancel" type="button" onClick={() => cancelComparison()}>Cancel</button>
          ) : (
            <div className="export-actions">
              <button className="button button-quiet" type="button" disabled={!result} onClick={() => void exportReport('html')}>Save HTML</button>
              <button className="button button-quiet" type="button" disabled={!result} onClick={() => void exportReport('json')}>Save JSON</button>
            </div>
          )}
        </div>
      </section>

      <div className="status-strip" aria-live="polite" aria-atomic="true">
        {run.kind === 'working' ? (
          <><span className="spinner" aria-hidden="true" /><span>{statusMessage}</span>{progressValue !== null && <progress value={progressValue} max={100} aria-label="Comparison progress" />}</>
        ) : run.kind === 'failed' ? (
          <><span className="status-symbol error-symbol" aria-hidden="true">!</span><span><strong>{run.code}</strong> · {run.message}</span></>
        ) : run.kind === 'cancelled' ? (
          <><span className="status-symbol muted-symbol" aria-hidden="true">Ⅱ</span><span>{statusMessage}</span></>
        ) : run.kind === 'done' && result ? (
          <><span className={`status-symbol ${result.outcome === 'identical' ? 'ok-symbol' : 'review-symbol'}`} aria-hidden="true">{result.outcome === 'identical' ? '✓' : '!'}</span><span>{resultLabel(result)} · {result.summary.changed} changed, {result.summary.added} added, {result.summary.removed} removed</span></>
        ) : (
          <><span className="status-symbol muted-symbol" aria-hidden="true">i</span><span>Select a pair of PDFs to review text and page appearance locally.</span></>
        )}
        {exportMessage && <span className="export-status">{exportMessage}</span>}
      </div>

      {result?.warnings.length ? (
        <section className="warning-banner" role="status" aria-label="Comparison warnings">
          <strong>Review notes</strong>
          <ul>{result.warnings.map((warning, index) => <li key={`${index}-${warning}`}>{warning}</li>)}</ul>
        </section>
      ) : null}
      {optionsChanged && <div className="options-outdated" role="status">Settings changed after this comparison. Compare again to apply them. Saved reports include the completed run’s settings.</div>}

      <div className="workspace" id="workspace">
        <aside className="change-sidebar" aria-label="Page changes">
          <div className="sidebar-heading">
            <div><h1>Changes</h1><span className="change-count">{changeIndices.length}</span></div>
            {result && <button className="icon-button" type="button" title="Show all pages" aria-label={showAllRows ? 'Show changes only' : 'Show all pages'} onClick={() => setShowAllRows((value) => !value)}>{showAllRows ? '≠' : '☷'}</button>}
          </div>
          {result ? (
            <>
              <div className="sidebar-summary" aria-label="Comparison summary">
                <span><b>{result.summary.changed}</b> changed</span><span><b>{result.summary.added}</b> added</span><span><b>{result.summary.removed}</b> removed</span>
              </div>
              <div className="change-list" role="region" aria-label={showAllRows ? 'All aligned pages' : 'Changed pages'}>
                {visibleIndices.map((index) => {
                  const row = rows[index];
                  const selected = index === selectedIndex;
                  return (
                    <button
                      className={`change-item ${selected ? 'selected' : ''}`}
                      key={row.id}
                      type="button"
                      aria-current={selected ? 'page' : undefined}
                      aria-label={`${statusLabel(row.status)}: ${pageLabel(row.beforePage)} to ${pageLabel(row.afterPage)}`}
                      onClick={() => selectRow(index)}
                      ref={(node) => { rowButtons.current[index] = node; }}
                    >
                      <span className={`change-indicator indicator-${row.status}`} aria-hidden="true">{row.status === 'added' ? '+' : row.status === 'removed' ? '−' : row.status === 'changed' ? '↔' : '✓'}</span>
                      <span className="change-item-copy"><strong>{pageLabel(row.beforePage)} <span aria-hidden="true">→</span> {pageLabel(row.afterPage)}</strong><small>{statusLabel(row.status)}{row.visual && row.visual.changedPixels > 0 ? ' · visual change' : ''}</small></span>
                      <span className="list-chevron" aria-hidden="true">›</span>
                    </button>
                  );
                })}
                {visibleIndices.length === 0 && <div className="list-empty"><span aria-hidden="true">✓</span><p>No page changes were found.</p><small>Use the list control to show every aligned page.</small></div>}
              </div>
              <div className="sidebar-footer">
                <button className="button button-quiet button-small" type="button" onClick={() => moveToChange(-1)} disabled={!changeIndices.length}>↑ Previous change</button>
                <button className="button button-quiet button-small" type="button" onClick={() => moveToChange(1)} disabled={!changeIndices.length}>↓ Next change</button>
                <small>Keyboard: Alt + ↑ / ↓</small>
              </div>
            </>
          ) : (
            <div className="sidebar-empty">
              <span className="empty-stack" aria-hidden="true"><i /><i /><i /></span>
              <h2>Your review list</h2>
              <p>Page changes will appear here after you compare two PDFs.</p>
            </div>
          )}
        </aside>

        <main className="review-canvas" aria-label="Document comparison" aria-busy={run.kind === 'working'}>
          {!result ? (
            <section className="welcome-card">
              <div className="welcome-art" aria-hidden="true"><span className="art-page page-left"><i /><i /><i /><b>−</b></span><span className="art-page page-right"><i /><i /><i /><b>+</b></span><span className="art-spark">✦</span></div>
              <p className="eyebrow">LOCAL DOCUMENT REVIEW</p>
              <h2 aria-label="See what changed, page by page.">See what changed,<br />page by page.</h2>
              <p className="welcome-copy">Compare text and page appearance side by side. Your PDFs stay on this device.</p>
              <div className="welcome-steps"><span><b>1</b> Choose the original</span><span><b>2</b> Choose the revision</span><span><b>3</b> Review the differences</span></div>
              <ComparisonOptions options={options} setOptions={setOptions} disabled={run.kind === 'working'} />
            </section>
          ) : rows.length === 0 ? (
            <section className="welcome-card compact-empty"><span className="large-check" aria-hidden="true">✓</span><p className="eyebrow">COMPARISON COMPLETE</p><h2>No pages to display</h2><p className="welcome-copy">The documents could not be aligned into page rows. Check the review notes above.</p></section>
          ) : selectedRow ? (
            <>
              <div className="review-heading">
                <div><p className="eyebrow">PAGE REVIEW</p><h2>{pageLabel(selectedRow.beforePage)} <span aria-hidden="true">→</span> {pageLabel(selectedRow.afterPage)}</h2></div>
                <div className="review-controls">
                  <span className={`change-tag tag-${selectedRow.status}`}>{statusLabel(selectedRow.status)}</span>
                  <ComparisonOptions options={options} setOptions={setOptions} compact />
                  <div className="segmented-control" role="group" aria-label="Page preview layout">
                    <button type="button" className={displayMode === 'side-by-side' ? 'active' : ''} aria-pressed={displayMode === 'side-by-side'} onClick={() => setDisplayMode('side-by-side')}>Side by side</button>
                    <button type="button" className={displayMode === 'overlay' ? 'active' : ''} aria-pressed={displayMode === 'overlay'} onClick={() => setDisplayMode('overlay')}>Overlay</button>
                  </div>
                </div>
              </div>
              {displayMode === 'side-by-side' ? (
                <div className="page-grid">
                  <PageCard title={`Before · ${result.documents.before.name}`} page={selectedRow.beforePage} source={imageSource(selectedRow.beforeImageDataUrl)} text={selectedRow.beforeText} />
                  <PageCard title={`After · ${result.documents.after.name}`} page={selectedRow.afterPage} source={imageSource(selectedRow.afterImageDataUrl)} text={selectedRow.afterText} />
                </div>
              ) : (
                <section className="overlay-card" aria-label="Overlaid page previews">
                  <div className="overlay-labels"><span>Before · {pageLabel(selectedRow.beforePage)}</span><span>After · {pageLabel(selectedRow.afterPage)}</span></div>
                  {imageSource(selectedRow.beforeImageDataUrl) && imageSource(selectedRow.afterImageDataUrl) ? (
                    <div className="overlay-stage">
                      <img src={imageSource(selectedRow.beforeImageDataUrl)!} alt={`Before ${pageLabel(selectedRow.beforePage)}`} />
                      <img src={imageSource(selectedRow.afterImageDataUrl)!} alt={`After ${pageLabel(selectedRow.afterPage)}, overlaid`} />
                    </div>
                  ) : (
                    <div className="page-placeholder"><p>Overlay needs an image from both aligned pages.</p><p>Choose “Side by side” to review available page images and text.</p></div>
                  )}
                  <p className="overlay-note">The two page images are blended at equal opacity. Use side by side to inspect text and labels.</p>
                </section>
              )}

              {selectedRow.visual && (
                <div className="visual-summary">
                  <span className="visual-swatch" aria-hidden="true" />
                  <span><strong>Visual difference</strong> · {selectedRow.visual.changedPixels.toLocaleString()} changed pixels ({(selectedRow.visual.ratio * 100).toFixed(2)}%)</span>
                  {imageSource(selectedRow.visual.diffImageDataUrl) && <details><summary>View pixel difference</summary><img src={imageSource(selectedRow.visual.diffImageDataUrl)!} alt="Pixels that differ between the two pages" /></details>}
                </div>
              )}

              <section className="text-change-panel" aria-labelledby="text-change-title">
                <div className="text-panel-heading"><div><p className="eyebrow">TEXT COMPARISON</p><h3 id="text-change-title">What changed in the text</h3></div><div className="legend"><span><i className="legend-removed" />Removed</span><span><i className="legend-added" />Added</span></div></div>
                {selectedRow.changes.length === 0 && !selectedRow.beforeText && !selectedRow.afterText ? (
                  <p className="uncertain-note">No text was extracted from one or both pages. Review the page images for changes.</p>
                ) : <ChangeText row={selectedRow} />}
              </section>
              <div className="page-position">Page row {selectedIndex + 1} of {rows.length}{selectedRow.beforePage !== null && selectedRow.afterPage !== null && <span> · Text and visual results are shown separately.</span>}</div>
            </>
          ) : null}
        </main>
      </div>
      <footer className="app-footer"><span>DocDiff Studio</span><span>Runs locally · No account or upload</span><span>PDF review</span></footer>
    </div>
  );
}
