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

/** V2 inputs tag file format explicitly; bytes remain local to the caller. */
export type SourceFormatV2 = 'pdf' | 'docx';

export interface DocumentInputV2 {
  format: SourceFormatV2;
  name: string;
  bytes: Uint8Array;
}

export interface OcrOptionsV2 {
  enabled: boolean;
  /** Zero-based PDF page indexes. Selection must be unique and <=20 total. */
  beforePageIndexes: number[];
  afterPageIndexes: number[];
  /** Engine confidence score threshold from 0 through 100; not a probability. */
  minimumConfidence: number;
}

export interface CompareOptionsV2 extends CompareOptions {
  /** Reclassify only exactly equal blocks unique in both complete documents. */
  detectMoves: boolean;
  ocr: OcrOptionsV2;
}

export interface CompareRequestV2 {
  schemaVersion: 2;
  before: DocumentInputV2;
  after: DocumentInputV2;
  options: Partial<CompareOptionsV2>;
}

export type OcrSideV2 = 'before' | 'after';

export interface OcrPageRequestV2 {
  side: OcrSideV2;
  pageIndex: number;
  /** Bounded local PNG image; callers must not upload or persist this value. */
  image: Blob;
}

export interface OcrPageResultV2 {
  text: string;
  confidence?: number;
}

export interface OcrProgressV2 {
  phase: string;
  progress: number;
}

/**
 * Local-only OCR adapter supplied by the worker owner. The core does not load
 * or instantiate OCR workers and always awaits termination before returning.
 */
export interface OcrRuntimeV2 {
  recognizePage(
    request: OcrPageRequestV2,
    onProgress?: (progress: OcrProgressV2) => void,
  ): Promise<OcrPageResultV2>;
  terminate(): void | Promise<void>;
}

export interface DocumentInfoV2 {
  name: string;
  format: SourceFormatV2;
  sha256: string;
  unitKind: 'pdf-page' | 'docx-block';
  unitCount: number;
  /** Present only when format is PDF; DOCX blocks have no physical pagination. */
  physicalPageCount?: number;
}

export type DocumentLocationV2 =
  | { format: 'pdf'; kind: 'page'; index: number }
  | { format: 'docx'; kind: 'paragraph'; index: number }
  | { format: 'docx'; kind: 'table-row'; index: number; tableIndex: number; rowIndex: number };

export type TextEvidenceSourceV2 = 'pdf-text' | 'docx-xml' | 'ocr' | 'none';

export interface TextEvidenceV2 {
  source: TextEvidenceSourceV2;
  confidence?: number;
}

export interface CellTextChangeV2 {
  beforeCellIndex: number | null;
  afterCellIndex: number | null;
  changes: TextChange[];
}

export interface ComparisonRowV2 {
  id: string;
  status: 'unchanged' | 'changed' | 'added' | 'removed' | 'moved';
  /** Present on exact move rows and stable across report re-serialization. */
  moveId?: string;
  beforeLocation: DocumentLocationV2 | null;
  afterLocation: DocumentLocationV2 | null;
  beforeText: string;
  afterText: string;
  changes: TextChange[];
  textEvidence: { before: TextEvidenceV2; after: TextEvidenceV2 };
  /** Present for DOCX table-row blocks; cell indexes follow source order. */
  beforeCells?: string[];
  afterCells?: string[];
  cellChanges?: CellTextChangeV2[];
  /** PDF-only rendered page previews. */
  beforeImageDataUrl?: string;
  afterImageDataUrl?: string;
  visual?: {
    diffImageDataUrl: string;
    changedPixels: number;
    totalPixels: number;
    ratio: number;
  };
}

export interface ComparisonResultV2 {
  schemaVersion: 2;
  documents: { before: DocumentInfoV2; after: DocumentInfoV2 };
  options: CompareOptionsV2;
  rows: ComparisonRowV2[];
  summary: {
    unchanged: number;
    changed: number;
    added: number;
    removed: number;
    moved: number;
  };
  warnings: string[];
  outcome: 'identical' | 'changed' | 'uncertain';
  certainty: 'complete' | 'incomplete';
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
  | 'FORMAT_MISMATCH'
  | 'DOCX_PACKAGE_INVALID'
  | 'DOCX_XML_INVALID'
  | 'DOCX_UNSUPPORTED_FEATURE'
  | 'OCR_UNAVAILABLE'
  | 'OCR_FAILED'
  | 'OCR_PAGE_LIMIT_EXCEEDED'
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
