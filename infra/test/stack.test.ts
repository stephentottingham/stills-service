import { describe, it, expect, beforeAll } from 'vitest';
import { mkdirSync, existsSync } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { App } from 'aws-cdk-lib';
import { Template, Match } from 'aws-cdk-lib/assertions';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

let t: Template;

beforeAll(async () => {
  // Built assets are not needed to check the template; empty folders will do.
  for (const dir of ['layers/sharp/nodejs', 'web/dist']) if (!existsSync(path.join(root, dir))) mkdirSync(path.join(root, dir), { recursive: true });
  const { StillsStack } = await import('../lib/stills-stack');
  // Skip Lambda bundling: this checks the stack's shape, not the code.
  const app = new App({ context: { 'aws:cdk:bundling-stacks': [] } });
  t = Template.fromStack(new StillsStack(app, 'Test', { env: { account: '111111111111', region: 'eu-west-2' } }));
}, 120_000);

describe('the stack', () => {
  it('keeps every bucket private and HTTPS-only', () => {
    const buckets = t.findResources('AWS::S3::Bucket');
    expect(Object.keys(buckets).length).toBe(4);
    for (const b of Object.values(buckets)) {
      expect(b.Properties.PublicAccessBlockConfiguration).toEqual({
        BlockPublicAcls: true,
        BlockPublicPolicy: true,
        IgnorePublicAcls: true,
        RestrictPublicBuckets: true,
      });
    }
  });

  it('versions originals and uses Intelligent-Tiering', () => {
    t.hasResourceProperties('AWS::S3::Bucket', {
      VersioningConfiguration: { Status: 'Enabled' },
      LifecycleConfiguration: { Rules: Match.arrayWith([Match.objectLike({ Transitions: [{ StorageClass: 'INTELLIGENT_TIERING', TransitionInDays: 0 }] })]) },
    });
  });

  it('clears the RAW inbox after 30 days and speed tests after a day', () => {
    t.hasResourceProperties('AWS::S3::Bucket', {
      LifecycleConfiguration: {
        Rules: Match.arrayWith([
          Match.objectLike({ Prefix: 'raw/', ExpirationInDays: 30 }),
          Match.objectLike({ Prefix: 'speedtest/', ExpirationInDays: 1 }),
        ]),
      },
    });
  });

  it('limits the Synology user to raw/ in the inbox', () => {
    const policies = Object.values(t.findResources('AWS::IAM::Policy')).filter((p: any) =>
      JSON.stringify(p.Properties.Users ?? []).includes('SynologyUser'),
    );
    expect(policies).toHaveLength(1);
    const statements = (policies[0] as any).Properties.PolicyDocument.Statement;
    const actions = statements.flatMap((s: any) => [].concat(s.Action));
    expect(actions.sort()).toEqual(['s3:DeleteObject', 's3:GetBucketLocation', 's3:GetObject', 's3:ListBucket']);
    const objectStatement = statements.find((s: any) => [].concat(s.Action).includes('s3:GetObject'));
    expect(JSON.stringify(objectStatement.Resource)).toContain('/raw/*');
    t.resourceCountIs('AWS::IAM::AccessKey', 0); // keys are made by hand, never in the template
  });

  it('serves renditions and zips only with signed URLs', () => {
    const dist = Object.values(t.findResources('AWS::CloudFront::Distribution'))[0] as any;
    const behaviours = dist.Properties.DistributionConfig.CacheBehaviors;
    for (const pattern of ['/r/*', '/z/*']) {
      const b = behaviours.find((x: any) => x.PathPattern === pattern);
      expect(b.TrustedKeyGroups?.length).toBe(1);
    }
  });
});
