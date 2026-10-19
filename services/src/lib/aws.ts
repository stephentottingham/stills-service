import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  QueryCommand,
  QueryCommandInput,
  DeleteCommand,
  BatchWriteCommand,
  BatchGetCommand,
} from '@aws-sdk/lib-dynamodb';
import { S3Client, GetObjectCommand } from '@aws-sdk/client-s3';
import { SQSClient, SendMessageBatchCommand } from '@aws-sdk/client-sqs';
import { SecretsManagerClient, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';
import { config } from './config';

export const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}), {
  marshallOptions: { removeUndefinedValues: true },
});
export const s3 = new S3Client({});
export const sqs = new SQSClient({});
const secrets = new SecretsManagerClient({});

export async function getItem<T>(pk: string, sk = 'META'): Promise<T | undefined> {
  const r = await ddb.send(new GetCommand({ TableName: config.table, Key: { pk, sk } }));
  return r.Item as T | undefined;
}

export async function putItem(
  item: Record<string, unknown>,
  condition?: string,
  values?: Record<string, unknown>,
): Promise<void> {
  await ddb.send(
    new PutCommand({ TableName: config.table, Item: item, ConditionExpression: condition, ExpressionAttributeValues: values }),
  );
}

export async function deleteItem(pk: string, sk = 'META'): Promise<void> {
  await ddb.send(new DeleteCommand({ TableName: config.table, Key: { pk, sk } }));
}

/** Runs a query to the end (all pages) unless `limit` is reached. */
export async function queryAll<T>(input: Omit<QueryCommandInput, 'TableName'>, limit = Infinity): Promise<T[]> {
  const out: T[] = [];
  let ExclusiveStartKey: Record<string, unknown> | undefined;
  do {
    const r = await ddb.send(new QueryCommand({ TableName: config.table, ...input, ExclusiveStartKey }));
    out.push(...((r.Items ?? []) as T[]));
    ExclusiveStartKey = r.LastEvaluatedKey;
  } while (ExclusiveStartKey && out.length < limit);
  return out.slice(0, limit);
}

export async function batchGet<T>(keys: { pk: string; sk: string }[]): Promise<T[]> {
  const out: T[] = [];
  for (let i = 0; i < keys.length; i += 100) {
    let pending: Record<string, any> | undefined = { [config.table]: { Keys: keys.slice(i, i + 100) } };
    for (let attempt = 0; pending && Object.keys(pending).length && attempt < 6; attempt++) {
      const r: { Responses?: Record<string, any[]>; UnprocessedKeys?: Record<string, any> } = await ddb.send(
        new BatchGetCommand({ RequestItems: pending }),
      );
      out.push(...((r.Responses?.[config.table] ?? []) as T[]));
      pending = r.UnprocessedKeys;
      if (pending && Object.keys(pending).length) await sleep(50 * 2 ** attempt);
    }
  }
  return out;
}

export async function batchDelete(keys: { pk: string; sk: string }[]): Promise<void> {
  for (let i = 0; i < keys.length; i += 25) {
    let pending: Record<string, any> | undefined = {
      [config.table]: keys.slice(i, i + 25).map((Key) => ({ DeleteRequest: { Key } })),
    };
    for (let attempt = 0; pending && Object.keys(pending).length && attempt < 6; attempt++) {
      const r: { UnprocessedItems?: Record<string, any> } = await ddb.send(new BatchWriteCommand({ RequestItems: pending }));
      pending = r.UnprocessedItems;
      if (pending && Object.keys(pending).length) await sleep(50 * 2 ** attempt);
    }
  }
}

export async function getObjectBuffer(bucket: string, key: string): Promise<Buffer> {
  const r = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
  return Buffer.from(await r.Body!.transformToByteArray());
}

export async function sendMessages(queueUrl: string, bodies: unknown[]): Promise<void> {
  for (let i = 0; i < bodies.length; i += 10) {
    await sqs.send(
      new SendMessageBatchCommand({
        QueueUrl: queueUrl,
        Entries: bodies.slice(i, i + 10).map((b, j) => ({ Id: String(j), MessageBody: JSON.stringify(b) })),
      }),
    );
  }
}

const secretCache = new Map<string, { value: string; at: number }>();

/** Reads a secret, cached for five minutes per container. */
export async function getSecret(name: string): Promise<string> {
  const hit = secretCache.get(name);
  if (hit && Date.now() - hit.at < 300_000) return hit.value;
  const r = await secrets.send(new GetSecretValueCommand({ SecretId: name }));
  const value = r.SecretString ?? '';
  secretCache.set(name, { value, at: Date.now() });
  return value;
}

export function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

/** Strips the table's key attributes from an item before it leaves the service. */
export function clean<T>(item: Record<string, any>): T {
  const { pk, sk, gsi1pk, gsi1sk, gsi2pk, gsi2sk, gsi3pk, gsi3sk, type, ttl, ...rest } = item;
  return rest as T;
}
