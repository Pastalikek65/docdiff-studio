import { COMPARISON_LIMITS } from './limits';
import { CompareError, type ComparisonResult, type ComparisonRow, type TextChange } from './types';
import { sanitizeDocumentName } from './validation';

export function serializeReport(result: ComparisonResult): string {
  const safe = projectResult(result);
  const json = JSON.stringify(safe, null, 2);
  assertOutputSize(json);
  return json;
}

/** Gate the engine's completion notification on every supported export fitting. */
export function preflightReportOutputs(result: ComparisonResult, onPassed?: () => void): void {
  serializeReport(result);
  renderHtmlReport(result);
  onPassed?.();
}

export function renderHtmlReport(result: ComparisonResult): string {
  const safe = projectResult(result);
  const statusTitle = safe.outcome === 'uncertain'
    ? 'Review required: text extraction is incomplete'
    : safe.outcome === 'identical' ? 'No differences found' : 'Differences found';
  const rows = safe.rows.map((row, index) => renderRow(row, index)).join('\n');
  const warnings = safe.warnings.length
    ? `<section class="warnings" aria-labelledby="warning-title"><h2 id="warning-title">Review notes</h2><ul>${safe.warnings.map((warning) => `<li>${escapeHtml(warning)}</li>`).join('')}</ul></section>`
    : '';
  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>DocDiff Studio report</title>
<style>
:root{color-scheme:light;--ink:#183049;--navy:#20344d;--paper:#fff;--workspace:#edf3f9;--add:#076d58;--remove:#ad2942;--line:#cbd7e3}*{box-sizing:border-box}body{margin:0;background:var(--workspace);color:var(--ink);font:15px/1.55 Segoe UI,system-ui,sans-serif}header{background:var(--navy);color:#fff;padding:24px clamp(18px,5vw,56px)}main{max-width:1280px;margin:0 auto;padding:28px clamp(16px,4vw,48px) 64px}h1{font-size:28px;margin:0 0 8px}h2{font-size:20px;margin:0 0 14px}h3{font-size:16px;margin:0}.meta{display:grid;grid-template-columns:1fr 1fr;gap:12px;margin:18px 0}.meta div,.summary,.warnings,.row{background:var(--paper);border:1px solid var(--line);border-radius:10px;padding:16px}.summary{margin:18px 0}.counts{display:flex;flex-wrap:wrap;gap:18px}.counts strong{font-variant-numeric:tabular-nums}.row{margin:16px 0}.row-head{display:flex;align-items:center;justify-content:space-between;gap:12px;border-bottom:1px solid var(--line);padding-bottom:12px}.badge{font-weight:700;text-transform:capitalize}.changed{color:#7c5300}.added{color:var(--add)}.removed{color:var(--remove)}.unchanged{color:#53677c}.pages{font-variant-numeric:tabular-nums;color:#40566b}.columns{display:grid;grid-template-columns:1fr 1fr;gap:14px;margin-top:14px}.column{min-width:0}.column h3{margin-bottom:8px}.page-image{display:block;width:100%;height:auto;max-height:760px;object-fit:contain;object-position:top;background:#f6f8fa;border:1px solid var(--line)}pre{white-space:pre-wrap;overflow-wrap:anywhere;max-height:480px;overflow:auto;background:#f7f9fb;border-radius:6px;padding:12px;font:13px/1.5 ui-monospace,Consolas,monospace}.diff-list{white-space:pre-wrap;overflow-wrap:anywhere}.diff-list span{padding:0 1px}.diff-list .added{background:#e3f4ed}.diff-list .removed{background:#fae8ec;text-decoration:line-through}.visual{margin-top:14px}.warnings{border-left:5px solid #c07a00;margin:18px 0}.warnings li{margin:6px 0}.empty{color:#586d82;font-style:italic}@media(max-width:760px){.columns,.meta{grid-template-columns:1fr}.row-head{align-items:flex-start;flex-direction:column}}
</style>
</head>
<body>
<header><h1>DocDiff Studio comparison</h1><div>${escapeHtml(statusTitle)}</div></header>
<main>
<section class="meta" aria-label="Documents"><div><strong>Before</strong><br>${escapeHtml(safe.documents.before.name)}<br><small>${escapeHtml(safe.documents.before.sha256)} · ${safe.documents.before.pageCount} pages</small></div><div><strong>After</strong><br>${escapeHtml(safe.documents.after.name)}<br><small>${escapeHtml(safe.documents.after.sha256)} · ${safe.documents.after.pageCount} pages</small></div></section>
<section class="summary" aria-labelledby="summary-title"><h2 id="summary-title">Summary</h2><div class="counts"><span><strong>${safe.summary.unchanged}</strong> unchanged</span><span><strong>${safe.summary.changed}</strong> changed</span><span><strong>${safe.summary.added}</strong> added</span><span><strong>${safe.summary.removed}</strong> removed</span></div><p>Text and page images are compared separately. Ignored text options do not hide visual differences.</p></section>
${warnings}
<section aria-labelledby="pages-title"><h2 id="pages-title">Page details</h2>${rows || '<p class="empty">No pages to show.</p>'}</section>
<footer><small>Generated locally by DocDiff Studio · JSON schema version ${safe.schemaVersion}</small></footer>
</main>
</body>
</html>`;
  assertOutputSize(html);
  return html;
}

function renderRow(row: ComparisonRow, index: number): string {
  const status = safeEnum(row.status, ['unchanged', 'changed', 'added', 'removed'], 'changed');
  const beforePage = row.beforePage === null ? '—' : String(row.beforePage + 1);
  const afterPage = row.afterPage === null ? '—' : String(row.afterPage + 1);
  const beforeImage = safeImageDataUrl(row.beforeImageDataUrl);
  const afterImage = safeImageDataUrl(row.afterImageDataUrl);
  const diffImage = safeImageDataUrl(row.visual?.diffImageDataUrl);
  const changes = row.changes.map(renderChange).join('') || '<span class="empty">No extracted text differences.</span>';
  const visual = row.visual
    ? `<section class="visual"><h3>Visual difference</h3><p>${row.visual.changedPixels.toLocaleString('en-US')} of ${row.visual.totalPixels.toLocaleString('en-US')} pixels changed (${(row.visual.ratio * 100).toFixed(2)}%).</p>${diffImage ? `<img class="page-image" alt="Visual difference overlay for this page" src="${diffImage}">` : '<p class="empty">Visual image unavailable in this report.</p>'}</section>`
    : '';
  return `<article class="row"><div class="row-head"><h3>Aligned page pair ${index + 1}</h3><span class="badge ${status}">${status}</span><span class="pages">Before page ${beforePage} · After page ${afterPage}</span></div><div class="columns"><section class="column"><h3>Before · page ${beforePage}</h3>${beforeImage ? `<img class="page-image" alt="Before document page ${beforePage}" src="${beforeImage}">` : '<p class="empty">No page on this side.</p>'}<pre>${escapeHtml(row.beforeText)}</pre></section><section class="column"><h3>After · page ${afterPage}</h3>${afterImage ? `<img class="page-image" alt="After document page ${afterPage}" src="${afterImage}">` : '<p class="empty">No page on this side.</p>'}<pre>${escapeHtml(row.afterText)}</pre></section></div><section><h3>Text changes</h3><div class="diff-list">${changes}</div></section>${visual}</article>`;
}

function renderChange(change: TextChange): string {
  const kind = safeEnum(change.kind, ['equal', 'added', 'removed'], 'equal');
  const className = kind === 'equal' ? '' : ` class="${kind}"`;
  return `<span${className}>${escapeHtml(change.text)}</span>`;
}

function projectResult(result: ComparisonResult): ComparisonResult {
  if (!result || typeof result !== 'object' || result.schemaVersion !== 1 || !Array.isArray(result.rows)) {
    throw new CompareError('INVALID_INPUT', 'The comparison result cannot be exported.');
  }
  const documentInfo = (info: ComparisonResult['documents']['before']): ComparisonResult['documents']['before'] => ({
    name: sanitizeDocumentName(typeof info?.name === 'string' ? info.name : 'Untitled document'),
    format: info?.format === 'docx' ? 'docx' : 'pdf',
    sha256: typeof info?.sha256 === 'string' && /^[a-f0-9]{64}$/iu.test(info.sha256) ? info.sha256.toLowerCase() : '',
    pageCount: safeCount(info?.pageCount),
  });
  const rows = result.rows.map((row, index) => {
    if (!row || typeof row !== 'object') throw new CompareError('INVALID_INPUT', 'The comparison result contains an invalid page row.');
    const beforePage = row.beforePage === null ? null : safePageIndex(row.beforePage);
    const afterPage = row.afterPage === null ? null : safePageIndex(row.afterPage);
    const visual = row.visual && typeof row.visual === 'object' ? {
      diffImageDataUrl: safeImageDataUrl(row.visual.diffImageDataUrl) ?? '',
      changedPixels: safeCount(row.visual.changedPixels),
      totalPixels: safeCount(row.visual.totalPixels),
      ratio: safeRatio(row.visual.ratio),
    } : undefined;
    const changes = Array.isArray(row.changes) ? row.changes.map((change) => ({
      kind: safeEnum(change?.kind, ['equal', 'added', 'removed'], 'equal'),
      text: safeText(change?.text),
    })) : [];
    return {
      id: safeText(row.id) || `page-${index + 1}`,
      status: safeEnum(row.status, ['unchanged', 'changed', 'added', 'removed'], 'changed'),
      beforePage,
      afterPage,
      beforeText: safeText(row.beforeText),
      afterText: safeText(row.afterText),
      changes,
      ...(safeImageDataUrl(row.beforeImageDataUrl) ? { beforeImageDataUrl: safeImageDataUrl(row.beforeImageDataUrl) } : {}),
      ...(safeImageDataUrl(row.afterImageDataUrl) ? { afterImageDataUrl: safeImageDataUrl(row.afterImageDataUrl) } : {}),
      ...(visual ? { visual } : {}),
    };
  });
  const summary = {
    unchanged: safeCount(result.summary?.unchanged),
    changed: safeCount(result.summary?.changed),
    added: safeCount(result.summary?.added),
    removed: safeCount(result.summary?.removed),
  };
  const warnings = Array.isArray(result.warnings) ? result.warnings.slice(0, 100).map(safeText) : [];
  const options = result.options;
  if (!options || typeof options.ignoreWhitespace !== 'boolean'
    || !Number.isInteger(options.ignoreHeaderLines) || !Number.isInteger(options.ignoreFooterLines)
    || !Number.isInteger(options.visualThreshold)) {
    throw new CompareError('INVALID_INPUT', 'The comparison result options are invalid.');
  }
  return {
    schemaVersion: 1,
    documents: { before: documentInfo(result.documents?.before), after: documentInfo(result.documents?.after) },
    options: {
      ignoreWhitespace: options.ignoreWhitespace,
      ignoreHeaderLines: Math.max(0, Math.min(100, options.ignoreHeaderLines)),
      ignoreFooterLines: Math.max(0, Math.min(100, options.ignoreFooterLines)),
      visualThreshold: Math.max(0, Math.min(255, options.visualThreshold)),
    },
    rows,
    summary,
    warnings,
    outcome: safeEnum(result.outcome, ['identical', 'changed', 'uncertain'], 'uncertain'),
  };
}

function safeImageDataUrl(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length > COMPARISON_LIMITS.maxImageOutputCharacters) return undefined;
  return /^data:image\/(?:png|jpeg);base64,[a-z0-9+/]*={0,2}$/iu.test(value) ? value : undefined;
}

function safeText(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function safePageIndex(value: unknown): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    throw new CompareError('INVALID_INPUT', 'The comparison result contains an invalid page index.');
  }
  return value;
}

function safeCount(value: unknown): number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

function safeRatio(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 0;
}

function safeEnum<T extends string>(value: unknown, choices: readonly T[], fallback: T): T {
  return typeof value === 'string' && choices.includes(value as T) ? value as T : fallback;
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/gu, (character) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  })[character] ?? character);
}

function assertOutputSize(value: string): void {
  if (new TextEncoder().encode(value).byteLength > COMPARISON_LIMITS.maxSerializedReportBytes) {
    throw new CompareError('OUTPUT_LIMIT_EXCEEDED', 'The report is larger than the supported export limit.');
  }
}
