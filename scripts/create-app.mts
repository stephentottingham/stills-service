/**
 * Creates (or replaces) an app's API key, and optionally its webhook.
 *
 *   npx tsx scripts/create-app.mts --app engine --webhook https://<engine>/api/stills-engine/hook
 *   npx tsx scripts/create-app.mts --app happened --companies happened
 *
 * Run with credentials for the Stills Engine's AWS account. The key and the
 * webhook signing secret go straight into Secrets Manager (stills-engine/apps/<app>
 * and stills-engine/webhook/<app>); this script never prints them. Copy the key
 * into the app's own secret from there (for the engine: proposal-engine/app,
 * field stillsServiceKey).
 */
import { randomBytes, createHash } from 'node:crypto';
import { parseArgs } from 'node:util';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, PutCommand, QueryCommand, DeleteCommand } from '@aws-sdk/lib-dynamodb';
import {
  SecretsManagerClient,
  CreateSecretCommand,
  PutSecretValueCommand,
  ResourceNotFoundException,
} from '@aws-sdk/client-secrets-manager';
import { CloudFormationClient, DescribeStacksCommand } from '@aws-sdk/client-cloudformation';

const { values } = parseArgs({
  options: {
    app: { type: 'string' },
    webhook: { type: 'string' },
    companies: { type: 'string' },
    events: { type: 'string' },
    stack: { type: 'string', default: 'StillsEngine' },
  },
});
if (!values.app || !/^[a-z][a-z0-9-]{1,30}$/.test(values.app)) {
  console.error('Usage: --app <name> [--webhook <url>] [--companies bigsmall,atspeed] [--events still.ready,zip.ready]');
  process.exit(1);
}
const app = values.app;
const region = 'eu-west-2';

const cfn = new CloudFormationClient({ region });
const stack = (await cfn.send(new DescribeStacksCommand({ StackName: values.stack }))).Stacks?.[0];
const table = stack?.Outputs?.find((o) => o.OutputKey === 'TableName')?.OutputValue;
if (!table) throw new Error(`Could not find the table in stack ${values.stack}`);

const sm = new SecretsManagerClient({ region });
async function putSecret(name: string, value: string, description: string) {
  try {
    await sm.send(new PutSecretValueCommand({ SecretId: name, SecretString: value }));
  } catch (e) {
    if (!(e instanceof ResourceNotFoundException)) throw e;
    await sm.send(new CreateSecretCommand({ Name: name, SecretString: value, Description: description }));
  }
}

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({ region }), { marshallOptions: { removeUndefinedValues: true } });

// Replace any earlier key for this app.
const old = await ddb.send(
  new QueryCommand({
    TableName: table,
    IndexName: 'gsi1',
    KeyConditionExpression: 'gsi1pk = :p AND gsi1sk = :a',
    ExpressionAttributeValues: { ':p': 'APP', ':a': app },
  }),
);
for (const item of old.Items ?? []) await ddb.send(new DeleteCommand({ TableName: table, Key: { pk: item.pk, sk: item.sk } }));

const key = `ssk_${app}_${randomBytes(30).toString('base64url')}`;
const hash = createHash('sha256').update(key).digest('hex');
let webhookSecret: string | undefined;
if (values.webhook) {
  webhookSecret = `stills-engine/webhook/${app}`;
  await putSecret(webhookSecret, randomBytes(32).toString('hex'), `Webhook signing secret for ${app}`);
}
await ddb.send(
  new PutCommand({
    TableName: table,
    Item: {
      pk: `APPKEY#${hash}`,
      sk: 'META',
      type: 'app',
      app,
      companies: values.companies ? values.companies.split(',') : undefined,
      webhookUrl: values.webhook,
      webhookSecret,
      events: values.events ? values.events.split(',') : undefined,
      createdAt: new Date().toISOString(),
      gsi1pk: 'APP',
      gsi1sk: app,
    },
  }),
);
await putSecret(`stills-engine/apps/${app}`, key, `API key for ${app} (Stills Engine)`);

console.log(`App "${app}" is set up.`);
console.log(`  API key:        Secrets Manager stills-engine/apps/${app}`);
if (webhookSecret) console.log(`  Webhook secret: Secrets Manager ${webhookSecret}`);
console.log('Any earlier key for this app no longer works (allow up to 5 minutes for cached sign-ins to expire).');
