import { describe, expect, it } from 'vitest';
import path from 'node:path';
import {
  createContentSecurityPolicy,
  isAllowedAppUrl,
  isAllowedDevRequest,
  isAllowedNavigation,
  parseDevOrigin,
  resolveRendererDirectory,
  safeReportName,
  targetWithExpectedExtension,
} from '../../src/electron/security.js';

describe('desktop origin and report-save boundaries', () => {
  it('accepts only the explicitly configured local Vite origin', () => {
    const origin = parseDevOrigin('http://localhost:5173/');
    expect(origin?.origin).toBe('http://localhost:5173');
    expect(isAllowedDevRequest('http://localhost:5173/@vite/client', origin)).toBe(true);
    expect(isAllowedDevRequest('ws://localhost:5173/', origin)).toBe(true);
    expect(isAllowedDevRequest('http://localhost:5174/@vite/client', origin)).toBe(false);
    expect(isAllowedDevRequest('https://localhost:5173/@vite/client', origin)).toBe(false);
    expect(isAllowedDevRequest('http://127.0.0.1:5173/@vite/client', origin)).toBe(false);
    expect(isAllowedDevRequest('http://user@localhost:5173/@vite/client', origin)).toBe(false);
  });

  it('rejects remote, malformed and non-entry navigations without throwing', () => {
    expect(parseDevOrigin('https://localhost:5173/')).toBeNull();
    expect(parseDevOrigin('http://example.com:5173/')).toBeNull();
    expect(parseDevOrigin('http://localhost:5173/other')).toBeNull();
    expect(isAllowedNavigation('not a URL', 'docdiff', 'app', null)).toBe(false);
    expect(isAllowedNavigation('https://example.com/', 'docdiff', 'app', null)).toBe(false);
    expect(isAllowedNavigation('docdiff://app/index.html#workspace', 'docdiff', 'app', null)).toBe(true);
    expect(isAllowedNavigation('docdiff://app/other.html', 'docdiff', 'app', null)).toBe(false);
    expect(isAllowedNavigation('docdiff://app/index.html?route=other', 'docdiff', 'app', null)).toBe(false);
    expect(isAllowedAppUrl('docdiff://untrusted/index.html', 'docdiff', 'app')).toBe(false);
  });

  it('makes a safe default name and refuses extension changes from the save dialog', () => {
    const name = safeReportName('../../draft:<final>.pdf', 'html');
    expect(name.endsWith('.html')).toBe(true);
    expect(name).not.toMatch(/[\\/<>:"|?*\u0000-\u001f]/);
    expect(targetWithExpectedExtension('C:\\Reports\\review.html', 'html')).toBe('C:\\Reports\\review.html');
    expect(targetWithExpectedExtension('C:\\Reports\\review', 'json')).toBe('C:\\Reports\\review.json');
    expect(targetWithExpectedExtension('C:\\Reports\\original.pdf', 'html')).toBeNull();
  });

  it('resolves renderer assets relative to the compiled Electron entry in source and asar layouts', () => {
    const sourceRoot = path.resolve('fixture-source');
    const packagedRoot = path.resolve('fixture-packaged', 'resources', 'app.asar');
    expect(resolveRendererDirectory(path.join(sourceRoot, 'dist-electron', 'electron'))).toBe(path.join(sourceRoot, 'dist'));
    expect(resolveRendererDirectory(path.join(packagedRoot, 'dist-electron', 'electron'))).toBe(path.join(packagedRoot, 'dist'));
  });

  it('permits bundled WebAssembly without enabling JavaScript eval', () => {
    const policy = createContentSecurityPolicy(null);
    const scriptDirective = policy.split(';').find((directive) => directive.trim().startsWith('script-src'));
    expect(scriptDirective).toContain("'wasm-unsafe-eval'");
    expect(scriptDirective?.split(/\s+/)).not.toContain("'unsafe-eval'");
    expect(policy).toContain("connect-src 'self'");
  });
});
