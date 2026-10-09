import { COMPARISON_LIMITS } from './limits';
import { CompareError } from './types';

const PNG_PREFIX = 'data:image/png;base64,';
const MAX_OCR_IMAGE_BYTES = 12 * 1024 * 1024;
const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u;
const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/** Decode the engine's bounded PNG data URL locally; this never uses fetch. */
export function pngDataUrlToBlob(dataUrl: string): Blob {
  if (typeof dataUrl !== 'string' || dataUrl.length > COMPARISON_LIMITS.maxImageOutputCharacters
    || !dataUrl.startsWith(PNG_PREFIX)) throw invalidImage();
  const encoded = dataUrl.slice(PNG_PREFIX.length);
  if (!encoded || encoded.length % 4 !== 0 || !BASE64.test(encoded)) throw invalidImage();
  const padding = encoded.endsWith('==') ? 2 : encoded.endsWith('=') ? 1 : 0;
  const decodedBytes = (encoded.length / 4) * 3 - padding;
  if (!Number.isSafeInteger(decodedBytes) || decodedBytes <= 0 || decodedBytes > MAX_OCR_IMAGE_BYTES) throw invalidImage();

  let binary: string;
  try { binary = atob(encoded); }
  catch { throw invalidImage(); }
  if (binary.length !== decodedBytes || PNG_SIGNATURE.some((byte, index) => binary.charCodeAt(index) !== byte)) throw invalidImage();
  const bytes = new Uint8Array(decodedBytes);
  for (let index = 0; index < decodedBytes; index += 1) bytes[index] = binary.charCodeAt(index);
  return new Blob([bytes], { type: 'image/png' });
}

function invalidImage(): CompareError {
  return new CompareError('OCR_FAILED', 'The selected PDF page image is not a supported bounded PNG.');
}
