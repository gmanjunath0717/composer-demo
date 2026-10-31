# Status

## Implemented

- [x] `POST /proof` returns a proof PNG URL
- [x] `POST /render` returns a print PDF URL and an SFTP path, and copies the PDF to the SFTP folder as `<orderNo>-<lineId>-<templateId>.pdf`
- [x] `too_long` response (HTTP 422) naming the field that does not fit
- [x] Input validation, safe file names, path-traversal protection on file serving
- [x] `html` composer: headless Chrome, 300 dpi proof, print PDF with bleed and crop marks, font-size copyfit
- [x] `stub` composer for testing without Chrome
- [x] All folders, URLs and the Chrome path configurable by environment variable
- [x] Chrome kept warm and restarted if it dies; shut down cleanly on `SIGINT` / `SIGTERM`
- [x] Automated tests for both composers (`npm test`)

## Before hosting in the cloud

- [ ] Install Chrome or Chromium on the host and set `CHROME_PATH`
- [ ] Make Chrome start in a container (needs `--no-sandbox` or a non-root setup; flags are in `src/composers/html.js`)
- [ ] Install or bundle the template fonts so copyfit and layout match across machines
- [ ] Set `PUBLIC_BASE_URL` to the externally reachable URL
- [ ] Terminate TLS in front of the service
- [ ] Add authentication (the service has none)
- [ ] Move output to shared or object storage if running more than one instance
- [ ] Connect `SFTP_DIR` to a real SFTP server, or add an upload step
- [ ] Add a retention job for `PROOFS_DIR`, `PRINT_DIR` and `SFTP_DIR`

## Not implemented

- [ ] PDF/X-4, CMYK conversion and output intents (PDFs are RGB)
- [ ] Request queue, concurrency limit and rate limiting
- [ ] Structured logging and metrics
- [ ] CI pipeline
- [ ] Further templates beyond `bizcard` v1
