import { comparePdfDocuments } from './pdf-engine';
import type { CompareOptions, CompareProgress, ComparisonResult, DocumentInput } from './types';
export { compareDocumentsV2 } from './v2-engine';

export function compareDocuments(
  before: DocumentInput,
  after: DocumentInput,
  options: Partial<CompareOptions> = {},
  onProgress?: (progress: CompareProgress) => void,
): Promise<ComparisonResult> {
  return comparePdfDocuments(before, after, options, onProgress);
}

export { COMPARISON_LIMITS, DEFAULT_COMPARE_OPTIONS, DEFAULT_COMPARE_OPTIONS_V2 } from './limits';
export { CompareError } from './types';
export type {
  CompareErrorCode,
  CompareOptions,
  CompareOptionsV2,
  CompareProgress,
  CompareRequestV2,
  ComparisonResult,
  ComparisonResultV2,
  ComparisonRow,
  ComparisonRowV2,
  DocumentInfoV2,
  DocumentInfo,
  DocumentInput,
  DocumentInputV2,
  DocumentLocationV2,
  OcrOptionsV2,
  OcrPageRequestV2,
  OcrPageResultV2,
  OcrProgressV2,
  OcrRuntimeV2,
  OcrSideV2,
  SourceFormatV2,
  TextEvidenceSourceV2,
  TextEvidenceV2,
  CellTextChangeV2,
  TextChange,
} from './types';
export { renderHtmlReport, serializeReport } from './report';
export { renderHtmlReportV2, serializeReportV2 } from './report-v2';
