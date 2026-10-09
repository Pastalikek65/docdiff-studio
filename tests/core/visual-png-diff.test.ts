import { afterEach, describe, expect, it, vi } from 'vitest';
import { COMPARISON_LIMITS } from '../../src/core/limits';
import { CompareError } from '../../src/core/types';
import { comparePngDataUrls } from '../../src/core/visual-png-diff';

const originalCreateImageBitmap = Object.getOwnPropertyDescriptor(globalThis, 'createImageBitmap');
const originalOffscreenCanvas = Object.getOwnPropertyDescriptor(globalThis, 'OffscreenCanvas');

class TestCanvas {
  width: number;
  height: number;
  pixels: Uint8ClampedArray;
  private readonly context: TestContext;

  constructor(width: number, height: number) {
    this.width = width;
    this.height = height;
    this.pixels = new Uint8ClampedArray(width * height * 4);
    this.context = new TestContext(this);
  }

  getContext(): TestContext { return this.context; }

  async convertToBlob(): Promise<Blob> {
    const bytes = pngBytes(1, 1, 1);
    return new Blob([bytes.buffer as ArrayBuffer], { type: 'image/png' });
  }
}

class TestContext {
  fillStyle = '';
  constructor(private readonly canvas: TestCanvas) {}

  fillRect(): void { this.canvas.pixels.fill(255); }
  drawImage(image: { pixels: Uint8ClampedArray }): void { this.canvas.pixels.set(image.pixels); }
  getImageData(): { data: Uint8ClampedArray } { return { data: this.canvas.pixels }; }
  createImageData(width: number, height: number): { data: Uint8ClampedArray } {
    return { data: new Uint8ClampedArray(width * height * 4) };
  }
  putImageData(image: { data: Uint8ClampedArray }): void { this.canvas.pixels.set(image.data); }
}

function pngBytes(width: number, height: number, marker: number): Uint8Array {
  const bytes = new Uint8Array(25);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  bytes.set([0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52], 8);
  new DataView(bytes.buffer).setUint32(16, width, false);
  new DataView(bytes.buffer).setUint32(20, height, false);
  bytes[24] = marker;
  return bytes;
}

function dataUrl(width: number, height: number, marker: number): string {
  const bytes = pngBytes(width, height, marker);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return `data:image/png;base64,${btoa(binary)}`;
}

function installImageMocks(): ReturnType<typeof vi.fn> {
  const bitmap = vi.fn(async (blob: Blob) => {
    const bytes = new Uint8Array(await blob.arrayBuffer());
    const marker = bytes[24];
    const pixels = new Uint8ClampedArray(2 * 2 * 4).fill(255);
    if (marker === 2) pixels.set([0, 0, 0, 255], 0);
    return { width: 2, height: 2, pixels, close: vi.fn() };
  });
  Object.defineProperty(globalThis, 'createImageBitmap', { configurable: true, value: bitmap });
  Object.defineProperty(globalThis, 'OffscreenCanvas', { configurable: true, value: TestCanvas });
  return bitmap;
}

afterEach(() => {
  if (originalCreateImageBitmap) Object.defineProperty(globalThis, 'createImageBitmap', originalCreateImageBitmap);
  else Reflect.deleteProperty(globalThis, 'createImageBitmap');
  if (originalOffscreenCanvas) Object.defineProperty(globalThis, 'OffscreenCanvas', originalOffscreenCanvas);
  else Reflect.deleteProperty(globalThis, 'OffscreenCanvas');
});

describe('moved PDF page visual comparison', () => {
  it('retains a bounded pixel overlay for a moved page whose appearance changed', async () => {
    const createBitmap = installImageMocks();
    const result = await comparePngDataUrls(dataUrl(2, 2, 1), dataUrl(2, 2, 2), 24, 24, 0, performance.now());

    expect(result.visual.changedPixels).toBe(1);
    expect(result.visual.totalPixels).toBe(4);
    expect(result.visual.ratio).toBe(0.25);
    expect(result.visual.diffImageDataUrl).toMatch(/^data:image\/png;base64,/u);
    expect(result.pixelCost).toBe(12);
    expect(createBitmap).toHaveBeenCalledTimes(2);
  });

  it('rejects dimensions and aggregate raster work before decoding image payloads', async () => {
    const createBitmap = installImageMocks();
    await expect(comparePngDataUrls(dataUrl(1201, 1, 1), dataUrl(2, 2, 2), 24, 0, 0, performance.now()))
      .rejects.toMatchObject<Partial<CompareError>>({ code: 'PDF_DECODE_FAILED' });
    await expect(comparePngDataUrls(dataUrl(2, 2, 1), dataUrl(2, 2, 2), 24, COMPARISON_LIMITS.maxRenderedPixels - 11, 0, performance.now()))
      .rejects.toMatchObject<Partial<CompareError>>({ code: 'PIXEL_LIMIT_EXCEEDED' });
    expect(createBitmap).not.toHaveBeenCalled();
  });

  it('enforces the report image budget before encoding a moved-page overlay', async () => {
    installImageMocks();
    await expect(comparePngDataUrls(
      dataUrl(2, 2, 1),
      dataUrl(2, 2, 2),
      24,
      24,
      COMPARISON_LIMITS.maxImageOutputCharacters - 10,
      performance.now(),
    )).rejects.toMatchObject<Partial<CompareError>>({ code: 'OUTPUT_LIMIT_EXCEEDED' });
  });
});
