/**
 * Deployment settings. Nothing secret lives here.
 * Open questions from the brief are marked OPEN; the defaults are what we chose for phase 1.
 */
export const settings = {
  /** London only, for files and data. */
  region: 'eu-west-2',

  /**
   * The service's own AWS account (a new account in the same AWS Organization as
   * 920373021810). Set STILLS_ACCOUNT, or deploy with a profile for that account.
   */
  account: process.env.STILLS_ACCOUNT ?? process.env.CDK_DEFAULT_ACCOUNT,

  /**
   * OPEN: sign-in for producers. Default: reuse the engine's Cognito pool, so
   * people sign in once. The pool lives in the engine's account; the engine
   * thread adds an app client for the stills screens and gives us its id.
   */
  cognito: {
    userPoolId: process.env.STILLS_USER_POOL_ID ?? 'eu-west-2_goGGlhmJ6',
    /** App client ids allowed to call the API (the stills web client, and the engine's own if it passes people's tokens through). */
    clientIds: (process.env.STILLS_USER_POOL_CLIENT_IDS ?? '').split(',').filter(Boolean),
    /** Hosted sign-in domain, e.g. https://auth.bigsmall.tv. Used by the library screens. */
    hostedUiDomain: process.env.STILLS_COGNITO_DOMAIN ?? '',
    /** The client id the library screens sign in with. */
    webClientId: process.env.STILLS_WEB_CLIENT_ID ?? '',
  },

  /**
   * OPEN: gallery domains. Phase 1 serves everything from one distribution.
   * Add domain names (and an ACM certificate in us-east-1 covering them) to use
   * your own, e.g. ['stills.bigsmall.tv', 'gallery.bigsmall.tv', 'gallery.speed.productions'].
   */
  domainNames: (process.env.STILLS_DOMAINS ?? '').split(',').filter(Boolean),
  certificateArn: process.env.STILLS_CERTIFICATE_ARN,

  /** SES sender for zip links (the domain must be verified in SES in eu-west-2). */
  mailFrom: process.env.STILLS_MAIL_FROM ?? '',
  /** Where alarms go (dead-letter queues filling up). */
  alarmEmail: process.env.STILLS_ALARM_EMAIL ?? '',

  /** Extra origins allowed to PUT uploads straight to S3 (local development). */
  devOrigins: ['http://localhost:5173'],

  /** GitHub repository allowed to deploy through the deploy role (OIDC). */
  githubRepo: process.env.STILLS_GITHUB_REPO ?? 'stephentottingham/stills-service',
};
