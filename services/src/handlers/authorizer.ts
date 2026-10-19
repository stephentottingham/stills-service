import { createHash } from 'node:crypto';
import type { APIGatewayRequestAuthorizerEventV2, APIGatewaySimpleAuthorizerWithContextResult } from 'aws-lambda';
import { CognitoJwtVerifier } from 'aws-jwt-verify';
import { getItem } from '../lib/aws';
import { config } from '../lib/config';
import { App } from '../lib/model';

type Result = APIGatewaySimpleAuthorizerWithContextResult<Record<string, string>>;

let verifier: ReturnType<typeof CognitoJwtVerifier.create> | undefined;

/**
 * One authorizer, two kinds of caller:
 *  - apps (the Production Engine, Happened) send "Authorization: Bearer ssk_<app>_<secret>";
 *    we keep only a SHA-256 of the key;
 *  - people send a Cognito ID token from the sign-in.
 */
export async function handler(event: APIGatewayRequestAuthorizerEventV2): Promise<Result> {
  const header = event.headers?.authorization ?? event.headers?.Authorization ?? '';
  const token = header.replace(/^Bearer\s+/i, '').trim();
  const deny: Result = { isAuthorized: false, context: {} };
  if (!token) return deny;

  if (token.startsWith('ssk_')) {
    const hash = createHash('sha256').update(token).digest('hex');
    const app = await getItem<App & { disabled?: boolean }>(`APPKEY#${hash}`);
    if (!app || app.disabled) return deny;
    return { isAuthorized: true, context: { kind: 'app', id: app.app, companies: (app.companies ?? []).join(',') } };
  }

  if (!config.userPoolId) return deny;
  verifier ??= CognitoJwtVerifier.create({
    userPoolId: config.userPoolId,
    tokenUse: 'id',
    clientId: config.userPoolClientIds,
  });
  try {
    const claims = await verifier.verify(token);
    return {
      isAuthorized: true,
      context: {
        kind: 'user',
        id: String(claims.sub),
        email: String(claims.email ?? ''),
        name: String(claims.name ?? claims.email ?? ''),
      },
    };
  } catch {
    return deny;
  }
}
