import { COMPARISON_LIMITS } from './limits';
import { CompareError, type ComparisonResultV2, type ComparisonRowV2, type DocumentLocationV2, type TextChange, type TextEvidenceV2 } from './types';
import { sanitizeDocumentName, validateOptions } from './validation';

const OUTPUT_LIMIT = COMPARISON_LIMITS.maxSerializedReportBytes;
const MAX_V2_ROWS = COMPARISON_LIMITS.maxDocxBlocks * 2;
const imagePattern = /^data:image\/(?:png|jpeg);base64,[a-z0-9+/]*={0,2}$/iu;

/** Serialize only the public v2 projection; byte inputs and unknown fields are omitted. */
export function serializeReportV2(result: ComparisonResultV2): string {
  const safe = projectResultV2(result);
  const builder = new BoundedBuilder();
  builder.append('{"schemaVersion":2,"documents":');
  builder.append(JSON.stringify(safe.documents));
  builder.append(',"options":');
  builder.append(JSON.stringify(safe.options));
  builder.append(',"rows":[');
  safe.rows.forEach((row, index) => {
    if (index) builder.append(',');
    builder.append(JSON.stringify(row));
  });
  builder.append('],"summary":');
  builder.append(JSON.stringify(safe.summary));
  builder.append(',"warnings":');
  builder.append(JSON.stringify(safe.warnings));
  builder.append(',"outcome":');
  builder.append(JSON.stringify(safe.outcome));
  builder.append(',"certainty":');
  builder.append(JSON.stringify(safe.certainty));
  builder.append('}');
  return builder.finish();
}

/** Self-contained escaped HTML for a schema-2 result. */
export function renderHtmlReportV2(result: ComparisonResultV2): string {
  const safe = projectResultV2(result);
  const builder = new BoundedBuilder();
  const headline = safe.outcome === 'identical'
    ? 'No differences found'
    : safe.outcome === 'uncertain' ? 'Review required: evidence is incomplete' : 'Differences found';
  builder.append(`<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>DocDiff Studio v2 report</title>
<style>:root{color-scheme:light;--ink:#183049;--navy:#20344d;--paper:#fff;--workspace:#edf3f9;--add:#076d58;--remove:#ad2942;--line:#cbd7e3}*{box-sizing:border-box}body{margin:0;background:var(--workspace);color:var(--ink);font:15px/1.55 Segoe UI,system-ui,sans-serif}header{background:var(--navy);color:#fff;padding:24px clamp(18px,5vw,56px)}main{max-width:1280px;margin:auto;padding:28px clamp(16px,4vw,48px) 64px}h1{font-size:28px;margin:0 0 8px}h2{font-size:20px;margin:0 0 14px}.meta,.summary,.warnings,.row{background:var(--paper);border:1px solid var(--line);border-radius:10px;padding:16px}.meta{display:grid;grid-template-columns:1fr 1fr;gap:12px;margin:18px 0}.summary,.row{margin:16px 0}.row-head{display:flex;gap:12px;align-items:center;justify-content:space-between}.badge{font-weight:700;text-transform:capitalize}.moved{color:#5844a1}.columns{display:grid;grid-template-columns:1fr 1fr;gap:14px}.column{min-width:0}.page-image{display:block;max-width:100%;max-height:760px;object-fit:contain}.text{white-space:pre-wrap;overflow-wrap:anywhere;max-height:480px;overflow:auto;background:#f7f9fb;padding:12px}.changes{white-space:pre-wrap;overflow-wrap:anywhere}.visual{margin-top:14px}.cell{margin:8px 0;padding:8px;border-left:3px solid var(--line)}.warning{border-left:5px solid #c07a00;margin:18px 0;padding:16px;background:#fff}.evidence{font-size:12px;color:#40566b}@media(max-width:760px){.columns,.meta{grid-template-columns:1fr}}</style></head>
<body><header><h1>DocDiff Studio comparison</h1><div>${escapeHtml(headline)}</div></header><main>
<section class="meta"><div><strong>Before</strong><br>${escapeHtml(safe.documents.before.name)}<br><small>${escapeHtml(safe.documents.before.sha256)} · ${safe.documents.before.unitCount} ${safe.documents.before.unitKind}${safe.documents.before.unitCount === 1 ? '' : 's'}</small></div><div><strong>After</strong><br>${escapeHtml(safe.documents.after.name)}<br><small>${escapeHtml(safe.documents.after.sha256)} · ${safe.documents.after.unitCount} ${safe.documents.after.unitKind}${safe.documents.after.unitCount === 1 ? '' : 's'}</small></div></section>
<section class="summary"><h2>Summary</h2><p>${safe.summary.unchanged} unchanged · ${safe.summary.changed} changed · ${safe.summary.added} added · ${safe.summary.removed} removed · ${safe.summary.moved} moved</p><p>${safe.documents.before.format === 'docx' ? 'DOCX locations identify logical paragraphs and table rows, not physical pages.' : 'PDF locations identify physical pages.'}</p><p>OCR confidence is an engine estimate, not a probability or correctness guarantee.</p></section>`);
  if (safe.warnings.length) {
    builder.append('<section class="warning"><h2>Review notes</h2><ul>');
    for (const warning of safe.warnings) builder.append(`<li>${escapeHtml(warning)}</li>`);
    builder.append('</ul></section>');
  }
  for (const row of safe.rows) builder.append(renderRow(row));
  builder.append('<footer><small>Generated locally by DocDiff Studio · JSON schema version 2</small></footer></main></body></html>');
  return builder.finish();
}

/** Gate completion on both versioned output formats fitting the same cap. */
export function preflightReportOutputsV2(result: ComparisonResultV2, onPassed?: () => void): void {
  serializeReportV2(result);
  renderHtmlReportV2(result);
  onPassed?.();
}

function projectResultV2(result: ComparisonResultV2): ComparisonResultV2 {
  if (!result || typeof result !== 'object' || result.schemaVersion !== 2 || !Array.isArray(result.rows)
    || result.rows.length > MAX_V2_ROWS) throw invalidReport();
  const images = { characters: 0 };
  const textBudget = { characters: 0 };
  const projectDocument = (document: ComparisonResultV2['documents']['before']): ComparisonResultV2['documents']['before'] => {
    if (!document || (document.format !== 'pdf' && document.format !== 'docx')) throw invalidReport();
    const unitKind = document.format === 'pdf' ? 'pdf-page' : 'docx-block';
    if (document.unitKind !== unitKind) throw invalidReport();
    return {
      name: sanitizeDocumentName(typeof document.name === 'string' ? document.name : 'Untitled document'),
      format: document.format,
      sha256: typeof document.sha256 === 'string' && /^[a-f0-9]{64}$/iu.test(document.sha256) ? document.sha256.toLowerCase() : '',
      unitKind,
      unitCount: safeCount(document.unitCount, unitKind === 'pdf-page' ? COMPARISON_LIMITS.maxPagesPerDocument : COMPARISON_LIMITS.maxDocxBlocks),
      ...(document.format === 'pdf' ? { physicalPageCount: safeCount(document.physicalPageCount, COMPARISON_LIMITS.maxPagesPerDocument) } : {}),
    };
  };
  const documents = { before: projectDocument(result.documents?.before), after: projectDocument(result.documents?.after) };
  const baseOptions = validateOptions(result.options);
  if (typeof result.options?.detectMoves !== 'boolean' || !result.options.ocr
    || typeof result.options.ocr.enabled !== 'boolean' || !Array.isArray(result.options.ocr.beforePageIndexes)
    || !Array.isArray(result.options.ocr.afterPageIndexes) || !Number.isFinite(result.options.ocr.minimumConfidence)) throw invalidReport();
  const options = {
    ...baseOptions,
    detectMoves: result.options.detectMoves,
    ocr: {
      enabled: result.options.ocr.enabled,
      beforePageIndexes: result.options.ocr.beforePageIndexes.filter((index) => Number.isSafeInteger(index) && index >= 0 && index < COMPARISON_LIMITS.maxPagesPerDocument),
      afterPageIndexes: result.options.ocr.afterPageIndexes.filter((index) => Number.isSafeInteger(index) && index >= 0 && index < COMPARISON_LIMITS.maxPagesPerDocument),
      minimumConfidence: Math.max(0, Math.min(100, result.options.ocr.minimumConfidence)),
    },
  };
  const rows = result.rows.map((row, index) => {
    if (!row || typeof row !== 'object' || !Array.isArray(row.changes) || row.changes.length > 200_000) throw invalidReport();
    const beforeLocation = projectLocation(row.beforeLocation);
    const afterLocation = projectLocation(row.afterLocation);
    const beforeText = boundedText(row.beforeText, COMPARISON_LIMITS.maxPageTextCharacters, textBudget);
    const afterText = boundedText(row.afterText, COMPARISON_LIMITS.maxPageTextCharacters, textBudget);
    const changes = row.changes.map((change) => ({
      kind: safeEnum(change?.kind, ['equal', 'added', 'removed'], 'equal'),
      text: boundedText(change?.text, COMPARISON_LIMITS.maxTextCharactersTotal, textBudget),
    }));
    const beforeCells = projectCells(row.beforeCells, textBudget);
    const afterCells = projectCells(row.afterCells, textBudget);
    const cellChanges = projectCellChanges(row.cellChanges, textBudget);
    const beforeImageDataUrl = safeImage(row.beforeImageDataUrl, images);
    const afterImageDataUrl = safeImage(row.afterImageDataUrl, images);
    const visual = row.visual && typeof row.visual === 'object' ? {
      diffImageDataUrl: safeImage(row.visual.diffImageDataUrl, images) ?? '',
      changedPixels: safeCount(row.visual.changedPixels, Number.MAX_SAFE_INTEGER),
      totalPixels: safeCount(row.visual.totalPixels, Number.MAX_SAFE_INTEGER),
      ratio: safeRatio(row.visual.ratio),
    } : undefined;
    const evidence = {
      before: projectEvidence(row.textEvidence?.before),
      after: projectEvidence(row.textEvidence?.after),
    };
    const status = safeEnum(row.status, ['unchanged', 'changed', 'added', 'removed', 'moved'], 'changed');
    const moveId = status === 'moved' && typeof row.moveId === 'string' ? row.moveId.slice(0, 120) : undefined;
    if (status === 'moved' && !moveId) throw invalidReport();
    const projected: ComparisonRowV2 = {
      id: typeof row.id === 'string' ? row.id.slice(0, 120) : `unit-${index + 1}`,
      status,
      ...(moveId ? { moveId } : {}),
      beforeLocation,
      afterLocation,
      beforeText,
      afterText,
      changes,
      textEvidence: evidence,
      ...(beforeCells ? { beforeCells } : {}),
      ...(afterCells ? { afterCells } : {}),
      ...(cellChanges ? { cellChanges } : {}),
      ...(beforeImageDataUrl ? { beforeImageDataUrl } : {}),
      ...(afterImageDataUrl ? { afterImageDataUrl } : {}),
      ...(visual ? { visual } : {}),
    };
    return projected;
  });
  if (images.characters > COMPARISON_LIMITS.maxImageOutputCharacters
    || textBudget.characters > COMPARISON_LIMITS.maxTextCharactersTotal * 8) throw outputLimit();
  const summary = {
    unchanged: safeCount(result.summary?.unchanged, MAX_V2_ROWS),
    changed: safeCount(result.summary?.changed, MAX_V2_ROWS),
    added: safeCount(result.summary?.added, MAX_V2_ROWS),
    removed: safeCount(result.summary?.removed, MAX_V2_ROWS),
    moved: safeCount(result.summary?.moved, MAX_V2_ROWS),
  };
  return {
    schemaVersion: 2,
    documents,
    options,
    rows,
    summary,
    warnings: Array.isArray(result.warnings) ? result.warnings.slice(0, 100).map((value) => boundedText(value, 4_096, textBudget)) : [],
    outcome: safeEnum(result.outcome, ['identical', 'changed', 'uncertain'], 'uncertain'),
    certainty: safeEnum(result.certainty, ['complete', 'incomplete'], 'incomplete'),
  };
}

function projectLocation(value: DocumentLocationV2 | null): DocumentLocationV2 | null {
  if (value === null) return null;
  if (!value || typeof value !== 'object' || !Number.isSafeInteger(value.index) || value.index < 0) throw invalidReport();
  if (value.format === 'pdf' && value.kind === 'page' && value.index < COMPARISON_LIMITS.maxPagesPerDocument) {
    return { format: 'pdf', kind: 'page', index: value.index };
  }
  if (value.format === 'docx' && value.index < COMPARISON_LIMITS.maxDocxBlocks && value.kind === 'paragraph') {
    return { format: 'docx', kind: 'paragraph', index: value.index };
  }
  if (value.format === 'docx' && value.index < COMPARISON_LIMITS.maxDocxBlocks && value.kind === 'table-row'
    && Number.isSafeInteger(value.tableIndex) && value.tableIndex >= 0 && value.tableIndex < COMPARISON_LIMITS.maxDocxBlocks
    && Number.isSafeInteger(value.rowIndex) && value.rowIndex >= 0 && value.rowIndex < COMPARISON_LIMITS.maxDocxBlocks) {
    return { format: 'docx', kind: 'table-row', index: value.index, tableIndex: value.tableIndex, rowIndex: value.rowIndex };
  }
  throw invalidReport();
}

function projectEvidence(value: TextEvidenceV2 | undefined): TextEvidenceV2 {
  if (!value || !['pdf-text', 'docx-xml', 'ocr', 'none'].includes(value.source)) throw invalidReport();
  const confidence = typeof value.confidence === 'number' && Number.isFinite(value.confidence)
    ? Math.max(0, Math.min(100, value.confidence))
    : undefined;
  return { source: value.source, ...(confidence === undefined ? {} : { confidence }) };
}

function projectCells(value: string[] | undefined, budget: { characters: number }): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length > 100_000) throw outputLimit();
  return value.map((cell) => boundedText(cell, COMPARISON_LIMITS.maxPageTextCharacters, budget));
}

function projectCellChanges(value: ComparisonRowV2['cellChanges'], budget: { characters: number }): ComparisonRowV2['cellChanges'] {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length > 100_000) throw outputLimit();
  return value.map((cell) => {
    if (!cell || (cell.beforeCellIndex !== null && (!Number.isSafeInteger(cell.beforeCellIndex) || cell.beforeCellIndex < 0))
      || (cell.afterCellIndex !== null && (!Number.isSafeInteger(cell.afterCellIndex) || cell.afterCellIndex < 0))
      || !Array.isArray(cell.changes) || cell.changes.length > 200_000) throw invalidReport();
    return {
      beforeCellIndex: cell.beforeCellIndex,
      afterCellIndex: cell.afterCellIndex,
      changes: cell.changes.map((change) => ({ kind: safeEnum(change?.kind, ['equal', 'added', 'removed'], 'equal'), text: boundedText(change?.text, COMPARISON_LIMITS.maxTextCharactersTotal, budget) })),
    };
  });
}

function safeImage(value: unknown, total: { characters: number }): string | undefined {
  if (typeof value !== 'string' || value.length > COMPARISON_LIMITS.maxImageOutputCharacters || !imagePattern.test(value)) return undefined;
  total.characters += value.length;
  return value;
}

function boundedText(value: unknown, limit: number, total: { characters: number }): string {
  if (typeof value !== 'string') return '';
  if (value.length > limit) throw outputLimit();
  total.characters += value.length;
  return value;
}

function safeCount(value: unknown, maximum: number): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0 || value > maximum) throw invalidReport();
  return value;
}

function safeRatio(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 0;
}

function safeEnum<T extends string>(value: unknown, choices: readonly T[], fallback: T): T {
  return typeof value === 'string' && choices.includes(value as T) ? value as T : fallback;
}

function renderRow(row: ComparisonRowV2): string {
  const beforeLabel = locationLabel(row.beforeLocation);
  const afterLabel = locationLabel(row.afterLocation);
  const image = (src: string | undefined, alt: string) => src ? `<img class="page-image" alt="${escapeHtml(alt)}" src="${src}">` : '';
  const changes = row.changes.map((change) => `<span class="${change.kind}">${escapeHtml(change.text)}</span>`).join('');
  const addedCellIndexes = new Set<number>();
  const removedCellIndexes = new Set<number>();
  for (const cell of row.cellChanges ?? []) {
    if (cell.beforeCellIndex === null && cell.afterCellIndex !== null) addedCellIndexes.add(cell.afterCellIndex);
    if (cell.afterCellIndex === null && cell.beforeCellIndex !== null) removedCellIndexes.add(cell.beforeCellIndex);
  }
  const cells = (side: 'before' | 'after', values: string[] | undefined) => values
    ? `<section><h3>${escapeHtml(side === 'before' ? 'Before' : 'After')} cells</h3>${values.map((cell, index) => {
      const label = side === 'after' && addedCellIndexes.has(index)
        ? `Added · after position ${index + 1}`
        : side === 'before' && removedCellIndexes.has(index)
          ? `Removed · before position ${index + 1}`
          : `Cell ${index + 1}`;
      return `<div class="cell"><strong>${escapeHtml(label)}</strong><div>${escapeHtml(cell.trim() ? cell : 'Empty cell')}</div></div>`;
    }).join('')}</section>`
    : '';
  const visual = row.visual?.diffImageDataUrl
    ? `<section class="visual"><h3>Visual difference</h3><p>${row.visual.changedPixels} of ${row.visual.totalPixels} pixels changed (${(row.visual.ratio * 100).toFixed(2)}%).</p>${image(row.visual.diffImageDataUrl, 'Visual difference overlay')}</section>`
    : '';
  const evidence = (side: 'before' | 'after') => {
    const item = row.textEvidence[side];
    return `${side}: ${item.source}${item.confidence === undefined ? '' : ` · OCR confidence estimate ${item.confidence.toFixed(1)}/100`}`;
  };
  return `<article class="row"><div class="row-head"><h2>${escapeHtml(row.status)} block</h2><span>${escapeHtml(beforeLabel)} → ${escapeHtml(afterLabel)}</span></div><p class="evidence">${escapeHtml(evidence('before'))} · ${escapeHtml(evidence('after'))}</p><div class="columns"><section class="column"><h3>Before</h3>${image(row.beforeImageDataUrl, 'Before PDF page')}<pre class="text">${escapeHtml(row.beforeText)}</pre>${cells('before', row.beforeCells)}</section><section class="column"><h3>After</h3>${image(row.afterImageDataUrl, 'After PDF page')}<pre class="text">${escapeHtml(row.afterText)}</pre>${cells('after', row.afterCells)}</section></div><section><h3>Text changes</h3><div class="changes">${changes}</div></section>${visual}</article>`;
}

function locationLabel(location: DocumentLocationV2 | null): string {
  if (!location) return 'No corresponding unit';
  if (location.kind === 'page') return `Page ${location.index + 1}`;
  if (location.kind === 'paragraph') return `Paragraph ${location.index + 1}`;
  return `Table ${location.tableIndex + 1}, row ${location.rowIndex + 1}`;
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/gu, (character) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[character] ?? character);
}

class BoundedBuilder {
  private readonly parts: string[] = [];
  private bytes = 0;
  private readonly encoder = new TextEncoder();

  append(value: string): void {
    const size = this.encoder.encode(value).byteLength;
    if (this.bytes + size > OUTPUT_LIMIT) throw outputLimit();
    this.bytes += size;
    this.parts.push(value);
  }

  finish(): string {
    return this.parts.join('');
  }
}

function invalidReport(): CompareError {
  return new CompareError('INVALID_INPUT', 'The comparison result cannot be exported.');
}

function outputLimit(): CompareError {
  return new CompareError('OUTPUT_LIMIT_EXCEEDED', 'The report is larger than the supported export limit.');
}
