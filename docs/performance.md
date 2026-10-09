# Scoped workload measurements

The following is one warm synthetic run of development source on Windows 11 Pro (`10.0.26300`), AMD Ryzen 9 8945HX, 32 logical processors and Electron 44.7.0. It is evidence of the named workload, not a throughput guarantee, maximum supported file size or an OS-enforced memory ceiling. Packaged Windows/Linux measurements remain pending.

| Workload | Inputs | Measured result |
| --- | --- | --- |
| DOCX paragraph/table comparison and native JSON save | 1,000 paragraphs and 500 table rows per document; 11,206 / 11,204 input bytes | 411.5 ms; exactly 2 changed and 1,498 unchanged units |
| Selected English OCR comparison and native JSON save | Two synthetic one-page scans with `1250` changed to `1350` | 882.4 ms; both confidence values 95; incomplete certainty retained |
| Entire sequential desktop acceptance workflow | PDF, DOCX, OCR and batch scenarios | Peak sampled owned-Electron working-set sum 699,068 KiB, sampled every 200 ms (58 samples) |

These figures came from the 20-step source acceptance artifact `acceptance-v1-f0962366-ef4e-4827-86ed-5688de029dd1`, before source/package freeze. Memory samples sum Electron's owned process metrics; short peaks between samples can be missed and the value is not an allocation bound. The reproducible corpus is under `examples/corpus` and `examples/v1/corpus`; manifests record sizes, hashes and expected changes. Run `npm run build` and `npm run test:e2e` to collect a fresh artifact on your machine. A release's `verification.json` binds its own measurements to the exact source and packages.
