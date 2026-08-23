# getprdiff-files-api-fallback

`getPrDiff` falls back to the paginated pull-request files API when GitHub
refuses `gh pr diff` with HTTP 406 / too_large. Omitted text patches are
materialized from Git blobs / contents. A 3000-file list fails closed.
