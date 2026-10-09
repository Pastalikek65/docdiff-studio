import { CompareError, type CompareOptions, type DocumentInput } from './types';
import { COMPARISON_LIMITS, DEFAULT_COMPARE_OPTIONS } from './limits';

export interface ValidatedDocument extends DocumentInput {
  displayName: string;
}

export function validateOptions(options: Partial<CompareOptions> = {}): CompareOptions {
  if (!options || typeof options !== 'object' || Array.isArray(options)) {
    throw new CompareError('INVALID_INPUT', 'Comparison options are invalid.');
  }

  const merged = { ...DEFAULT_COMPARE_OPTIONS, ...options };
  if (typeof merged.ignoreWhitespace !== 'boolean') {
    throw new CompareError('INVALID_INPUT', 'The whitespace option must be true or false.');
  }
  for (const [key, value] of [
    ['ignoreHeaderLines', merged.ignoreHeaderLines],
    ['ignoreFooterLines', merged.ignoreFooterLines],
  ] as const) {
    if (!Number.isInteger(value) || value < 0 || value > COMPARISON_LIMITS.maxIgnoredLines) {
      throw new CompareError('INVALID_INPUT', `${key} must be an integer from 0 to ${COMPARISON_LIMITS.maxIgnoredLines}.`);
    }
  }
  if (!Number.isInteger(merged.visualThreshold) || merged.visualThreshold < 0 || merged.visualThreshold > 255) {
    throw new CompareError('INVALID_INPUT', 'The visual threshold must be an integer from 0 to 255.');
  }
  return merged;
}

export function validateDocuments(before: DocumentInput, after: DocumentInput): [ValidatedDocument, ValidatedDocument] {
  const left = validateDocument(before);
  const right = validateDocument(after);
  const combined = left.bytes.byteLength + right.bytes.byteLength;
  if (combined > COMPARISON_LIMITS.maxCombinedInputBytes) {
    throw new CompareError('INPUT_TOO_LARGE', `The two documents together must be no larger than ${formatMiB(COMPARISON_LIMITS.maxCombinedInputBytes)} MiB.`);
  }
  return [left, right];
}

export function validateDocument(input: DocumentInput): ValidatedDocument {
  if (!input || typeof input !== 'object' || typeof input.name !== 'string' || !(input.bytes instanceof Uint8Array)) {
    throw new CompareError('INVALID_INPUT', 'Choose a document with a name and byte data.');
  }
  if (input.bytes.byteLength === 0) {
    throw new CompareError('INVALID_INPUT', 'The selected document is empty.');
  }
  if (input.bytes.byteLength > COMPARISON_LIMITS.maxInputBytesPerDocument) {
    throw new CompareError('INPUT_TOO_LARGE', `Each document must be no larger than ${formatMiB(COMPARISON_LIMITS.maxInputBytesPerDocument)} MiB.`);
  }
  if (input.name.length > 1_024) {
    throw new CompareError('INVALID_INPUT', 'The document name is too long.');
  }

  const displayName = sanitizeDocumentName(input.name);
  const prefix = input.bytes.subarray(0, Math.min(input.bytes.length, 1_024));
  if (findBytes(prefix, [0x50, 0x44, 0x46, 0x2d]) < 0) {
    if (input.bytes[0] === 0x50 && input.bytes[1] === 0x4b) {
      throw new CompareError('UNSUPPORTED_FORMAT', 'DOCX and other ZIP-based documents are not supported in this MVP. Choose a PDF.');
    }
    throw new CompareError('PDF_DECODE_FAILED', 'The selected file does not have a recognizable PDF header.');
  }
  return { name: displayName, displayName, bytes: input.bytes };
}

export function sanitizeDocumentName(name: string): string {
  const baseName = name.split(/[\\/]/u).at(-1) ?? '';
  const cleaned = baseName
    .replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/gu, '')
    .trim()
    .slice(0, COMPARISON_LIMITS.maxNameCharacters);
  return cleaned || 'Untitled document';
}

function findBytes(haystack: Uint8Array, needle: number[]): number {
  outer: for (let i = 0; i <= haystack.length - needle.length; i += 1) {
    for (let j = 0; j < needle.length; j += 1) {
      if (haystack[i + j] !== needle[j]) continue outer;
    }
    return i;
  }
  return -1;
}

function formatMiB(bytes: number): number {
  return bytes / 1024 / 1024;
}
