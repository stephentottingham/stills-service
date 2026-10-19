/** Settings come from the environment, set by the CDK stack. No secrets here: those are read from Secrets Manager. */
function env(name: string, fallback?: string): string {
  const v = process.env[name] ?? fallback;
  if (v === undefined) throw new Error(`Missing environment variable ${name}`);
  return v;
}

export const config = {
  get region() { return env('AWS_REGION', 'eu-west-2'); },
  get table() { return env('TABLE_NAME'); },
  get originalsBucket() { return env('ORIGINALS_BUCKET'); },
  get renditionsBucket() { return env('RENDITIONS_BUCKET'); },
  /** Public base of the service, e.g. https://stills.bigsmall.tv (CloudFront). */
  get publicBase() { return env('PUBLIC_BASE').replace(/\/$/, ''); },
  get distributionId() { return env('DISTRIBUTION_ID', ''); },
  get signingKeyPairId() { return env('SIGNING_KEY_PAIR_ID'); },
  get signingKeySecret() { return env('SIGNING_KEY_SECRET'); },
  get cookieKeySecret() { return env('COOKIE_KEY_SECRET'); },
  get workQueueUrl() { return env('WORK_QUEUE_URL'); },
  get webhookQueueUrl() { return env('WEBHOOK_QUEUE_URL'); },
  get mailFrom() { return env('MAIL_FROM', ''); },
  get notifyTo() { return env('NOTIFY_TO', ''); },
  get userPoolId() { return env('USER_POOL_ID', ''); },
  get userPoolClientIds() { return env('USER_POOL_CLIENT_IDS', '').split(',').filter(Boolean); },
};
