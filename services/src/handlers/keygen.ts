import { generateKeyPairSync } from 'node:crypto';
import {
  SecretsManagerClient,
  PutSecretValueCommand,
  GetSecretValueCommand,
} from '@aws-sdk/client-secrets-manager';
import { createPublicKey } from 'node:crypto';

const sm = new SecretsManagerClient({});

/**
 * CloudFormation custom resource: makes the RSA key pair CloudFront uses to
 * check signed URLs. The private key goes straight into Secrets Manager and
 * never appears in code, logs or CloudFormation; only the public key is returned.
 * Re-running keeps the existing key.
 */
export async function handler(event: { RequestType: string; ResourceProperties: { SecretArn: string }; PhysicalResourceId?: string }) {
  const arn = event.ResourceProperties.SecretArn;
  if (event.RequestType === 'Delete') return { PhysicalResourceId: event.PhysicalResourceId };

  let pem: string | undefined;
  try {
    const existing = await sm.send(new GetSecretValueCommand({ SecretId: arn }));
    if (existing.SecretString?.includes('PRIVATE KEY')) pem = existing.SecretString;
  } catch {
    pem = undefined;
  }
  if (!pem) {
    const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    pem = privateKey.export({ type: 'pkcs1', format: 'pem' }).toString();
    await sm.send(new PutSecretValueCommand({ SecretId: arn, SecretString: pem }));
  }
  const publicKey = createPublicKey(pem).export({ type: 'spki', format: 'pem' }).toString();
  return { PhysicalResourceId: `signing-key-${arn.split(':').pop()}`, Data: { PublicKey: publicKey } };
}
