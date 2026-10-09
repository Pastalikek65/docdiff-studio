/** Public contract shared by the comparison engine and the desktop UI. */
export interface DocumentInput {
  name: string;
  bytes: Uint8Array;
}

export interface CompareOptions {
  ignoreWhitespace: boolean;
  ignoreHeaderLines: number;
  ignoreFooterLines: number;
  /** Maximum tolerated difference for each RGBA color channel (0..255). */
  visualThreshold: number;
}

export interface CompareProgress {
  phase: string;
  completed: number;
  total: number;
}

export interface DocumentInfo {
  name: string;
  format: 'pdf' | 'docx';
  sha256: string;
  pageCount: number;
}

export interface TextChange {
  kind: 'equal' | 'added' | 'removed';
  text: string;
}

export interface ComparisonRow {
  id: string;
  status: 'unchanged' | 'changed' | 'added' | 'removed';
  /** Zero-based source page index. Null means this side has no aligned page. */
  beforePage: number | null;
  /** Zero-based source page index. Null means this side has no aligned page. */
  afterPage: number | null;
  beforeText: string;
  afterText: string;
  changes: TextChange[];
  beforeImageDataUrl?: string;
  afterImageDataUrl?: string;
  visual?: {
    diffImageDataUrl: string;
    changedPixels: number;
    totalPixels: number;
    ratio: number;
  };
}

export interface ComparisonResult {
  schemaVersion: 1;
  documents: { before: DocumentInfo; after: DocumentInfo };
  options: CompareOptions;
  rows: ComparisonRow[];
  summary: {
    unchanged: number;
    changed: number;
    added: number;
    removed: number;
  };
  warnings: string[];
  outcome: 'identical' | 'changed' | 'uncertain';
}

export type CompareErrorCode =
  | 'INVALID_INPUT'
  | 'UNSUPPORTED_FORMAT'
  | 'INPUT_TOO_LARGE'
  | 'TOO_MANY_PAGES'
  | 'TEXT_LIMIT_EXCEEDED'
  | 'PIXEL_LIMIT_EXCEEDED'
  | 'OUTPUT_LIMIT_EXCEEDED'
  | 'TIME_LIMIT_EXCEEDED'
  | 'PDF_DECODE_FAILED'
  | 'WORKER_UNAVAILABLE'
  | 'WORKER_FAILED'
  | 'CANCELLED';

export class CompareError extends Error {
  readonly code: CompareErrorCode;

  constructor(code: CompareErrorCode, message: string) {
    super(message);
    this.name = 'CompareError';
    this.code = code;
  }
}
