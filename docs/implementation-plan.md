# DocDiff Studio implementation

This executes the owner-approved five-product plan, product three. DemoForge and Rehearse have passed their v1 gates. Build a useful local document-review tool without accounts, paid APIs or document uploads. English product/docs, Turkish quickstart, Apache-2.0 authored source, Windows/Linux x64 targets.

## Architecture and interfaces

React/Vite local editor inside an Electron sandboxed renderer. PDF.js processes bytes and renders pages in a dedicated comparison worker. Renderer file inputs read only explicitly selected files. Electron has no document parser or arbitrary filesystem bridge; a validated, sender-bound save operation presents the native save dialog. Navigation, new windows and network requests are denied. All runtime assets are bundled, including PDF worker/font resources. A comparison is cancelled by terminating its worker. Bound input size, page count, text, decoded pixels, output and wall time; failures do not produce an identical result.

The engine owns `src/core/**` and its core tests. Desktop/UI owns `src/electron/**`, `src/renderer/**`, `index.html` and renderer tests. Root owns tooling, package/config files, CLI integration, docs, release/CI and end-to-end acceptance. Fixtures/reviewer owns `examples/**` and independent acceptance corpus/tests. No concurrent ownership of the same file.

Core public exports from `src/core/index.ts`:

- `compareDocuments(before: DocumentInput, after: DocumentInput, options?: Partial<CompareOptions>, onProgress?: (progress: CompareProgress) => void): Promise<ComparisonResult>`.
- `renderHtmlReport(result: ComparisonResult): string` produces escaped, self-contained HTML with no scripts or external dependencies.
- `serializeReport(result: ComparisonResult): string` emits versioned JSON.
- All types exported from `src/core/types.ts`.

`DocumentInput`: `{ name: string; bytes: Uint8Array }`.
`CompareOptions`: `{ ignoreWhitespace: boolean; ignoreHeaderLines: number; ignoreFooterLines: number; visualThreshold: number }` (defaults false, 0, 0, 24; visualThreshold is a per-channel pixel tolerance in 0..255).
`CompareProgress`: `{ phase: string; completed: number; total: number }`.
`ComparisonResult`: `{ schemaVersion: 1; documents: { before: DocumentInfo; after: DocumentInfo }; options: CompareOptions; rows: ComparisonRow[]; summary: { unchanged: number; changed: number; added: number; removed: number }; warnings: string[]; outcome: 'identical' | 'changed' | 'uncertain' }`.
`DocumentInfo`: `{ name: string; format: 'pdf' | 'docx'; sha256: string; pageCount: number }`.
`ComparisonRow`: `{ id: string; status: 'unchanged' | 'changed' | 'added' | 'removed'; beforePage: number | null; afterPage: number | null; beforeText: string; afterText: string; changes: TextChange[]; beforeImageDataUrl?: string; afterImageDataUrl?: string; visual?: { diffImageDataUrl: string; changedPixels: number; totalPixels: number; ratio: number } }`.
`TextChange`: `{ kind: 'equal' | 'added' | 'removed'; text: string }`. Schema 1 is frozen as the PDF-only contract. Page indices are zero-based; UI/report labels are one-based. Schema 2 adds explicitly tagged PDF page or DOCX paragraph/table-row locations; a DOCX logical block is never represented as a physical page. Its public types are exported alongside schema 1.

Use monotonic page alignment rather than matching pages solely by position: insertion/deletion must not shift all later matches. Text changes and visual changes are separate facts. Scanned/empty extraction remains visible; uncertain extraction must never imply identical documents. Header/footer/whitespace ignoring only omits the selected text differences; visual differences are shown separately with that distinction made clear.

## MVP acceptance

1. Deterministic synthetic PDFs: identical, changed word/number, inserted page, removed page, visual-only change, scanned/empty text and malformed input.
2. Real PDF.js decoding/rendering and bounded page matching in a worker; side-by-side images, visible text changes, visual overlay, page navigation and report export.
3. Actual app in a clean profile opens the corpus, compares, jumps to changes, exports and reopens HTML. Source files remain unchanged. Bad/cancelled work produces an explicit state, never a misleading result.
4. Working example PDFs and output, English README and Turkish quickstart, CI, support limits and license inventory. Public MVP repository/release only once the actual main flow works.

## Beta and v1

Add safe OOXML DOCX paragraphs and basic table cells, globally unique exact moved-block distinctions for PDF and DOCX, opt-in local English OCR for selected scanned pages with visible confidence/uncertainty, ignore controls, sequential batch comparison with per-job states and aggregate JSON, keyboard navigation, cancellation and packaged Windows/Linux builds. A standalone CLI is optional; batch functionality uses the same worker engine in the desktop UI. Reject archive traversal, duplicate/oversized XML entries, entity/DTD input, malformed/bomb documents and unsupported versions. No claim of complex PDF table semantics or legal interpretation.

Run the actual shipped packages on both declared platform profiles; record real output, memory/time on representative synthetic data, parser/budget/format compatibility checks, unsigned status, third-party licenses and SHA-256. Independent GPT-6 Luna xhigh final review by a different implementer; no open high/critical. Freeze the verified commit and publish v1.0.0 with acceptance evidence. Do not start BugPack before this gate passes. Do not fabricate physical Linux, pilot or adoption evidence.

## Visual design

A document-review workspace: navy `#20344d` chrome, pale blue `#edf3f9` workspace, white pages, ink `#183049`, deletion red `#ad2942`, addition teal `#076d58`. Segoe UI/system typography with clear 28/20/16/14px hierarchy. Left change list, two equal document columns, quiet top import/export toolbar. Useful page numbers and status text accompany colors. Focus rings, live progress, visible cancellation/error states and reduced motion are part of the main flow.
