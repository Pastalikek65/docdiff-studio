# Scoped workload measurements

The following measurements come from the actual extracted v0.2.0 packages at source `717b7cda111b94f54b1e8654c8428a4206ed9da8`. [CI 37884932867](https://github.com/Pastalikek65/docdiff-studio/actions/runs/37884932867) used Windows Server 2025 and Ubuntu 24.04 runners; a separate Windows 11 Pro (`10.0.26300`) run used the exact Windows CI ZIP. These are single warm synthetic observations, not a throughput guarantee, maximum supported file size or an OS-enforced memory ceiling.

| Observation | Windows CI package | Linux CI package | Same Windows ZIP on Windows 11 |
| --- | --- | --- | --- |
| DOCX comparison and native JSON save | 403.1 ms | 895.0 ms | 381.9 ms |
| Selected local English OCR comparison | 897.5 ms | 910.2 ms | 881.3 ms |
| Peak sampled owned-Electron working-set sum | 581,076 KiB | 827,372 KiB | 659,836 KiB |

The DOCX pair has 1,000 paragraphs and 500 table rows per document, 11,206 / 11,204 input bytes, exactly two changed units and 1,498 unchanged units. The OCR pair consists of synthetic single-page scans with `1250` changed to `1350`; both recognized-text confidence values were 95 and certainty remained incomplete. Memory samples cover the sequential 23-step PDF/DOCX/OCR/batch workflow at 200 ms intervals. They sum Electron's owned process metrics; short peaks between samples can be missed and the sum is not an allocation bound. Different runner resources and cache state prevent a platform speed ranking from these observations.

The Windows 11 machine has an AMD Ryzen 9 8945HX, 32 logical processors and 33,521,061,888 bytes of RAM. The CI package records and Windows 11 artifact `acceptance-v1-371834d2-0d1a-4232-a9f8-0abcad7c3263` retain the measurements and their scope. The reproducible corpus is under `examples/corpus` and `examples/v1/corpus`; manifests record sizes, hashes and expected changes. Run `npm run build` and `npm run test:e2e` to collect a fresh artifact on your machine. Each release's `verification.json` binds its own measurements to its exact source and packages.
