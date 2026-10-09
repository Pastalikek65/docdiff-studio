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
  maxDocxEntries: 4_096,
  maxDocxUncompressedBytes: 100 * 1024 * 1024,
  maxDocxXmlPartBytes: 16 * 1024 * 1024,
  maxDocxXmlTotalBytes: 32 * 1024 * 1024,
  maxDocxBlocks: 100_000,
  maxXmlNodes: 1_000_000,
  maxXmlDepth: 128,
  maxOcrPages: 20,
  maxOcrPixelsPerPage: 1_920_000,
  maxOcrPixelsTotal: 20_000_000,
});

export const DEFAULT_COMPARE_OPTIONS = Object.freeze({
  ignoreWhitespace: false,
  ignoreHeaderLines: 0,
  ignoreFooterLines: 0,
  visualThreshold: 24,
});

export const DEFAULT_COMPARE_OPTIONS_V2 = Object.freeze({
  ...DEFAULT_COMPARE_OPTIONS,
  detectMoves: true,
  ocr: Object.freeze({
    enabled: false,
    beforePageIndexes: [] as number[],
    afterPageIndexes: [] as number[],
    minimumConfidence: 70,
  }),
});
