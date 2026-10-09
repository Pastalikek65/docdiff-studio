import { describe, expect, it } from 'vitest';
import { COMPARISON_LIMITS } from '../../src/core/limits';
import { validateDocument, validateDocuments, validateOptions } from '../../src/core/validation';
import { CompareError } from '../../src/core/types';

const pdfBytes = new Uint8Array([...new TextEncoder().encode('%PDF-1.7\n')]);

describe('comparison input validation', () => {
  it('accepts a PDF header and strips directory paths/control characters from its display name', () => {
    const document = validateDocument({
      name: 'C:\\private\\review\u0000 copy.pdf',
      bytes: pdfBytes,
    });
    expect(document.name).toBe('review copy.pdf');
    expect(document.displayName).toBe('review copy.pdf');
  });

  it('rejects malformed input and ZIP-based DOCX before PDF.js sees it', () => {
    expect(() => validateDocument({ name: 'broken.pdf', bytes: new Uint8Array([1, 2, 3]) }))
      .toThrowError(expect.objectContaining({ code: 'PDF_DECODE_FAILED' }));
    expect(() => validateDocument({ name: 'draft.docx', bytes: new Uint8Array([0x50, 0x4b, 0x03, 0x04]) }))
      .toThrowError(expect.objectContaining({ code: 'UNSUPPORTED_FORMAT' }));
  });

  it('rejects oversized input before reading its claimed PDF format', () => {
    const oversized = new Uint8Array(COMPARISON_LIMITS.maxInputBytesPerDocument + 1);
    expect(() => validateDocument({ name: 'large.pdf', bytes: oversized }))
      .toThrowError(expect.objectContaining({ code: 'INPUT_TOO_LARGE' }));
  });

  it('rejects invalid option values at the API boundary', () => {
    expect(() => validateOptions({ visualThreshold: 256 })).toThrowError(CompareError);
    expect(() => validateOptions({ ignoreHeaderLines: 101 })).toThrowError(CompareError);
  });

  it('applies the combined input budget after each document passes the per-file budget', () => {
    const maxFile = new Uint8Array(COMPARISON_LIMITS.maxInputBytesPerDocument);
    maxFile.set(pdfBytes.subarray(0, 5));
    const [before, after] = validateDocuments(
      { name: 'before.pdf', bytes: maxFile },
      { name: 'after.pdf', bytes: maxFile },
    );
    expect(before.bytes.byteLength + after.bytes.byteLength).toBe(COMPARISON_LIMITS.maxCombinedInputBytes);
  });
});
