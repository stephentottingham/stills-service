# Setup

Nothing here has been run yet. These are the steps for the first deploy.

## 1. The AWS account

Create a new member account in the same AWS Organization as `920373021810` (for example `stills-engine`). Keep it separate from the engine's account. The engine's deploy user stays scoped to `proposal-engine-*`.

Then, with admin credentials for the **new** account:

```
export STILLS_ACCOUNT=<new account id>
npx cdk bootstrap aws://$STILLS_ACCOUNT/eu-west-2
npx cdk bootstrap aws://$STILLS_ACCOUNT/us-east-1   # only if you add your own domains (ACM certificates for CloudFront live there)
```

## 2. Settings

All settings are in `infra/config.ts`, read from environment variables. None of them are secret.

| Variable | What |
|---|---|
| `STILLS_ACCOUNT` | the new account id |
| `STILLS_USER_POOL_ID` | defaults to the engine's pool `eu-west-2_goGGlhmJ6` |
| `STILLS_USER_POOL_CLIENT_IDS` | Cognito app client ids allowed to call the API |
| `STILLS_COGNITO_DOMAIN`, `STILLS_WEB_CLIENT_ID` | the hosted sign-in domain and client for the library screens (callback and sign-out URL: `https://<distribution>/`) |
| `STILLS_DOMAINS`, `STILLS_CERTIFICATE_ARN` | optional: your own domains, and an ACM certificate in us-east-1 |
| `STILLS_MAIL_FROM` | sender for zip emails; verify the domain in SES (eu-west-2) and leave the SES sandbox |
| `STILLS_ALARM_EMAIL` | where dead-letter alarms go |

## 3. Deploy

```
npm install
npm test
npm run deploy        # builds the screens and the sharp layer, then cdk deploy --all
```

The first deploy makes the CloudFront signing key (in Secrets Manager, by a custom resource), the cookie key, buckets, table, queues, functions and the distribution. Note the outputs: `PublicBase`, `ApiBase`, `SigningKeyPairId`.

To deploy from GitHub Actions instead, deploy `StillsEngineDeployAccess` once by hand, then set the repository variables `AWS_DEPLOY_ROLE_ARN` (its output) and `STILLS_ACCOUNT`. `.github/workflows/deploy.yml` uses OIDC, so no keys are stored.

## 4. Apps

```
npx tsx scripts/create-app.mts --app engine --webhook https://<engine>/api/stills-engine/hook
npx tsx scripts/create-app.mts --app happened --companies happened      # later
```

The key goes to Secrets Manager `stills-engine/apps/<app>`, and the webhook secret to `stills-engine/webhook/<app>`. The script never prints them. Copy the engine's key into the engine's secret `proposal-engine/app` as `stillsServiceKey`.

## 5. The Synology (RAWs)

Follow [RAW.md](RAW.md): one IAM access key, typed straight into Cloud Sync on the Synology.

## 6. Brands

Copy colours, fonts and logos from the engine's `src/brands/<id>/brand.json` into `brands/<id>.json`. Put logos in `web/public/brand/<id>/` and set `"logo": "/brand/<id>/logo.svg"`. Until then, galleries show the company name as text.

## Local work

```
npm run dev -w web       # rebuilds the screens on change
npm test                 # all logic runs against in-memory AWS fakes
```
