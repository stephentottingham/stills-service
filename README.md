# Stills Engine

One home for our stills across Big Small TV, At Speed Productions and Serpentine Creative (and Happened, later).

- **A bank of stills.** Every production's frames and photos are kept, catalogued and searchable, each tied to its client, engine job, company and usage rights.
- **Client galleries.** Branded, private pages where a client views and downloads pictures: full size or web size, one at a time or as a zip.
- **Non-destructive adjustments.** Originals never change. Each still has a recipe and a version number, and every link shows the current version. Change a recipe and every gallery and download shows the new version; nobody re-exports or re-sends anything.

This is a separate service with its own AWS account and deploys. The Production Engine and Happened use it through its API.

## Status: phase 1

| Done in phase 1 | Later |
|---|---|
| Browser upload (files and folders), JPEG, PNG, HEIC, TIFF | Desktop uploader and Lightroom re-export as versions (phase 2) |
| RAWs to the office Synology via a RAW inbox; JPEGs from RAW previews; connection test and time estimate before uploading ([docs/RAW.md](docs/RAW.md)) | |
| Processing: SHA-256 duplicates, perceptual hash, EXIF, IPTC, colour, size | Near-duplicate groups and culling (phase 2) |
| Albums, library search, saved searches | Drive, OneDrive and Frame.io imports (phase 2) |
| Recipes with the phase 1 controls, Auto, history, "back to this version" | Looks per album with batch apply, "match this one" (phase 2) |
| Versioned rendition links (`/r/<still>/<size>/v<n>.jpg`) | Descriptions by a vision model (phase 2) |
| Private galleries: password, expiry, withdraw, downloads, zips, view and download log | Client selects and comments (phase 2) |
| Retention per album, full deletion | Curves, HSL, Adobe Lightroom API, RAW, watermarks, engine migration (phase 3) |

## Layout

```
packages/recipe   The adjustment maths (TypeScript, no dependencies). Used by both the editor and the server.
services          Lambda handlers: API, galleries, processing, renderer, zips, webhooks, retention.
web               The library and editor screens (static, served at /).
infra             AWS CDK: the whole stack, plus a GitHub deploy role.
brands            Gallery branding per company.
scripts           Sharp layer build; app keys.
docs              API, architecture, recipes, setup, handback.
```

## Commands

```
npm install
npm test            # recipe maths + services (with in-memory AWS fakes)
npm run typecheck
npm run synth       # builds web + layer, synthesises CloudFormation (no AWS calls)
npm run deploy      # needs credentials for the stills account; see docs/SETUP.md
```

## Docs

- [docs/SETUP.md](docs/SETUP.md): the AWS account, first deploy, sign-in, email, app keys
- [docs/API.md](docs/API.md): endpoints, shapes, webhooks, signed links
- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md): how it fits together, and the decisions made
- [docs/RECIPES.md](docs/RECIPES.md): the adjustment maths
- [docs/RAW.md](docs/RAW.md): RAWs, the Synology and the upload planner
- [docs/HANDBACK.md](docs/HANDBACK.md): what the Production Engine thread needs
