# Handback to the Production Engine thread

Phase 1 is built and tested, but **not yet deployed**. The values marked _after deploy_ come from the stack outputs once Steve has created the account and run the first deploy (docs/SETUP.md).

## 1. Base URL and key

- API base: `https://<PublicBase>/api` (_after deploy_: the `ApiBase` output).
- Engine key: made by `npx tsx scripts/create-app.mts --app engine --webhook <engine hook URL>`. It is stored in the stills account at Secrets Manager `stills-service/apps/engine`. Copy it into `proposal-engine/app` as **`stillsServiceKey`**. Never paste it in chat.
- Send it as `Authorization: Bearer <stillsServiceKey>`.

## 2. The API

See [API.md](API.md) for endpoints, shapes and webhooks. The parts the engine uses most:

- Job album: `POST /albums {name, company, client, jobId}`; `GET /albums?jobId=<id>`.
- Still picker: `GET /stills?q=&client=&jobId=&tags=&orientation=&people=&ai=false`. Use the `renditions.m` or `renditions.t` URLs.
- Edit button: `GET /stills/{id}`, then `PUT /stills/{id}/recipe {recipe, basedOnVersion}`. Handle 409 ("someone saved first"). Use `POST /stills/{id}/auto` for the Auto button.
- Deliver stills: `POST /galleries {album: <job album id>, company, title, password?, expiresDays, downloads}`. Show `url`, then `GET /galleries/{token}/activity` for the log.

## 3. Previews inside the engine: signed links

Every rendition URL in a response is a CloudFront signed URL, valid until the end of the next day (UTC). The engine should **not** store them. Store the still id and ask again (`GET /stills/{id}` or a search) when drawing a deck or page. URLs stay the same within a day, so browsers cache them. No cookies, IAM or CloudFront setup is needed on the engine side.

A deck that keeps its own crop (`slide.crop[stillId] = {x, y, z}`) can keep doing so on top of the `l` or `full` rendition. Or it can save the crop into the recipe if it should apply everywhere.

## 4. Album-to-job mapping

`jobId` is a plain string field on albums, and on stills uploaded into them. It is indexed (GSI2 `JOB#<jobId>`), so `GET /albums?jobId=`, `GET /stills?jobId=` and `GET /galleries?jobId=` are direct lookups. One job can have several albums. Use the oldest (last in the list) as "the job album", or keep its id on the job.

## 5. IAM and CloudFront for the engine's Lambda

None. The engine calls the API over HTTPS with its key. Its runtime role `proposal-engine-runtime` (920373021810, eu-west-2) needs only `secretsmanager:GetSecretValue` on its own `proposal-engine/app` secret, which it already reads.

## 6. Webhook address the engine should expose

`POST /api/stills-service/hook`. Verify `x-stills-signature: t=<ts>,v1=<hex>` as the HMAC-SHA256 of `"<ts>.<raw body>"`, using the secret in the stills account at `stills-service/webhook/engine` (copy it into `proposal-engine/app` as `stillsServiceWebhookSecret`). Reject anything older than 5 minutes, and answer 2xx quickly. Events: `still.ready`, `still.version`, `gallery.viewed`, `zip.ready` (`gallery.selects` in phase 2).

## 7. Still to decide (with Steve)

- Sign-in: if the stills screens reuse the engine's pool, the engine thread adds an app client (with hosted sign-in) for the stills domain and passes its id and domain on.
- Migration of the engine's ~1,800 stills: phase 3. A one-off script will keep ids where possible (ids are free-form strings), and keep folders, tags, descriptions and client stills.
