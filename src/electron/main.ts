import { app, BrowserWindow, dialog, ipcMain, protocol, session } from 'electron';
import type { IpcMainInvokeEvent, WebContents } from 'electron';
import { randomUUID } from 'node:crypto';
import { readFile, rename, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  createContentSecurityPolicy,
  isAllowedAppUrl,
  isAllowedDevRequest,
  isAllowedNavigation,
  parseDevOrigin,
  resolveRendererDirectory,
  safeReportName,
  targetWithExpectedExtension,
} from './security.js';
import type { ReportFormat } from './security.js';

const APP_SCHEME = 'docdiff';
const APP_HOST = 'app';
const APP_URL = `${APP_SCHEME}://${APP_HOST}/index.html`;
const MAX_REPORT_BYTES = 64 * 1024 * 1024;

protocol.registerSchemesAsPrivileged([
  {
    scheme: APP_SCHEME,
    privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: false },
  },
]);

type SaveReportRequest = { format: ReportFormat; fileName: string; content: string };
type SaveReportResponse = { ok: true } | { ok: false; canceled?: true; message: string };

let mainWindow: BrowserWindow | null = null;
let devOrigin: URL | null = null;
const electronDirectory = path.dirname(fileURLToPath(import.meta.url));
const rendererDirectory = resolveRendererDirectory(electronDirectory);

function getDevOrigin(): URL | null {
  if (app.isPackaged) return null;
  return parseDevOrigin(process.env.DOC_DIFF_VITE_ORIGIN);
}

function isAllowedRequest(rawUrl: string): boolean {
  return isAllowedAppUrl(rawUrl, APP_SCHEME, APP_HOST) || isAllowedDevRequest(rawUrl, devOrigin);
}

function getMimeType(filePath: string): string {
  switch (path.extname(filePath).toLowerCase()) {
    case '.html': return 'text/html; charset=utf-8';
    case '.js': case '.mjs': return 'text/javascript; charset=utf-8';
    case '.css': return 'text/css; charset=utf-8';
    case '.svg': return 'image/svg+xml';
    case '.png': return 'image/png';
    case '.jpg': case '.jpeg': return 'image/jpeg';
    case '.webp': return 'image/webp';
    case '.woff2': return 'font/woff2';
    case '.wasm': return 'application/wasm';
    case '.json': return 'application/json; charset=utf-8';
    default: return 'application/octet-stream';
  }
}

async function serveAppAsset(rawUrl: string, method: string): Promise<Response> {
  if (method !== 'GET' && method !== 'HEAD') return new Response('Method not allowed', { status: 405 });
  let pathname: string;
  try {
    const url = new URL(rawUrl);
    if (url.protocol !== `${APP_SCHEME}:` || url.hostname !== APP_HOST) {
      return new Response('Not found', { status: 404 });
    }
    pathname = decodeURIComponent(url.pathname);
  } catch {
    return new Response('Bad request', { status: 400 });
  }

  const relativePath = pathname.replace(/^\/+/, '') || 'index.html';
  if (relativePath.split(/[\\/]/).some((segment) => segment === '.' || segment === '..')) {
    return new Response('Not found', { status: 404 });
  }
  const root = rendererDirectory;
  const filePath = path.resolve(root, relativePath);
  if (!filePath.startsWith(`${root}${path.sep}`) && filePath !== path.join(root, 'index.html')) {
    return new Response('Not found', { status: 404 });
  }

  try {
    const data = await readFile(filePath);
    return new Response(method === 'HEAD' ? null : data, {
      headers: {
        'Content-Type': getMimeType(filePath),
        'Content-Security-Policy': createContentSecurityPolicy(devOrigin),
        'X-Content-Type-Options': 'nosniff',
        'Referrer-Policy': 'no-referrer',
        'Cache-Control': 'no-store',
      },
    });
  } catch {
    return new Response('Not found', { status: 404 });
  }
}

function isSaveRequest(value: unknown): value is SaveReportRequest {
  if (!value || typeof value !== 'object') return false;
  const record = value as Record<string, unknown>;
  return Object.keys(record).every((key) => ['format', 'fileName', 'content'].includes(key)) &&
    (record.format === 'html' || record.format === 'json') &&
    typeof record.fileName === 'string' && record.fileName.length <= 512 &&
    typeof record.content === 'string' && Buffer.byteLength(record.content, 'utf8') <= MAX_REPORT_BYTES;
}

function isTrustedMainFrame(event: IpcMainInvokeEvent): boolean {
  if (!mainWindow || mainWindow.isDestroyed() || event.sender !== mainWindow.webContents) return false;
  const frame = event.senderFrame;
  if (!frame || frame.parent !== null || frame !== mainWindow.webContents.mainFrame) return false;
  return isAllowedNavigation(frame.url, APP_SCHEME, APP_HOST, devOrigin);
}

async function saveReport(event: IpcMainInvokeEvent, raw: unknown): Promise<SaveReportResponse> {
  if (!isTrustedMainFrame(event) || !isSaveRequest(raw)) {
    return { ok: false, message: 'The report request was invalid or came from an untrusted page.' };
  }

  const request = raw;
  const owner = mainWindow;
  if (!owner) return { ok: false, message: 'The application window is unavailable.' };
  const extension = request.format === 'html' ? 'html' : 'json';
  const selected = await dialog.showSaveDialog(owner, {
    title: request.format === 'html' ? 'Save HTML comparison report' : 'Save comparison data',
    defaultPath: safeReportName(request.fileName, request.format),
    filters: [{ name: extension.toUpperCase(), extensions: [extension] }],
  });
  if (selected.canceled || !selected.filePath) return { ok: false, canceled: true, message: 'Save cancelled.' };

  const targetPath = targetWithExpectedExtension(selected.filePath, request.format);
  if (!targetPath) return { ok: false, message: `Choose a .${extension} file name for this report.` };

  const temporaryPath = path.join(path.dirname(targetPath), `.${path.basename(targetPath)}.${randomUUID()}.tmp`);

  try {
    await writeFile(temporaryPath, request.content, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
    await rename(temporaryPath, targetPath);
    return { ok: true };
  } catch {
    await unlink(temporaryPath).catch(() => undefined);
    return { ok: false, message: 'The report could not be written to the selected location.' };
  }
}

function lockDownWebContents(contents: WebContents): void {
  contents.setWindowOpenHandler(() => ({ action: 'deny' }));
  contents.on('will-navigate', (event, targetUrl) => {
    if (!isAllowedNavigation(targetUrl, APP_SCHEME, APP_HOST, devOrigin)) event.preventDefault();
  });
  contents.on('will-attach-webview', (event) => event.preventDefault());
}

async function createWindow(): Promise<void> {
  devOrigin = getDevOrigin();
  const preloadPath = path.join(electronDirectory, 'preload.cjs');
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 980,
    minHeight: 660,
    backgroundColor: '#edf3f9',
    show: false,
    webPreferences: {
      preload: preloadPath,
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: true,
      allowRunningInsecureContent: false,
    },
  });

  mainWindow.once('ready-to-show', () => mainWindow?.show());
  mainWindow.on('closed', () => { mainWindow = null; });
  lockDownWebContents(mainWindow.webContents);
  if (devOrigin) {
    await mainWindow.loadURL(devOrigin.origin);
  } else {
    await mainWindow.loadURL(APP_URL);
  }
}

app.whenReady().then(async () => {
  devOrigin = getDevOrigin();
  await protocol.handle(APP_SCHEME, (request) => serveAppAsset(request.url, request.method));

  session.defaultSession.webRequest.onBeforeRequest({ urls: ['<all_urls>'] }, (details, callback) => {
    callback({ cancel: !isAllowedRequest(details.url) });
  });
  session.defaultSession.webRequest.onHeadersReceived({ urls: ['<all_urls>'] }, (details, callback) => {
    if (isAllowedRequest(details.url)) {
      callback({
        responseHeaders: {
          ...details.responseHeaders,
          'Content-Security-Policy': [createContentSecurityPolicy(devOrigin)],
          'X-Content-Type-Options': ['nosniff'],
          'Referrer-Policy': ['no-referrer'],
        },
      });
      return;
    }
    callback({ cancel: true });
  });

  ipcMain.handle('docdiff:save-report', saveReport);
  await createWindow();
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) void createWindow(); });
}).catch((error: unknown) => {
  console.error('DocDiff Studio could not start.', error);
  app.quit();
});

app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
