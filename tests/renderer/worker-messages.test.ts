import { describe, expect, it } from 'vitest';
import { runInNewContext } from 'node:vm';
import { isReadyHandshake, isWorkerResponse } from '../../src/renderer/worker-messages.js';

describe('renderer worker message protocol', () => {
  it('recognizes only the exact outer-worker ready envelope', () => {
    const ready = { sourceName: 'worker', targetName: 'main', action: 'ready', data: new Uint8Array() };
    expect(isReadyHandshake(ready)).toBe(true);
    expect(isWorkerResponse(ready)).toBe(false);
    expect(isReadyHandshake({ ...ready, sequence: 1 })).toBe(false);
    expect(isReadyHandshake({ ...ready, data: { ready: true } })).toBe(false);
    expect(isReadyHandshake({ ...ready, data: new Date() })).toBe(false);
    expect(isReadyHandshake({ ...ready, data: new Uint8Array([7]) })).toBe(false);
    expect(isReadyHandshake({ ...ready, data: new Uint16Array() })).toBe(false);
    expect(isReadyHandshake({ ...ready, data: new Uint8ClampedArray() })).toBe(false);
    expect(isReadyHandshake(runInNewContext(`({ sourceName: 'worker', targetName: 'main', action: 'ready', data: new Uint8Array() })`))).toBe(true);
    expect(isReadyHandshake(structuredClone(runInNewContext(`({ sourceName: 'worker', targetName: 'main', action: 'ready', data: new Uint8Array() })`)))).toBe(true);
    const hiddenExtra = { ...ready };
    Object.defineProperty(hiddenExtra, 'unexpected', { value: true });
    expect(isReadyHandshake(hiddenExtra)).toBe(false);
  });

  it('keeps unknown or malformed messages on the explicit failure path', () => {
    expect(isWorkerResponse({ action: 'ready', data: {} })).toBe(false);
    expect(isWorkerResponse({ type: 'complete', result: { outcome: 'identical' } })).toBe(false);
    expect(isWorkerResponse({ type: 'error', code: 'PDF_DECODE_FAILED', message: 'Cannot read PDF.' })).toBe(true);
  });
});
