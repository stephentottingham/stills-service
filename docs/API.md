# API

Base: `https://<distribution>/api` (see the `ApiBase` stack output). JSON in and out. British English in messages.

## Sign-in

- **Apps** (Production Engine, Happened): `Authorization: Bearer ssk_<app>_<secret>`. Keys are made by `scripts/create-app.mts` and stored in Secrets Manager. The service keeps only a SHA-256 of each key. An app can be limited to some companies.
- **People** (library screens): `Authorization: Bearer <Cognito ID token>`.

Errors are `{ "error": "Plain message", "code": "bad_request" }`, with status codes 400, 403, 404, 409 (someone else saved first), 410 (gallery closed) and 500.

## Albums

| | |
|---|---|
| `POST /albums` | `{name, company, client?, jobId?, look?, retentionDays?}` → album |
| `GET /albums?company=&client=&jobId=` | `{albums: [...]}`, newest first |
| `GET /albums/{id}` | album + `count` |
| `PATCH /albums/{id}` | any of the create fields |
| `POST /albums/{id}/uploads` | `{files: [{name, type, size}]}` (up to 500) → `{uploads: [{stillId, name, url, method: "PUT", headers}]}` |
| `POST /albums/{id}/stills` | `{ids}`: add existing stills (for "best of" albums) |
| `DELETE /albums/{id}/stills/{stillId}` | take a still out of the album (the still stays) |
| `POST /albums/{id}/import` | 501 until phase 2 |

`company` is one of `bigsmall`, `atspeed`, `serpentine`, `happened`.

**Uploading.** Ask for links, then `PUT` each file to its `url` with the given `content-type`. Links last an hour. Each file is processed when it arrives: `status` goes from `pending` to `ready` (or `failed`, or `duplicate` with `duplicateOf` when an identical file is already in the bank; the first copy is then added to this album). You get a `still.ready` webhook. Accepted: `image/jpeg`, `image/png`, `image/heic`, `image/heif`, `image/tiff`, up to 500 MB each.

## Stills

| | |
|---|---|
| `GET /stills?q=&tags=a,b&client=&jobId=&album=&company=&people=&orientation=&colour=&camera=&from=&to=&ai=&status=&limit=&cursor=` | `{stills, total, next?}` |
| `GET /stills/{id}` | a still (below). `?gps=1` includes GPS, for people only. |
| `PATCH /stills/{id}` | details: `title, description, tags, companies, client, jobId, credit, rights, release, people, ai` |
| `PUT /stills/{id}/recipe` | `{recipe, basedOnVersion, note?}` → the still at its new version. **409** if someone saved since `basedOnVersion`. |
| `POST /stills/{id}/auto` | `{recipe?}` → `{recipe, basedOnVersion}`. A suggestion; nothing is saved. |
| `GET /stills/{id}/versions` | `{current, versions: [{version, recipe, by, at, note, thumb}]}`, newest first, version 0 last |
| `POST /stills/{id}/revert` | `{version, basedOnVersion}` → saves that version's recipe as a new version |
| `DELETE /stills/{id}` | deletes the original, every version, every rendition and cached copy |

`status` defaults to `ready`; use `status=any` to see everything. `people` is `none`, `crowd` or `identifiable`. `orientation` is `landscape`, `portrait` or `square`. `colour` is a plain name (`red`, `blue`, `grey` …).

A still:

```jsonc
{
  "id": "st_01k...", "status": "ready", "filename": "IMG_0001.jpg",
  "w": 6000, "h": 4000, "orientation": "landscape", "colour": "#6a7f95", "colourName": "blue",
  "exif": { "camera": "Sony ILCE-7M4", "lens": "FE 35mm F1.4 GM", "takenAt": "2026-10-12T14:03:22.000Z", "iso": 400, "shutter": "1/250", "aperture": 2.8, "focalLength": 35 },
  "title": "…", "description": "…", "tags": ["cover"], "credit": "Sam Snapper",
  "companies": ["bigsmall"], "client": "Acme", "jobId": "job-42", "albumIds": ["al_01k..."],
  "rights": { "who": "Acme and Big Small TV", "where": "Social, UK", "until": "2027-12-31" }, "rightsExpired": false,
  "release": { "status": "signed", "url": "https://…" }, "people": "crowd", "ai": false,
  "recipe": { "v": 1, "exposure": 0.3 }, "version": 3, "versionAt": "…", "versionBy": "user:…",
  "sha256": "…", "phash": "c3e1…",
  "renditions": { "t": "<signed>", "m": "<signed>", "l": "<signed>", "full": "<signed>" },
  "base": "<signed l-size version 0: the unedited picture, for editors>"
}
```

## Renditions and signed links

Address: `/r/<stillId>/<size>/v<version>.jpg`. Sizes, by long edge: `t` 480, `m` 1920 (also the "web" download), `l` 2560, `full` (the original size). A new recipe means a new version, so a new address. The bytes at an address never change, so they are cached for a year.

Every `/r/` and `/z/` link is a CloudFront **signed URL** (canned policy, key pair id in `Key-Pair-Id`). Links from the API last until the end of the next day (UTC). Ask again for fresh ones; they are cheap. We use signed URLs rather than signed cookies so that a link opens one picture, not the whole bank.

Renditions are made on first request (CloudFront → S3 → renderer when missing), so a URL for any size and any past version works straight away.

## Recipes

```jsonc
{
  "v": 1,
  "rotate": 90, "flipH": true, "flipV": false, "straighten": -1.5,
  "crop": { "x": 0.1, "y": 0.05, "w": 0.8, "h": 0.9, "aspect": "4:5" },
  "exposure": 0.4,            // stops, -5..5
  "contrast": 10, "highlights": -30, "shadows": 20, "whites": 5, "blacks": -5,
  "temperature": 8, "tint": -3, "vibrance": 15, "saturation": 0, "warmth": 5,
  "clarity": 20, "localContrast": 15, "sharpen": 25, "bw": false,
  "vignette": -20
}
```

Sliders are -100..100 unless noted (`localContrast` and `sharpen` are 0..100). Missing means no change. The service tidies recipes (clamps, rounds, drops zeros) and rejects unknown fields. See [RECIPES.md](RECIPES.md).

## Galleries

| | |
|---|---|
| `POST /galleries` | `{album \| ids, company, title, password?, expiresDays: 30\|90\|365, downloads: none\|web\|full\|both, watermark?, jobId?, client?}` → gallery with `url` |
| `GET /galleries?jobId=&albumId=` | `{galleries}` |
| `GET /galleries/{token}` | a gallery (never the password) |
| `POST /galleries/{token}/withdraw` | ends the link at once |
| `GET /galleries/{token}/activity` | `{views, downloads, zips, events: [{at, kind, device, stillId?, size?}], selects: [], comments: []}` |

A gallery made from an album shows the album as it is now, including stills added later. A gallery made from `ids` shows those stills. Either way each picture is its current version. Send passwords separately from links. `watermark: true` is refused until watermarks arrive in phase 3. Selects and comments arrive in phase 2. An app limited to some companies can only make galleries whose stills it can see.

The public page is `GET /g/{token}`. It is unlisted, `noindex`, and has no referrer. The log keeps the time and device type (phone, tablet or computer), never IP addresses.

## Zips

| | |
|---|---|
| `POST /zips` | `{gallery \| ids, size: web\|full, email?}` → `202 {id, status}` |
| `GET /zips/{id}` | `{id, status: queued\|working\|ready\|failed, count, url?}` |

Made in the background. When ready: an email (if given) and a `zip.ready` webhook (only to apps allowed every company in the zip). Zip files are deleted after 7 days. Gallery visitors can ask for 5 zips an hour per gallery, and the emailed link still asks for the gallery's password.

## Saved searches

`GET /searches`, `POST /searches {name, query}`, `DELETE /searches/{id}`. They are per person.

## Webhooks

POSTed to the app's `webhookUrl` with:

```
content-type: application/json
x-stills-event: still.ready
x-stills-delivery: <id>
x-stills-signature: t=<unix seconds>,v1=<hex HMAC-SHA256 of "<t>.<raw body>">
```

Body: `{id, event, at, data}`. To check one, recompute the HMAC with the app's webhook secret (`stills-service/webhook/<app>`), compare in constant time, and reject anything older than 5 minutes. Answer 2xx. Anything else is retried with back-off (up to 8 tries), then parked in a dead-letter queue.

| Event | `data` |
|---|---|
| `still.ready` | the still, as from `GET /stills/{id}` |
| `still.version` | `{id, version, recipe}` |
| `gallery.viewed` | `{token, jobId?, albumId?}` |
| `zip.ready` | `{id, url, count, size, galleryToken?}` |
| `gallery.selects` | phase 2 |
