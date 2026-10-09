import { afterEach, describe, expect, it, vi } from 'vitest';
import { pngDataUrlToBlob } from '../../src/core/image-data';

const pngHeader = 'iVBORw0KGgo=';

describe('bounded local OCR image conversion', () => {
  afterEach(() => vi.restoreAllMocks());

  it('decodes a bounded PNG data URL into a Blob without using fetch', () => {
    const network = vi.spyOn(globalThis, 'fetch');
    const blob = pngDataUrlToBlob(`data:image/png;base64,${pngHeader}`);

    expect(blob).toBeInstanceOf(Blob);
    expect(blob.type).toBe('image/png');
    expect(blob.size).toBe(8);
    expect(network).not.toHaveBeenCalled();
  });

  it('rejects invalid or oversized image data before creating a Blob', () => {
    expect(() => pngDataUrlToBlob('data:image/jpeg;base64,iVBORw0KGgo=')).toThrowError();
    expect(() => pngDataUrlToBlob('data:image/png;base64,invalid')).toThrowError();
    expect(() => pngDataUrlToBlob(`data:image/png;base64,${'A'.repeat(48 * 1024 * 1024)}`)).toThrowError();
  });
});
