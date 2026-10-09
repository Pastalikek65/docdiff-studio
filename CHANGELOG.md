# Changelog

## 1.0.0 — release candidate

The feature beta scope below is retained. Fresh exact-version package qualification and old-MVP profile/report compatibility are required on Windows and Linux before stable publication. See [verification](docs/verification.md).

## 0.2.0 — published feature beta

- Compare supported DOCX main-body paragraphs and basic table cells with logical locations and explicit warnings for omitted content.
- Identify exact text moves only when the fingerprint is unique in both complete documents; preserve visual differences on moved PDF pages.
- Read selected image-only PDF pages with the bundled English OCR engine and model. Confidence remains heuristic and matching OCR text remains uncertain.
- Process up to 20 pairs sequentially, cancel the active worker, and export successful, failed, cancelled and not-run jobs in versioned batch JSON.
- Preserve the schema-1 PDF API while adding explicit schema-2 PDF/DOCX reports, bounded input/output processing and local-only OCR assets.
- Count changed table cells accurately and retain empty-cell additions/removals when whitespace is ignored, with explicit positions in the review and HTML report.

[Published beta](https://github.com/Pastalikek65/docdiff-studio/releases/tag/v0.2.0): 89 tests across 18 files and actual 23-step source/extracted-package flows passed on Windows and Linux; the exact Windows CI ZIP also passed on Windows 11. See [verification](docs/verification.md).

## 0.1.0 — PDF MVP preview

- Compare digital PDFs locally, with ordered page alignment, text changes and rendered appearance differences.
- Review inserted/removed pages, navigate changes, and save standalone HTML or versioned JSON.
- Keep image-only documents uncertain; reject malformed and over-budget inputs explicitly.
- Cancel the dedicated worker without creating a completed result.
- Include a deterministic synthetic corpus, real desktop screenshot/report, license inventory and source/platform acceptance harnesses.

This is a preview. See [support](docs/support.md), [verification](docs/verification.md) and [roadmap](docs/roadmap.md) for tested scope and pending v1 features.
