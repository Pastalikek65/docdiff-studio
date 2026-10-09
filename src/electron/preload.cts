import { contextBridge, ipcRenderer } from 'electron';

type ReportFormat = 'html' | 'json';
type SaveReportRequest = { format: ReportFormat; fileName: string; content: string };
type SaveReportResponse = { ok: true } | { ok: false; canceled?: true; message: string };

contextBridge.exposeInMainWorld('docDiffDesktop', Object.freeze({
  saveReport: (request: SaveReportRequest): Promise<SaveReportResponse> =>
    ipcRenderer.invoke('docdiff:save-report', request) as Promise<SaveReportResponse>,
}));
