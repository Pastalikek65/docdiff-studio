import { comparePdfDocuments } from './pdf-engine';
import type { CompareOptions, CompareProgress, ComparisonResult, DocumentInput } from './types';

export function compareDocuments(
  before: DocumentInput,
  after: DocumentInput,
  options: Partial<CompareOptions> = {},
  onProgress?: (progress: CompareProgress) => void,
): Promise<ComparisonResult> {
  return comparePdfDocuments(before, after, options, onProgress);
}

export { COMPARISON_LIMITS, DEFAULT_COMPARE_OPTIONS } from './limits';
export { CompareError } from './types';
export type {
  CompareErrorCode,
  CompareOptions,
  CompareProgress,
  ComparisonResult,
  ComparisonRow,
  DocumentInfo,
  DocumentInput,
  TextChange,
} from './types';
export { renderHtmlReport, serializeReport } from './report';
