# Support contract

The current candidate is a PDF MVP under active qualification. No stable release or successful package/platform qualification is claimed yet.

The engine reads digital PDFs, extracts a text layer and renders page appearance with bundled PDF.js assets. Encrypted/password-protected or malformed files fail explicitly. External document links, JavaScript, embedded attachments and interactive forms are not executed. Images represent page rendering; text does not preserve every typographic or reading-order detail. Visual equality is bounded by the selected rendering scale and pixel tolerance, not a byte-level or legal equivalence claim.

Page matching preserves monotonic order and uses text/appearance anchors. Duplicate/reordered pages can be ambiguous; review the displayed pairing. A document without reliable extracted text has an uncertain outcome even if its rendered pages match. Complex PDF table semantics and legal interpretation are outside v1 scope.

Limits: 50 MiB per input, 100 MiB combined, 200 pages per document, 100,000 characters per page, 2,000,000 extracted characters total, 80,000,000 cumulative processed pixels, normalized page previews up to 1200×1600, 12,000,000 pixels per decoded image, 48 MiB embedded image data, 64 MiB report and a 120-second worker budget. These are rejection limits, not throughput guarantees. A physical page is downscaled before rendering. An error, interrupted job or exceeded budget produces no completed comparison.

Files stay local. The main process offers only a sender-bound, size-limited save dialog operation. No account, cloud processing or paid API is needed. Saved reports deliberately contain document text and page images; inspect them before sharing. Source files are not modified by comparison. A save operation can replace a user-selected report path; it requires the chosen output extension.

Windows and Linux x64 are the qualification targets. Linux desktop use needs a graphical session and Electron system libraries; Linux CI uses Xvfb. Portable archives are unsigned unless a later release explicitly says otherwise. A future release's verification record will identify exact packages, source commit, platform evidence, limitations and open findings.
