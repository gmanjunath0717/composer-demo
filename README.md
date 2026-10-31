# card-composer

HTTP service that turns business card fields into a **proof image** and a **print-ready PDF**. A storefront sends the buyer's details, shows the returned proof, and after the buyer approves, asks for the print PDF, which is also dropped in a folder for pickup.

```
POST /proof   { templateId, version, fields }            ->  { proofUrl }   (PNG, shown to the buyer)
POST /render  { orderNo, lineId, templateId, ... }       ->  { pdfUrl, sftpPath }   (print PDF)
```

Layout is done by a **composer**. The default real composer (`html`) fills an HTML template and renders it with headless Chrome. A `stub` composer returns placeholder files for testing without Chrome.

## Quick start

Requirements: Node 22.2 or later (tested on 24), and Google Chrome or Chromium for the `html` composer. No `npm install` is needed; there are no dependencies.

```bash
npm start                    # stub composer on http://localhost:3000
COMPOSER=html npm start      # real card layout via headless Chrome
npm test                     # the html tests are skipped if Chrome is not found
```

Try it:

```bash
curl -X POST localhost:3000/proof -H 'content-type: application/json' -d '{"templateId":"bizcard","version":"1","fields":{"name":"Jane Doe","title":"Operations Manager","phone":"555-0100","email":"jane@example.com","dept":"Operations"}}'
```

The response contains a `proofUrl`; open it in a browser.

## API

All request and response bodies are JSON. Request bodies are limited to 64 KB.

### `POST /proof`

Request:

```json
{
  "templateId": "bizcard",
  "version": "1",
  "fields": { "name": "", "title": "", "phone": "", "email": "", "dept": "" }
}
```

All five fields are required and must be strings (empty strings are allowed).

Response `200`: `{ "proofUrl": "<PUBLIC_BASE_URL>/files/proofs/<templateId>-<hash>.png" }`

The file name is a hash of the request, so identical input returns the same URL.

### `POST /render`

Request: the same as `/proof`, plus `orderNo` and `lineId`.

Response `200`:

```json
{ "pdfUrl": "<PUBLIC_BASE_URL>/files/print/<orderNo>-<lineId>-<templateId>.pdf",
  "sftpPath": "/<orderNo>-<lineId>-<templateId>.pdf" }
```

The PDF is also copied to the SFTP folder under the same file name. Rendering the same `orderNo`, `lineId` and `templateId` again overwrites the earlier file.

`sftpPath` is `SFTP_PATH_PREFIX` + file name (prefix defaults to `/`).

### Errors

| Status | Body | When |
|---|---|---|
| `422` | `{ "error": "too_long", "field": "<name>" }` | Text does not fit in that field even at its smallest allowed size |
| `400` | `{ "error": "invalid_request", "detail": "<why>" }` | Bad JSON, missing or non-string field, invalid ID, or (`html` composer only) unknown `templateId`/`version` |
| `404` | `{ "error": "not_found" }` | Unknown route or file |
| `500` | `{ "error": "internal_error" }` | Unexpected failure (details in the server log) |

`orderNo`, `lineId` and `templateId` may contain only letters, digits, `_` and `-` (max 64 characters), because they become file names.

### Other endpoints

- `GET /health` returns `{ "ok": true, "composer": "<name>" }`.
- `GET /files/proofs/<file>` and `GET /files/print/<file>` serve generated files (`image/png`, `application/pdf`). The buyer's browser loads these directly.

## Output

| | Proof | Print PDF |
|---|---|---|
| Format | PNG, 1050 x 600 px (3.5 x 2 in at 300 dpi) | PDF, one page, 4.25 x 2.75 in |
| Contents | Trim area only | 3.5 x 2 in trim + 0.125 in bleed + 0.25 in slug with crop marks |
| Colour | RGB | RGB, vector text |

The PDF is **not PDF/X-4** and has no CMYK conversion or output intent. If the printer requires those, add a conversion step or a different composer.

## Configuration

All settings are environment variables (see `src/config.js`).

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `3000` | HTTP port. The service listens on all interfaces, plain HTTP. |
| `COMPOSER` | `stub` | `stub` or `html` |
| `PUBLIC_BASE_URL` | `http://localhost:$PORT` | Base URL put in `proofUrl` and `pdfUrl`. **Set this to the externally reachable URL**, or clients receive links they cannot open. |
| `IDS_ROOT` | `~/ids` | Parent of the working folders below |
| `TEMPLATES_DIR` | `$IDS_ROOT/templates` | Extra templates, checked before the bundled `templates/` folder |
| `PROOFS_DIR` | `$IDS_ROOT/output/proofs` | Generated proofs |
| `PRINT_DIR` | `$IDS_ROOT/output/print` | Generated print PDFs |
| `SFTP_DIR` | `$IDS_ROOT/sftp` | Copy of each print PDF, for pickup |
| `SFTP_PATH_PREFIX` | `/` | Prefix of the returned `sftpPath` |
| `CHROME_PATH` | Chrome's default install path for the OS (`google-chrome` on Linux) | Browser used by the `html` composer |

Folders are created at startup. Paths are built with `path.join`, so the service runs the same on macOS, Linux and Windows.

## Templates

A template is a single HTML file at `templates/<templateId>/<version>/card.html`. The bundled one is `templates/bizcard/1/card.html`. To add or change a layout, add a folder under `TEMPLATES_DIR` (or `templates/`).

The `html` composer loads the file, replaces the `<!--CARD_DATA-->` marker with `<script>window.CARD={mode, fields}</script>`, and renders it. The template must:

- Read `window.CARD.mode` (`"proof"` or `"print"`) and `window.CARD.fields`, and put the field text in with `textContent` (never as HTML).
- Set `document.body.className` to the mode, so the CSS can lay out proof and print differently.
- Do its own copyfit: shrink each field between a maximum and minimum size until it fits its box.
- Set the attribute `data-overflow` on `<body>` to a comma-separated list of the fields that still overflow at the minimum size, or an empty string if everything fits. The first listed field is returned as `too_long`. If the attribute is missing, the request fails with `500`.
- Declare the print page size with `@page { size: ...; margin: 0 }`. The PDF uses it as the page size.
- For the proof, lay out the card at 336 x 192 CSS px (3.5 x 2 in). It is captured at 3.125x scale to give 1050 x 600.

Template and version names must match `[A-Za-z0-9][A-Za-z0-9._-]*` (max 64 characters).

## Composers

A composer implements two functions and lives in `src/composers/`:

- `proof(request, outPath)` writes a PNG to `outPath`.
- `render(request, outPath)` writes a PDF to `outPath`.

Either throws `TooLongError(field)` when text cannot fit, or `UnknownTemplateError` for a missing template. The server handles routing, validation, file naming, the SFTP copy and error responses, so a new composer only needs to produce the file. Register it in `src/composers/index.js`.

**`html`**
- One headless Chrome is started at service startup (about 5 seconds) and kept running. Each request opens a tab in it over the DevTools protocol (Node's built-in WebSocket), so a proof or render takes about half a second.
- Chrome is restarted automatically if it dies, and is shut down on `SIGINT` / `SIGTERM`.
- Requests can run concurrently; each uses its own tab. There is no queue or concurrency limit.

**`stub`**
- Returns a placeholder PNG and a one-page PDF marked "STUB - NOT PRINT READY".
- Enforces simple per-field character limits (`fieldLimits` in `src/config.js`) so `too_long` can be tested.
- Ignores `templateId` and `version`, so it never returns an unknown-template error.

## Hosting notes

- **Chrome must be installed** on the host. Set `CHROME_PATH` if it is not at the default location.
- **Containers:** Chrome usually refuses to start as root inside a container without `--no-sandbox`. The launch flags are hard-coded in `src/composers/html.js` (`launchBrowser`), so this needs a code change or a non-root user with the right kernel settings.
- **Fonts:** the template uses `Helvetica Neue`, falling back to `Helvetica`, `Arial` and then the system sans-serif. Text width, and therefore copyfit, depends on which fonts the host has. Install or bundle the fonts you want so output is the same on every machine.
- **Storage:** proofs and PDFs are written to local disk and served by the same process. More than one instance behind a load balancer needs shared storage (or a change to serve files from object storage), because a file only exists on the instance that made it.
- **SFTP:** "SFTP delivery" is a copy into `SFTP_DIR`. Point that folder at the directory your SFTP server exposes, or add an upload step.
- **No authentication** on any endpoint, and **no cleanup** of old files. Put the service behind your gateway or add an API key, and add a retention job for the output folders.
- **TLS:** the service speaks plain HTTP; terminate TLS in front of it.

## Project layout

```
src/index.js               start-up, signal handling
src/server.js              routes, validation, file serving, error mapping
src/config.js              environment configuration
src/composers/index.js     composer registry and error types
src/composers/html.js      headless Chrome composer
src/composers/stub.js      placeholder composer
templates/bizcard/1/       bundled business card template
test/                      node:test suites (stub and html)
```

## Tests

```bash
npm test
```

The suites start their own server on a random port with a temporary working folder, so they do not touch a running service or your real output folders. The `html` suite is skipped when Chrome is not found.

See [CHECKLIST.md](CHECKLIST.md) for what is implemented and what remains before production use.
