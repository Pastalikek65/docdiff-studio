# Security

Report a vulnerability through [GitHub's private vulnerability reporting](https://github.com/Pastalikek65/docdiff-studio/security/advisories/new). Avoid posting private PDFs, document text, reports or credentials in public issues. For non-sensitive defects, use a synthetic reproducer.

The published 0.x builds are previews. Stable v1.0.0 is qualified on Windows and Linux; use the newest published stable 1.x release and check its [verification record](docs/verification.md) for exact package hashes and tested scope. A development branch or successful build alone is not release qualification.

The desktop blocks external requests, navigation, new windows and webviews. Its renderer is sandboxed with context isolation and no Node integration. Files are explicitly selected, parsed in a bounded worker, and not uploaded. A report can contain the full imported content. This architecture reduces exposure; it is not a proof against every malicious document or an OS sandbox replacement.
