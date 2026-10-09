export {};

declare global {
  interface Window {
    docDiffDesktop?: {
      saveReport(request: {
        format: 'html' | 'json';
        fileName: string;
        content: string;
      }): Promise<
        | { ok: true }
        | { ok: false; canceled?: true; message: string }
      >;
    };
  }
}
