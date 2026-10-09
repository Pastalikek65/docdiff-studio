import { COMPARISON_LIMITS } from './limits';
import { pngDataUrlToBlob } from './image-data';
import { CompareError } from './types';

const PNG_PREFIX = 'data:image/png;base64,';
const MAX_IMAGE_BYTES = 12 * 1024 * 1024;

export interface PngVisualDiff {
  visual: {
    diffImageDataUrl: string;
    changedPixels: number;
    totalPixels: number;
    ratio: number;
  };
  pixelCost: number;
  imageCharacters: number;
}

/** Compare already-rendered PDF page previews, without network fetches or unbounded raster allocation. */
export async function comparePngDataUrls(
  beforeDataUrl: string,
  afterDataUrl: string,
  threshold: number,
  renderedPixelUsage: number,
  imageCharacterUsage: number,
  startedAt: number,
): Promise<PngVisualDiff> {
  const before = inspectPngDataUrl(beforeDataUrl);
  const after = inspectPngDataUrl(afterDataUrl);
  const width = Math.max(before.width, after.width);
  const height = Math.max(before.height, after.height);
  const totalPixels = width * height;
  const pixelCost = before.width * before.height + after.width * after.height + totalPixels;
  if (!Number.isSafeInteger(totalPixels) || totalPixels > COMPARISON_LIMITS.maxPixelsPerRenderedPage
    || width > COMPARISON_LIMITS.maxRenderWidth || height > COMPARISON_LIMITS.maxRenderHeight
    || !Number.isSafeInteger(pixelCost) || renderedPixelUsage + pixelCost > COMPARISON_LIMITS.maxRenderedPixels) {
    throw new CompareError('PIXEL_LIMIT_EXCEEDED', 'Moved page visual comparison exceeds the supported raster budget.');
  }
  checkTime(startedAt);
  if (typeof createImageBitmap !== 'function' || typeof OffscreenCanvas === 'undefined') {
    throw new CompareError('WORKER_UNAVAILABLE', 'Moved page visual comparison requires OffscreenCanvas image support.');
  }

  let beforeBitmap: ImageBitmap | undefined;
  let afterBitmap: ImageBitmap | undefined;
  let beforeCanvas: OffscreenCanvas | undefined;
  let afterCanvas: OffscreenCanvas | undefined;
  let overlay: OffscreenCanvas | undefined;
  try {
    let beforeBlob: Blob;
    let afterBlob: Blob;
    try {
      beforeBlob = pngDataUrlToBlob(beforeDataUrl);
      afterBlob = pngDataUrlToBlob(afterDataUrl);
      if (beforeBlob.size > MAX_IMAGE_BYTES || afterBlob.size > MAX_IMAGE_BYTES) throw invalidPng();
      beforeBitmap = await createImageBitmap(beforeBlob);
      checkTime(startedAt);
      afterBitmap = await createImageBitmap(afterBlob);
      checkTime(startedAt);
    } catch (error) {
      if (error instanceof CompareError && error.code === 'TIME_LIMIT_EXCEEDED') throw error;
      throw new CompareError('PDF_DECODE_FAILED', 'A moved PDF page image could not be decoded for visual comparison.');
    }
    if (beforeBitmap.width !== before.width || beforeBitmap.height !== before.height
      || afterBitmap.width !== after.width || afterBitmap.height !== after.height) {
      throw new CompareError('PDF_DECODE_FAILED', 'A moved PDF page image has inconsistent dimensions.');
    }

    beforeCanvas = new OffscreenCanvas(before.width, before.height);
    afterCanvas = new OffscreenCanvas(after.width, after.height);
    const beforeContext = beforeCanvas.getContext('2d', { willReadFrequently: true });
    const afterContext = afterCanvas.getContext('2d', { willReadFrequently: true });
    if (!beforeContext || !afterContext) throw new CompareError('WORKER_UNAVAILABLE', 'Moved page image pixels are unavailable.');
    beforeContext.fillStyle = '#ffffff';
    beforeContext.fillRect(0, 0, before.width, before.height);
    beforeContext.drawImage(beforeBitmap, 0, 0);
    afterContext.fillStyle = '#ffffff';
    afterContext.fillRect(0, 0, after.width, after.height);
    afterContext.drawImage(afterBitmap, 0, 0);
    checkTime(startedAt);

    const left = beforeContext.getImageData(0, 0, before.width, before.height).data;
    const right = afterContext.getImageData(0, 0, after.width, after.height).data;
    overlay = new OffscreenCanvas(width, height);
    const overlayContext = overlay.getContext('2d', { willReadFrequently: true });
    if (!overlayContext) throw new CompareError('WORKER_UNAVAILABLE', 'A moved page visual overlay is unavailable.');
    const output = overlayContext.createImageData(width, height);
    let changedPixels = 0;
    for (let y = 0; y < height; y += 1) {
      checkTime(startedAt);
      for (let x = 0; x < width; x += 1) {
        const outputOffset = (y * width + x) * 4;
        const leftInside = x < before.width && y < before.height;
        const rightInside = x < after.width && y < after.height;
        const leftOffset = leftInside ? (y * before.width + x) * 4 : -1;
        const rightOffset = rightInside ? (y * after.width + x) * 4 : -1;
        const difference = Math.max(
          Math.abs((leftInside ? left[leftOffset] : 255) - (rightInside ? right[rightOffset] : 255)),
          Math.abs((leftInside ? left[leftOffset + 1] : 255) - (rightInside ? right[rightOffset + 1] : 255)),
          Math.abs((leftInside ? left[leftOffset + 2] : 255) - (rightInside ? right[rightOffset + 2] : 255)),
          Math.abs((leftInside ? left[leftOffset + 3] : 255) - (rightInside ? right[rightOffset + 3] : 255)),
        );
        if (difference > threshold) {
          changedPixels += 1;
          output.data[outputOffset] = 220;
          output.data[outputOffset + 1] = 40;
          output.data[outputOffset + 2] = 72;
          output.data[outputOffset + 3] = Math.min(235, 90 + Math.round(difference * 145 / 255));
        }
      }
    }
    overlayContext.putImageData(output, 0, 0);
    checkTime(startedAt);

    const blob = await overlay.convertToBlob({ type: 'image/png' });
    checkTime(startedAt);
    if (blob.type !== 'image/png' || blob.size <= 0 || blob.size > MAX_IMAGE_BYTES) {
      throw new CompareError('OUTPUT_LIMIT_EXCEEDED', 'A moved page visual overlay exceeds the supported image size.');
    }
    const estimatedCharacters = PNG_PREFIX.length + Math.ceil(blob.size / 3) * 4;
    if (estimatedCharacters > COMPARISON_LIMITS.maxImageOutputCharacters - imageCharacterUsage) {
      throw new CompareError('OUTPUT_LIMIT_EXCEEDED', 'Moved page image overlays exceed the supported report size.');
    }
    const bytes = new Uint8Array(await blob.arrayBuffer());
    checkTime(startedAt);
    const diffImageDataUrl = PNG_PREFIX + encodeBase64(bytes);
    if (diffImageDataUrl.length > COMPARISON_LIMITS.maxImageOutputCharacters - imageCharacterUsage) {
      throw new CompareError('OUTPUT_LIMIT_EXCEEDED', 'Moved page image overlays exceed the supported report size.');
    }
    return {
      visual: {
        diffImageDataUrl,
        changedPixels,
        totalPixels,
        ratio: totalPixels ? changedPixels / totalPixels : 0,
      },
      pixelCost,
      imageCharacters: diffImageDataUrl.length,
    };
  } catch (error) {
    if (error instanceof CompareError) throw error;
    throw new CompareError('WORKER_FAILED', 'A moved page visual difference could not be generated.');
  } finally {
    beforeBitmap?.close();
    afterBitmap?.close();
    releaseCanvas(beforeCanvas);
    releaseCanvas(afterCanvas);
    releaseCanvas(overlay);
  }
}

function inspectPngDataUrl(value: string): { width: number; height: number } {
  if (typeof value !== 'string' || value.length > COMPARISON_LIMITS.maxImageOutputCharacters || !value.startsWith(PNG_PREFIX)) {
    throw invalidPng();
  }
  const encoded = value.slice(PNG_PREFIX.length);
  const decodedBytes = Math.floor(encoded.length * 3 / 4);
  if (!encoded || encoded.length % 4 !== 0 || decodedBytes > MAX_IMAGE_BYTES) throw invalidPng();
  let header: string;
  try { header = atob(encoded.slice(0, 44)); }
  catch { throw invalidPng(); }
  if (header.length < 24 || header.charCodeAt(0) !== 0x89 || header.slice(1, 4) !== 'PNG'
    || header.slice(12, 16) !== 'IHDR') throw invalidPng();
  const width = readUint32(header, 16);
  const height = readUint32(header, 20);
  if (!width || !height || width > COMPARISON_LIMITS.maxRenderWidth || height > COMPARISON_LIMITS.maxRenderHeight
    || width * height > COMPARISON_LIMITS.maxPixelsPerRenderedPage) throw invalidPng();
  return { width, height };
}

function readUint32(value: string, offset: number): number {
  return ((value.charCodeAt(offset) << 24) | (value.charCodeAt(offset + 1) << 16)
    | (value.charCodeAt(offset + 2) << 8) | value.charCodeAt(offset + 3)) >>> 0;
}

function encodeBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let index = 0; index < bytes.length; index += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(index, Math.min(index + 0x8000, bytes.length)));
  }
  return btoa(binary);
}

function checkTime(startedAt: number): void {
  if (performance.now() - startedAt > COMPARISON_LIMITS.maxWallTimeMs) {
    throw new CompareError('TIME_LIMIT_EXCEEDED', 'The comparison exceeded its time limit.');
  }
}

function releaseCanvas(canvas: OffscreenCanvas | undefined): void {
  if (canvas) { canvas.width = 1; canvas.height = 1; }
}

function invalidPng(): CompareError {
  return new CompareError('PDF_DECODE_FAILED', 'A moved PDF page preview is not a supported bounded PNG.');
}
