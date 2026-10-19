# Architecture

Everything is in **eu-west-2 (London)**, in the stills service's own AWS account. CloudFront is global, but it only caches; the files and data live in London.

```
                    ┌────────────── CloudFront (one distribution) ───────────────┐
 browser / apps ──▶ │ /          web bucket (library + editor screens)           │
                    │ /api/*     API Gateway (HTTP API) ─▶ authorizer ─▶ api Lambda
                    │ /g/*       API Gateway ─▶ gallery Lambda (public, no sign-in)
                    │ /r/*       signed only: renditions bucket ─(missing)─▶ renderer Lambda
                    │ /z/*       signed only: renditions bucket (zips)          │
                    └────────────────────────────────────────────────────────────┘
 browser ──PUT (presigned)──▶ originals bucket ──event──▶ SQS ──▶ processor Lambda
 api / gallery ──▶ SQS work ──▶ worker Lambda (zips, renders for new versions)
 everything ──▶ SQS webhooks ──▶ webhooks Lambda ──▶ engine / Happened
 daily ──▶ retention Lambda
```

## Storage

- **Originals bucket**: private and versioned, never served. S3 Intelligent-Tiering (as are renditions), so pictures nobody opens get cheaper on their own. `o/<still>/original.<ext>`. HEIC files also get a full-size JPEG master at `m/<still>/master.jpg`, because the Lambda build of sharp cannot read HEIC (HEVC licensing). We decode HEIC with libheif in WebAssembly instead.
- **Renditions bucket**: `r/<still>/<size>/v<version>.jpg`, made on demand; `z/<zip>/…` zips, deleted after 7 days.
- **DynamoDB**, one table: see `services/src/lib/model.ts` for keys and indexes.

## Renditions

A rendition is original + recipe at a size. Its address includes the recipe version, so caches never need clearing: a new version is a new address. CloudFront asks S3 first. If the file is not there yet, an origin group falls over to the renderer, a Lambda function URL that only CloudFront can call (origin access control). The renderer makes the file, stores it in S3, and streams it back. After a save, the worker makes `t` and `m` straight away, so galleries are quick.

## The preview matches the result

`packages/recipe` is plain TypeScript with no dependencies. The editor runs it in a Web Worker on a 2560 px copy of the original. The server runs the same code on sharp's decoded pixels (`services/src/lib/images.ts`). Anything that depends on picture size (clarity radius, vignette, crop) is set relative to the frame, so a small preview and a full-size render agree. A test checks this: mean difference under 2.5/255. The exception is sharpening, which is applied at each output size, like Lightroom's export sharpening.

Speed: a 24-megapixel full-size render with every control on takes about 11 seconds in this container. Thumbnail and screen sizes take a fraction of a second. Each version is rendered once, then cached.

## Access

- **Apps** have keys (SHA-256 stored) and may be limited to some companies.
- **People** use Cognito ID tokens. One Lambda authorizer handles both kinds, cached 5 minutes.
- **Galleries** are public by token (144 random bits), with an optional password (scrypt), and an HMAC-signed cookie scoped to that gallery's path for 12 hours. Pages are `noindex`, have no referrer, run under a strict content-security policy, and cannot be framed.
- **Rendition and zip links** are CloudFront signed URLs. The signing key is generated at deploy time by a custom resource, straight into Secrets Manager. It never appears in code, logs or templates.

## Decisions made for phase 1

| Question | Choice | Why |
|---|---|---|
| DynamoDB or Aurora | **DynamoDB**, single table | Like the engine. Search narrows by album, job or client index, then filters in memory, which is fine for tens of thousands of stills. Move search to Aurora or OpenSearch if the bank outgrows that. |
| Signed cookies or URLs | **Signed URLs** | A cookie would open every still on the distribution. A gallery must open only its own. |
| Serverless Image Handler | **Own renderer** | The recipe maths has to be ours, so that the editor can run it too. We kept the solution's idea: S3 first, Lambda on a miss, CloudFront in front. |
| Batch jobs | **SQS + Lambda** | Enough for phase 1 zips (up to 2,000 pictures in 15 minutes). Step Functions come in when batch looks and imports arrive (phase 2). |
| Exact duplicates | Keep the first, link it into the new album, drop the copy | "Never deleted" applies to near-duplicates. Those are only flagged (phase 2). |
| Auto straighten | Included, best effort | Only applied when the edges agree clearly. Otherwise it leaves the angle alone. |
| Uploads CORS | Any origin, until our own domains are set | The presigned URL is the protection. Naming the CloudFront domain would make a circular reference in the stack. |

## Open questions (from the brief), and the defaults in place

1. **Sign-in for producers.** Default: reuse the engine's pool (`eu-west-2_goGGlhmJ6`). It needs an app client and hosted sign-in domain from the engine thread. Set in `infra/config.ts`.
2. **Gallery domains.** Default: one shared address (the CloudFront domain). Per-company domains just need names and a certificate in `infra/config.ts`. Renditions are signed for the first domain, and the gallery page allows that domain for images. Same-origin downloads per company domain need a small change (sign per request host).
3. **Own screens, or the engine first?** Both work. The library and editor screens ship here, and the engine can use the API alone.
4. **RAW.** Not accepted yet. JPEG, PNG, HEIC and TIFF only. RAW waits for phase 3 (Adobe).
5. **Who owns galleries after a job ends.** Retention is per album. Galleries expire on their own date (30, 90 or 365 days).
6. **Adobe.** Not priced yet. Nothing in phase 1 depends on it.

## Rules carried over

- London only for files and data.
- No face analysis of any kind. Culling (phase 2) will use whole-picture blur and exposure scores.
- AI-made stills are flagged (`ai: true`), labelled in galleries and the library, and never chosen automatically.
- No secrets in code. Keys, the signing key, the cookie key and webhook secrets all live in Secrets Manager.
