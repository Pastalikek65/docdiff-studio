# DocDiff Studio

Compare two document revisions locally, inspect text and visual changes, and save a report that opens without an account or server.

DocDiff is for reviewing revised manuals, proposals and other documents where a changed number, word or page matters. The current MVP candidate supports digital PDFs. DOCX and opt-in local OCR are tracked in the [roadmap](docs/roadmap.md).

![Actual comparison of the synthetic word and number fixtures](examples/outputs/review.png)

See the [generated example HTML report](examples/outputs/comparison.html) or compare the included PDFs yourself. The screenshot and report come from the real desktop acceptance flow.

## Run from source

Requirements: Node.js 24, npm, Windows x64 or a Linux x64 graphical session. No paid API or application account is needed.

```sh
npm ci
npx install-electron --no
npm run build
npm start
```

Select `examples/corpus/word-number-before.pdf` as Before and `word-number-after.pdf` as After, then choose **Compare PDFs**. Inspect removed/added text and the page images, and use **Save HTML** to create a self-contained report. For the inserted-page example, use the two `insert-middle-*` PDFs: later pages should stay paired with their original pages.

[Türkçe hızlı başlangıç](docs/quickstart.tr.md) · [Support and limitations](docs/support.md) · [Contributing](CONTRIBUTING.md)

## Review behavior

- Side-by-side page previews, a visual difference layer, and a change list with page navigation.
- Separate text and appearance comparisons. Ignoring whitespace or selected header/footer lines does not hide visible appearance changes.
- Middle-page insertions and removals are aligned independently of page numbering.
- Pages with no extracted text stay visible as **Review needed**; matching images do not prove that scanned documents have the same text. Partial extraction on a text-bearing page cannot be detected reliably, so inspect the page previews.
- HTML with embedded images and versioned JSON, generated on this device.
- Cancellable worker processing, input/page/pixel/text/output limits, and explicit failed states.

Files are read only when selected. The desktop blocks external requests and navigation; parsing happens in a worker inside a sandboxed renderer. Reports contain document names, SHA-256 fingerprints, text and images, so treat exported reports as copies of potentially private documents. No telemetry or file-upload backend is included.

## Development and evidence

```sh
npm run typecheck
npm test
npm run test:e2e
npm run package
```

The corpus is synthetic and reproducible with `npm run fixtures`; its manifest binds bytes to expected behavior. End-to-end tests exercise actual PDF decoding, worker comparison, native save IPC with a simulated dialog choice, and reopening the produced HTML. Test evidence belongs to the exact tested build; a successful compile alone is not package acceptance. Unsigned archives and tested platform scope will be stated with each release.

Authored code and corpus: Apache-2.0. See [third-party notices](THIRD_PARTY.md) for bundled components, fonts and corresponding font source.
