# MVP verification record

The PDF MVP is a preview, not a qualified stable v1. Its source fixtures and acceptance harness are checked in so the workflow can be reproduced.

On Windows x64, Node 24 and Electron 44.7.0, the initial integration passed TypeScript checks and 27 tests across seven files. Seven independent browser acceptance cases use the actual PDF.js worker: page insertions/removals, text/visual changes, scan uncertainty, malformed/resource-limited inputs, escaping, source-byte confidentiality and cancellation. The corpus manifest SHA-256 is `d984e03245c401f7a2972f0052c0602c06fcff4a0bd1869fdd9a8e7f9d2b753d`.

The built Electron app and an extracted Windows ZIP each passed the eight-step desktop flow: isolated startup, real worker changes, native save IPC with a simulated dialog choice, reopening standalone HTML and decoding images, page insertion alignment, identical inputs, malformed-input failure, cancellation, a reachable loopback network canary blocked by the renderer, and unchanged source fixtures. The harness does not claim manual native-dialog testing. It uses no worker replacement or comparison mocks.

The initial Windows archive contained no application `node_modules` tree or `.node` bindings. It included the corresponding Liberation font source and 26 license/notice files inside its application archive, plus Electron's original notices. Its pre-publication local hash was `b8cc6dd765c66d29247ee01c54c5c6a86401b48a104cf598400d681da9a46e0a`; release packages will have their own checksums and exact-source CI evidence.

The full development dependency audit has eight moderate findings through one `sprintf-js` denial-of-service advisory in build tools, and zero high/critical findings. These moderate findings remain open; moving browser libraries to build-time dependencies does not exclude them from the full audit.

Linux and exact published package qualification are pending. CI runs the actual source and extracted-package flow on Windows and Ubuntu 24.04 with Chromium sandboxing enabled. Each release must name its exact source and evidence. DOCX, OCR, moved-block detection and batch/CLI workflows remain future work.
