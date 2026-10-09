import path from 'node:path';

export type ReportFormat = 'html' | 'json';

export function resolveRendererDirectory(electronDirectory: string): string {
  return path.resolve(electronDirectory, '../../dist');
}

export function createContentSecurityPolicy(devOrigin: URL | null): string {
  const dev = devOrigin?.origin;
  const connect = dev ? `connect-src 'self' ${dev} ws://${devOrigin!.host};` : "connect-src 'self';";
  const styles = dev ? "style-src 'self' 'unsafe-inline';" : "style-src 'self';";
  return [
    "default-src 'self';",
    "script-src 'self' 'wasm-unsafe-eval';",
    styles,
    "img-src 'self' data: blob:;",
    "font-src 'self' data:;",
    "worker-src 'self' blob:;",
    connect,
    "object-src 'none';",
    "base-uri 'none';",
    "form-action 'none';",
    "frame-ancestors 'none';",
  ].join(' ');
}

export function parseDevOrigin(candidate: string | undefined): URL | null {
  if (!candidate) return null;
  try {
    const parsed = new URL(candidate);
    if (
      parsed.protocol !== 'http:' ||
      !['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname) ||
      parsed.username ||
      parsed.password ||
      parsed.pathname !== '/' ||
      parsed.search ||
      parsed.hash
    ) return null;
    return parsed;
  } catch {
    return null;
  }
}

export function isAllowedDevRequest(rawUrl: string, devOrigin: URL | null): boolean {
  if (!devOrigin) return false;
  try {
    const url = new URL(rawUrl);
    const protocolMatches = url.protocol === 'http:' || url.protocol === 'ws:';
    const requestPort = url.port || '80';
    const configuredPort = devOrigin.port || '80';
    return protocolMatches && !url.username && !url.password &&
      url.hostname === devOrigin.hostname && requestPort === configuredPort;
  } catch {
    return false;
  }
}

export function isAllowedAppUrl(rawUrl: string, scheme: string, host: string): boolean {
  try {
    const url = new URL(rawUrl);
    return url.protocol === `${scheme}:` && url.hostname === host && !url.username && !url.password;
  } catch {
    return false;
  }
}

export function isAllowedNavigation(
  rawUrl: string,
  scheme: string,
  host: string,
  devOrigin: URL | null,
): boolean {
  try {
    const url = new URL(rawUrl);
    if (devOrigin) {
      return url.origin === devOrigin.origin &&
        !url.username && !url.password &&
        (url.pathname === '/' || url.pathname === '/index.html') &&
        !url.search;
    }
    return url.protocol === `${scheme}:` && url.hostname === host &&
      !url.username && !url.password && url.pathname === '/index.html' && !url.search;
  } catch {
    return false;
  }
}

export function safeReportName(input: string, format: ReportFormat): string {
  const leaf = input.replace(/[\\/]/g, '_').replace(/[<>:"|?*\u0000-\u001f]/g, '_').trim().replace(/[. ]+$/g, '');
  const stem = leaf.replace(/\.(html?|json)$/i, '').slice(0, 120) || 'document-comparison';
  return `${stem}.${format === 'html' ? 'html' : 'json'}`;
}

export function targetWithExpectedExtension(filePath: string, format: ReportFormat): string | null {
  const expected = format === 'html' ? '.html' : '.json';
  const extension = path.extname(filePath);
  if (extension && extension.toLowerCase() !== expected) return null;
  return extension ? filePath : `${filePath}${expected}`;
}
