import type { CompareProgress, ComparisonResult } from '../core/types.js';

export type WorkerResponse =
  | { type: 'progress'; progress: CompareProgress }
  | { type: 'complete'; result: ComparisonResult }
  | { type: 'error'; code: string; message: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (!isRecord(value)) return false;
  try {
    const prototype = Object.getPrototypeOf(value);
    if (prototype === null) return true;
    return Object.getPrototypeOf(prototype) === null &&
      Object.prototype.toString.call(value) === '[object Object]' &&
      Object.prototype.toString.call(prototype) === '[object Object]';
  } catch {
    return false;
  }
}

function isEmptyUint8Array(value: unknown): value is Uint8Array {
  if (!ArrayBuffer.isView(value) || Object.prototype.toString.call(value) !== '[object Uint8Array]') return false;
  const bytes = value as Uint8Array;
  return bytes.BYTES_PER_ELEMENT === 1 && bytes.length === 0 && bytes.byteLength === 0;
}

function hasExactKeys(value: Record<string, unknown>, expected: string[]): boolean {
  const keys = Reflect.ownKeys(value);
  return keys.length === expected.length && expected.every((key) => keys.includes(key));
}

/** The outer worker harness emits this exact one-time ready envelope before app messages. */
export function isReadyHandshake(value: unknown): boolean {
  if (!isPlainRecord(value) || !hasExactKeys(value, ['sourceName', 'targetName', 'action', 'data'])) return false;
  const data = value.data;
  return value.sourceName === 'worker' && value.targetName === 'main' && value.action === 'ready' &&
    isEmptyUint8Array(data);
}

function isComparisonResult(value: unknown): value is ComparisonResult {
  if (!isRecord(value) || value.schemaVersion !== 1 || !Array.isArray(value.rows) || !Array.isArray(value.warnings)) return false;
  if (value.outcome !== 'identical' && value.outcome !== 'changed' && value.outcome !== 'uncertain') return false;
  if (!isRecord(value.documents) || !isRecord(value.documents.before) || !isRecord(value.documents.after)) return false;
  if (!isRecord(value.summary) || !isRecord(value.options)) return false;
  return true;
}

export function isWorkerResponse(value: unknown): value is WorkerResponse {
  if (!isRecord(value)) return false;
  if (value.type === 'progress') {
    const progress = value.progress;
    return isRecord(progress) && typeof progress.phase === 'string' &&
      typeof progress.completed === 'number' && Number.isFinite(progress.completed) && progress.completed >= 0 &&
      typeof progress.total === 'number' && Number.isFinite(progress.total) && progress.total >= 0;
  }
  if (value.type === 'complete') return isComparisonResult(value.result);
  return value.type === 'error' && typeof value.code === 'string' && typeof value.message === 'string';
}
