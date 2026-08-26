# Blocklist fixtures

Deterministic, local payloads for the sync pipeline tests. Nothing here is downloaded,
and nothing here is ever inserted into a real database — the integration suite runs
only against a scratch database named by `SADA_TEST_DB_URL`.

| File                  | What it exercises                                                |
| --------------------- | ---------------------------------------------------------------- |
| `valid-small.txt`     | A clean list, one domain per line, LF endings.                   |
| `unordered.txt`       | The same set as `valid-small.txt` in a different order.          |
| `duplicates.txt`      | The same set with duplicates and case variants.                  |
| `crlf.txt`            | The same set with CRLF line endings, blank lines and whitespace. |
| `malformed.txt`       | Mostly invalid entries — trips the valid-line ratio check.       |
| `suspicious.txt`      | A tiny but perfectly valid list — trips the minimum-count check. |
| `html-error-page.txt` | An HTML error page, the "200 OK with the wrong body" case.       |
