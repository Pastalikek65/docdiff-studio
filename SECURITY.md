# Security

Report a vulnerability through GitHub's private vulnerability reporting for this repository when enabled. Avoid posting private PDFs, document text, reports or credentials in public issues. For non-sensitive defects, use a synthetic reproducer.

The current MVP candidate has no stable support line yet. Qualified releases will identify their supported line and known limits. Use the newest published supported version once available.

The desktop blocks external requests, navigation, new windows and webviews. Its renderer is sandboxed with context isolation and no Node integration. Files are explicitly selected, parsed in a bounded worker, and not uploaded. A report can contain the full imported content. This architecture reduces exposure; it is not a proof against every malicious document or an OS sandbox replacement.
