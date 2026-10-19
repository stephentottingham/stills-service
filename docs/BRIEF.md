# Stills service: brief for a new build

_A condensed copy of the Production Engine repo's docs/STILLS-SERVICE-BRIEF.md (19 Oct 2026, owner Steve), kept here so this repo stands on its own. The engine's copy is the original._

## 1. What it is for

One home for our stills, across Big Small TV, At Speed Productions and Serpentine Creative (and Happened, later). It does three things:

- **A bank of stills for clients and productions.** Every production's frames and photos are kept, catalogued and searchable. Each one is tied to its client, production (engine job), company and usage rights.
- **Online galleries for clients.** Branded, private pages where a client views, chooses and downloads images. Downloads come in full size and web size, singly or as a zip.
- **Adjustments, as many as we can offer, and never destructive.** Auto, Lightroom-style controls, looks (presets) per album, batch changes. Links that update when an edit changes: change the look, and every gallery and every download shows the new version. Nobody re-exports or re-sends anything.

It is a separate build with its own repo, its own AWS account and its own deploys. The Production Engine and Happened use it through its API.

## 2. Who uses it

| Who | What they do |
|---|---|
| Producers and editors (our three companies) | Add stills, organise, adjust, pick the ones for a deck, make a client gallery |
| Photographers (staff and freelance) | Upload or export from Lightroom into an album; re-export to replace a version |
| Clients | Open a gallery link (password, expiry), view full screen, mark favourites, download |
| Production Engine | Reads and writes albums per job; imports stills into decks; makes delivery galleries from a job |
| Happened (later) | Stores event photos in albums; each guest's gallery is a set of photo IDs Happened chooses |

## 3. What it must do

### Library

Ingest: browser upload, including drag and drop of folders; the desktop uploader watching a Lightroom export folder (Happened already has one: spotted/uploader/); imports from Google Drive, OneDrive and Frame.io links. JPEG, PNG, HEIC and TIFF from the start. RAW is phase 3.

Deduplication: a SHA-256 hash of the original for exact copies, and a perceptual hash for near-duplicates. Near-duplicates are flagged for a choice, never deleted.

Details kept per still: EXIF (camera, lens, date, GPS hidden by default); IPTC captions and credits from Lightroom; title and description; tags; company or companies; client; job (engine job id); folder or album; credit (the photographer); rights and usage ("who can use it, where, until when"); release status (a link to the engine's release form when there is one); people (none | crowd | identifiable); ai (an AI-made image, always labelled, and never chosen automatically).

Description: each still is described once by a small vision model (the engine uses Claude Haiku for this today, at about 1/10p each): one sentence, tags from a fixed list, a people level and "good for" (cover, background, card, portrait). It never names or guesses who a person is.

Search: words, tags, client, job, date, camera, colour and orientation. Saved searches. Folders and albums (an album can be a production, an event or a "best of" selection drawn from others).

Culling for large sets: sharpness (blur) and exposure scores from the whole picture; near-duplicate groups; "show the best of each group". No face analysis.

### Adjustments: non-destructive "recipes"

Originals never change. Each still has a saved recipe (JSON) and a version number. An album can have a look (a preset) that its stills start from.

Controls, phase 1: exposure, contrast, highlights, shadows, whites, blacks; white balance (temperature and tint), vibrance, saturation, warmth; clarity (local contrast), sharpen, black and white; crop with aspect presets (16:9, 4:5, 1:1, 3:2, free), straighten, rotate, flip; vignette.

Auto: auto levels and tone, auto white balance (grey world, or the brightest neutral area), local-contrast auto (CLAHE), and auto straighten if feasible. Shown as one button that sets the sliders.

Batch: copy and paste settings; apply a look to an album or a selection; "match this one" (copy the white balance and exposure from a chosen still).

History: every change kept (who and when), with before and after, and "back to this version".

The preview must match the result: same maths in the editor's live preview and on the server.

Phase 3 (Adobe): Adobe's Lightroom API (Firefly Services, enterprise agreement) for Lightroom's own Auto Tone and Auto Straighten, XMP presets on the server, and RAW. Price it with Adobe before building.

### Client galleries

Branded per company: logo, colours, fonts, its own domain (the engine's brand folders hold these: src/brands/<id>/brand.json). Access: private, unlisted and noindex; optional password; expiry after 30, 90 or 365 days; "withdraw" ends the link at once. Viewing: full-screen viewer, swipe on a phone, arrow keys on a computer. Downloads: full size, web size or both; one still or all as a zip (made in the background, then emailed as a link); optional watermark on previews. Client feedback: selects and a comment per still; we get an email and see their selects. Logs: view and download log (time, and phone, tablet or computer; no IPs shown). Galleries show the latest versions; downloads always give the current version.

### Retention and deletion

Each album has a retention setting (Happened's photos are kept 365 days). Delete means everything: the original, every version and every cached copy. An API call deletes a person's data on request.

## 4. Suggested architecture

AWS, London (eu-west-2). A new AWS account in the same AWS Organization as 920373021810, with its own deploy role. S3 originals (private, versioned) and renditions. Lambda with sharp for versions; each version's address includes the recipe version (/r/<still>/<size>/v<recipe-version>.jpg). CloudFront with signed links. SQS and Step Functions for background work. DynamoDB (single table) or Aurora Serverless; OpenSearch only if needed. API Gateway or function URLs; per-app keys.

## 5–7. API sketch, engine and Happened links

See docs/API.md (the built API) and docs/HANDBACK.md. Happened keeps its own face matching; the stills service never receives face data.

## 8. Rules that carry over

London only. No face analysis. Private by default. Secrets in Secrets Manager. No AI likenesses of real people; AI images flagged and never chosen automatically; estimate paid AI costs and get Steve's OK. British English, plain and short. Commit before deploying; don't commit or push unless Steve asks.

## 9. Build order

Phase 1: account and stacks; browser upload and processing; albums and library list; recipe with basic controls, Auto and versioned links; private galleries with downloads and zips.
Phase 2: desktop uploader and Lightroom re-export as versions; looks and batch; culling; selects and comments; Drive/OneDrive/Frame.io imports; descriptions.
Phase 3: full control set (curves, HSL); Adobe Lightroom API; watermarks; engine migration; Happened events.

## 10. Open questions for Steve

Sign-in (reuse the engine's Cognito pool eu-west-2_goGGlhmJ6, or own); gallery domains (per company or shared); own screens or engine first; RAW or exported JPEGs; gallery ownership after a job (retention per client or album); Adobe pricing now or later.
