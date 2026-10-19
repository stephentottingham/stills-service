/**
 * In-memory stand-ins for DynamoDB, S3, SQS, Secrets Manager and CloudFront,
 * just enough for the expressions this service uses. Lets the tests run the
 * real handlers end to end without AWS.
 */
import { generateKeyPairSync } from 'node:crypto';
import { Readable } from 'node:stream';
import { mockClient } from 'aws-sdk-client-mock';
import {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  QueryCommand,
  UpdateCommand,
  DeleteCommand,
  TransactWriteCommand,
  BatchGetCommand,
  BatchWriteCommand,
} from '@aws-sdk/lib-dynamodb';
import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  DeleteObjectCommand,
  DeleteObjectsCommand,
  ListObjectsV2Command,
  ListObjectVersionsCommand,
  CreateMultipartUploadCommand,
  UploadPartCommand,
  CompleteMultipartUploadCommand,
  AbortMultipartUploadCommand,
} from '@aws-sdk/client-s3';
import { SQSClient, SendMessageBatchCommand } from '@aws-sdk/client-sqs';
import { SecretsManagerClient, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';
import { CloudFrontClient, CreateInvalidationCommand } from '@aws-sdk/client-cloudfront';
import { SESv2Client, SendEmailCommand } from '@aws-sdk/client-sesv2';

type Item = Record<string, any>;

export function setEnv() {
  Object.assign(process.env, {
    AWS_REGION: 'eu-west-2',
    AWS_ACCESS_KEY_ID: 'test',
    AWS_SECRET_ACCESS_KEY: 'test',
    TABLE_NAME: 'table',
    ORIGINALS_BUCKET: 'originals',
    RENDITIONS_BUCKET: 'renditions',
    RAW_BUCKET: 'raw',
    PUBLIC_BASE: 'https://stills.example',
    DISTRIBUTION_ID: 'E123',
    SIGNING_KEY_PAIR_ID: 'K123',
    SIGNING_KEY_SECRET: 'signing',
    COOKIE_KEY_SECRET: 'cookie',
    WORK_QUEUE_URL: 'work',
    WEBHOOK_QUEUE_URL: 'hooks',
    MAIL_FROM: 'galleries@example.com',
  });
}

export function installFakes() {
  const rows = new Map<string, Item>();
  const objects = new Map<string, Buffer>();
  const versions: { bucket: string; key: string }[] = [];
  const messages: { queue: string; body: any }[] = [];
  const emails: any[] = [];
  const invalidations: string[] = [];
  const parts = new Map<string, Buffer[]>();
  const k = (pk: string, sk: string) => `${pk}\u0000${sk}`;

  const ddb = mockClient(DynamoDBDocumentClient);
  const resolve = (expr: string, values: Item = {}, names: Item = {}) => {
    const v = (t: string) => (t.startsWith(':') ? values[t] : undefined);
    const n = (t: string) => (t.startsWith('#') ? names[t] : t);
    return { v, n };
  };

  const check = (cond: string | undefined, item: Item | undefined, values: Item = {}, names: Item = {}) => {
    if (!cond) return true;
    const { v, n } = resolve(cond, values, names);
    return cond.split(/\s+AND\s+/).every((part) => {
      part = part.trim();
      let m;
      if ((m = /^attribute_not_exists\((\S+)\)$/.exec(part))) return !item || item[n(m[1])] === undefined;
      if ((m = /^attribute_exists\((\S+)\)$/.exec(part))) return !!item && item[n(m[1])] !== undefined;
      if ((m = /^NOT contains\((\S+), (\S+)\)$/.exec(part))) return !(item?.[n(m[1])] ?? []).includes(v(m[2]));
      if ((m = /^(\S+) = (\S+)$/.exec(part))) return !!item && JSON.stringify(item[n(m[1])]) === JSON.stringify(v(m[2]));
      if ((m = /^(\S+) <> (\S+)$/.exec(part))) return !item || JSON.stringify(item[n(m[1])]) !== JSON.stringify(v(m[2]));
      throw new Error(`fake: unknown condition ${part}`);
    });
  };

  const conditionFailed = () => Object.assign(new Error('The conditional request failed'), { name: 'ConditionalCheckFailedException' });

  const put = (input: any) => {
    const existing = rows.get(k(input.Item.pk, input.Item.sk));
    if (!check(input.ConditionExpression, existing, input.ExpressionAttributeValues)) throw conditionFailed();
    rows.set(k(input.Item.pk, input.Item.sk), structuredClone(stripUndefined(input.Item)));
  };

  const update = (input: any) => {
    const key = k(input.Key.pk, input.Key.sk);
    const existing = rows.get(key);
    const values = input.ExpressionAttributeValues ?? {};
    const names = input.ExpressionAttributeNames ?? {};
    if (!check(input.ConditionExpression, existing, values, names)) throw conditionFailed();
    const item = structuredClone(existing ?? { ...input.Key });
    const { v, n } = resolve('', values, names);
    const expr: string = input.UpdateExpression;
    const setPart = /SET (.*?)(?: REMOVE |$)/.exec(expr)?.[1];
    const removePart = /REMOVE (.*)$/.exec(expr)?.[1];
    if (setPart) {
      for (const assign of splitTop(setPart)) {
        const [lhs, rhs] = assign.split(/\s*=\s*/, 2);
        let m;
        if ((m = /^list_append\(if_not_exists\((\S+), (\S+)\), (\S+)\)$/.exec(rhs.trim()))) {
          item[n(lhs.trim())] = [...(item[n(m[1])] ?? v(m[2])), ...v(m[3])];
        } else item[n(lhs.trim())] = structuredClone(v(rhs.trim()));
      }
    }
    if (removePart) for (const r of removePart.split(',')) delete item[n(r.trim())];
    rows.set(key, item);
  };

  ddb.on(GetCommand).callsFake((input) => ({ Item: structuredClone(rows.get(k(input.Key.pk, input.Key.sk))) }));
  ddb.on(PutCommand).callsFake((input) => (put(input), {}));
  ddb.on(UpdateCommand).callsFake((input) => (update(input), {}));
  ddb.on(DeleteCommand).callsFake((input) => (rows.delete(k(input.Key.pk, input.Key.sk)), {}));
  ddb.on(QueryCommand).callsFake((input) => {
    const values = input.ExpressionAttributeValues;
    const m = /^(\w+) = (:\w+)(?: AND begins_with\((\w+), (:\w+)\))?$/.exec(input.KeyConditionExpression);
    if (!m) throw new Error(`fake: unknown key condition ${input.KeyConditionExpression}`);
    const [, pkName, pkVal, skName, skVal] = m;
    const skAttr = skName ?? (pkName === 'pk' ? 'sk' : pkName.replace('pk', 'sk'));
    let items = [...rows.values()].filter(
      (r) => r[pkName] === values[pkVal] && (!skName || String(r[skName] ?? '').startsWith(values[skVal])),
    );
    if (input.IndexName) items = items.filter((r) => r[skAttr] !== undefined);
    items.sort((a, b) => (a[skAttr] < b[skAttr] ? -1 : a[skAttr] > b[skAttr] ? 1 : 0));
    if (input.ScanIndexForward === false) items.reverse();
    return { Items: structuredClone(items) };
  });
  ddb.on(TransactWriteCommand).callsFake((input) => {
    // All or nothing: check every condition first.
    for (const t of input.TransactItems) {
      const op = t.Update ?? t.Put;
      const key = t.Update ? t.Update.Key : t.Put.Item;
      if (!check(op.ConditionExpression, rows.get(k(key.pk, key.sk)), op.ExpressionAttributeValues, op.ExpressionAttributeNames))
        throw Object.assign(new Error('Transaction cancelled'), { name: 'TransactionCanceledException' });
    }
    for (const t of input.TransactItems) {
      if (t.Update) update({ ...t.Update, ConditionExpression: undefined });
      if (t.Put) put({ ...t.Put, ConditionExpression: undefined });
    }
    return {};
  });
  ddb.on(BatchGetCommand).callsFake((input) => {
    const [table, req] = Object.entries<any>(input.RequestItems)[0];
    return { Responses: { [table]: req.Keys.map((key: any) => rows.get(k(key.pk, key.sk))).filter(Boolean).map((r: Item) => structuredClone(r)) } };
  });
  ddb.on(BatchWriteCommand).callsFake((input) => {
    for (const reqs of Object.values<any>(input.RequestItems))
      for (const r of reqs) {
        if (r.DeleteRequest) rows.delete(k(r.DeleteRequest.Key.pk, r.DeleteRequest.Key.sk));
        if (r.PutRequest) put({ Item: r.PutRequest.Item });
      }
    return {};
  });

  const s3 = mockClient(S3Client);
  const ok = (bucket: string, key: string) => `${bucket}/${key}`;
  const body = async (b: any): Promise<Buffer> => {
    if (Buffer.isBuffer(b)) return b;
    if (b instanceof Uint8Array) return Buffer.from(b);
    if (typeof b === 'string') return Buffer.from(b);
    const chunks: Buffer[] = [];
    for await (const c of b) chunks.push(Buffer.from(c));
    return Buffer.concat(chunks);
  };
  const notFound = () => Object.assign(new Error('NotFound'), { name: 'NotFound', $metadata: { httpStatusCode: 404 } });
  s3.on(PutObjectCommand).callsFake(async (input) => {
    objects.set(ok(input.Bucket, input.Key), await body(input.Body));
    versions.push({ bucket: input.Bucket, key: input.Key });
    return {};
  });
  s3.on(GetObjectCommand).callsFake((input) => {
    const b = objects.get(ok(input.Bucket, input.Key));
    if (!b) throw Object.assign(notFound(), { name: 'NoSuchKey' });
    const stream = Readable.from([b]) as any;
    stream.transformToByteArray = async () => new Uint8Array(b);
    return { Body: stream, ContentLength: b.length };
  });
  s3.on(HeadObjectCommand).callsFake((input) => {
    if (!objects.has(ok(input.Bucket, input.Key))) throw notFound();
    return {};
  });
  s3.on(DeleteObjectCommand).callsFake((input) => (objects.delete(ok(input.Bucket, input.Key)), {}));
  s3.on(DeleteObjectsCommand).callsFake((input) => {
    for (const o of input.Delete.Objects) objects.delete(ok(input.Bucket, o.Key));
    return {};
  });
  const list = (bucket: string, prefix: string) => [...objects.keys()].filter((key) => key.startsWith(`${bucket}/${prefix}`)).map((key) => key.slice(bucket.length + 1));
  s3.on(ListObjectsV2Command).callsFake((input) => ({ Contents: list(input.Bucket, input.Prefix).map((Key) => ({ Key })) }));
  s3.on(ListObjectVersionsCommand).callsFake((input) => ({ Versions: list(input.Bucket, input.Prefix).map((Key) => ({ Key, VersionId: 'v1' })) }));
  s3.on(CreateMultipartUploadCommand).callsFake((input) => {
    parts.set(ok(input.Bucket, input.Key), []);
    return { UploadId: 'u1' };
  });
  s3.on(UploadPartCommand).callsFake(async (input) => {
    parts.get(ok(input.Bucket, input.Key))![input.PartNumber - 1] = await body(input.Body);
    return { ETag: `"${input.PartNumber}"` };
  });
  s3.on(CompleteMultipartUploadCommand).callsFake((input) => {
    objects.set(ok(input.Bucket, input.Key), Buffer.concat(parts.get(ok(input.Bucket, input.Key))!));
    return {};
  });
  s3.on(AbortMultipartUploadCommand).resolves({});

  mockClient(SQSClient)
    .on(SendMessageBatchCommand)
    .callsFake((input) => {
      for (const e of input.Entries) messages.push({ queue: input.QueueUrl, body: JSON.parse(e.MessageBody) });
      return { Successful: input.Entries.map((e: any) => ({ Id: e.Id })) };
    });

  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const pem = privateKey.export({ type: 'pkcs1', format: 'pem' }).toString();
  mockClient(SecretsManagerClient)
    .on(GetSecretValueCommand)
    .callsFake((input) => ({ SecretString: input.SecretId === 'signing' ? pem : 'cookie-secret-for-tests' }));
  mockClient(CloudFrontClient)
    .on(CreateInvalidationCommand)
    .callsFake((input) => {
      invalidations.push(...input.InvalidationBatch.Paths.Items);
      return {};
    });
  mockClient(SESv2Client)
    .on(SendEmailCommand)
    .callsFake((input) => {
      emails.push(input);
      return {};
    });

  return { rows, objects, messages, emails, invalidations };
}

function splitTop(s: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let cur = '';
  for (const ch of s) {
    if (ch === '(') depth++;
    if (ch === ')') depth--;
    if (ch === ',' && depth === 0) {
      out.push(cur);
      cur = '';
    } else cur += ch;
  }
  if (cur.trim()) out.push(cur);
  return out;
}

function stripUndefined(o: Item): Item {
  return JSON.parse(JSON.stringify(o));
}
