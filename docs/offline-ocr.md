# Local English OCR

This describes the v1 development design. It is not part of the qualified v0.1.0 PDF preview and has not yet passed the stable package gate.

OCR is optional and applies only to explicitly selected PDF pages whose extracted text is empty. Select pages on both documents separately. Pages with any selectable text use that text layer; DocDiff cannot reliably detect partial extraction. OCR does not apply to DOCX.

The build supplies Tesseract.js 7.0.0, matching core 7.0.0, every supported WASM variant and the pinned official English fast model. Assets are served from the app's own `vendor/ocr/` directory. The runtime must set explicit local worker/core/language paths, `gzip: false`, `cacheMethod: 'none'` and `workerBlobURL: false`. A failed local asset load is an error, not permission to fetch a CDN fallback. Model notices, compiled-library notices and hashes are in `third_party/ocr/`.

The renderer owns the OCR worker and bridges bounded page images to it from the comparison worker. It must terminate both workers on cancellation, deadline or failure, including cancellation during model initialization. No OCR text or page pixels are cached or written to application storage. Exports deliberately contain recognized text and previews; inspect them before sharing.

An OCR confidence value is the engine's heuristic score, not a probability of correctness. Review recognized words and numbers against the page image. A matching OCR-derived text result remains uncertain even with a high score. Detected differences may be shown with uncertainty warnings. Empty or low-confidence recognition must never be treated as proof that documents are identical.

Package acceptance must exercise genuine recognition with network requests blocked, both page selections, uncertain matching scans, cancellation while OCR is active and missing-asset failure. Confidence values and duration vary with the engine and input; qualification records must preserve observed results rather than promise a fixed score.
