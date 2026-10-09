export const COMPARISON_LIMITS = Object.freeze({
  maxInputBytesPerDocument: 50 * 1024 * 1024,
  maxCombinedInputBytes: 100 * 1024 * 1024,
  maxPagesPerDocument: 200,
  maxPageTextCharacters: 100_000,
  maxTextCharactersTotal: 2_000_000,
  maxPixelsPerRenderedPage: 1200 * 1600,
  maxRenderedPixels: 80_000_000,
  maxImageOutputCharacters: 48 * 1024 * 1024,
  maxImagePixels: 12_000_000,
  maxSerializedReportBytes: 64 * 1024 * 1024,
  maxNameCharacters: 120,
  maxIgnoredLines: 100,
  maxWallTimeMs: 120_000,
  maxRenderWidth: 1_200,
  maxRenderHeight: 1_600,
  maxRenderScale: 1.5,
});

export const DEFAULT_COMPARE_OPTIONS = Object.freeze({
  ignoreWhitespace: false,
  ignoreHeaderLines: 0,
  ignoreFooterLines: 0,
  visualThreshold: 24,
});
