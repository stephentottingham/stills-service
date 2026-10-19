import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Stack, StackProps, Duration, RemovalPolicy, CfnOutput, CustomResource } from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as s3n from 'aws-cdk-lib/aws-s3-notifications';
import * as s3deploy from 'aws-cdk-lib/aws-s3-deployment';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as nodejs from 'aws-cdk-lib/aws-lambda-nodejs';
import * as eventsources from 'aws-cdk-lib/aws-lambda-event-sources';
import * as secrets from 'aws-cdk-lib/aws-secretsmanager';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as cf from 'aws-cdk-lib/aws-cloudfront';
import * as origins from 'aws-cdk-lib/aws-cloudfront-origins';
import * as acm from 'aws-cdk-lib/aws-certificatemanager';
import * as apigw from 'aws-cdk-lib/aws-apigatewayv2';
import * as authorizers from 'aws-cdk-lib/aws-apigatewayv2-authorizers';
import * as integrations from 'aws-cdk-lib/aws-apigatewayv2-integrations';
import * as events from 'aws-cdk-lib/aws-events';
import * as targets from 'aws-cdk-lib/aws-events-targets';
import * as cr from 'aws-cdk-lib/custom-resources';
import * as cw from 'aws-cdk-lib/aws-cloudwatch';
import * as cwActions from 'aws-cdk-lib/aws-cloudwatch-actions';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as subs from 'aws-cdk-lib/aws-sns-subscriptions';
import * as logs from 'aws-cdk-lib/aws-logs';
import { settings } from '../config';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const handlers = path.join(root, 'services/src/handlers');

export class StillsStack extends Stack {
  constructor(scope: Construct, id: string, props: StackProps) {
    super(scope, id, props);

    // ---------- Data ----------
    const table = new dynamodb.TableV2(this, 'Table', {
      partitionKey: { name: 'pk', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'sk', type: dynamodb.AttributeType.STRING },
      billing: dynamodb.Billing.onDemand(),
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
      timeToLiveAttribute: 'ttl',
      deletionProtection: true,
      removalPolicy: RemovalPolicy.RETAIN,
      globalSecondaryIndexes: ['gsi1', 'gsi2', 'gsi3'].map((name) => ({
        indexName: name,
        partitionKey: { name: `${name}pk`, type: dynamodb.AttributeType.STRING },
        sortKey: { name: `${name}sk`, type: dynamodb.AttributeType.STRING },
      })),
    });

    // ---------- Files ----------
    // Originals: private, versioned, never served directly.
    const originals = new s3.Bucket(this, 'Originals', {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      versioned: true,
      removalPolicy: RemovalPolicy.RETAIN,
      lifecycleRules: [
        { noncurrentVersionExpiration: Duration.days(30) },
        { abortIncompleteMultipartUploadAfter: Duration.days(2) },
      ],
    });

    // Renditions (made from originals + recipes) and zips.
    const renditions = new s3.Bucket(this, 'Renditions', {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      removalPolicy: RemovalPolicy.RETAIN,
      lifecycleRules: [
        { prefix: 'z/', expiration: Duration.days(7) },
        { abortIncompleteMultipartUploadAfter: Duration.days(1) },
      ],
    });

    // The library screens and brand assets.
    const web = new s3.Bucket(this, 'Web', {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      removalPolicy: RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
    });

    // ---------- Queues ----------
    const queue = (name: string, visibility: Duration, maxReceiveCount: number) => {
      const dlq = new sqs.Queue(this, `${name}Dead`, { retentionPeriod: Duration.days(14), enforceSSL: true });
      const q = new sqs.Queue(this, name, {
        visibilityTimeout: visibility,
        enforceSSL: true,
        deadLetterQueue: { queue: dlq, maxReceiveCount },
      });
      return { q, dlq };
    };
    const uploads = queue('Uploads', Duration.minutes(30), 4);
    const work = queue('Work', Duration.minutes(90), 3);
    const hooks = queue('Webhooks', Duration.minutes(2), 8);

    // ---------- Secrets ----------
    // CloudFront signing key: made by the keygen resource below, straight into Secrets Manager.
    const signingKey = new secrets.Secret(this, 'SigningKey', {
      description: 'Private key for CloudFront signed URLs (stills service). Made at deploy; never in code.',
    });
    // HMAC key for gallery unlock cookies.
    const cookieKey = new secrets.Secret(this, 'CookieKey', {
      description: 'HMAC key for gallery password cookies (stills service).',
      generateSecretString: { passwordLength: 64, excludePunctuation: true },
    });

    // ---------- Functions ----------
    const sharpLayer = new lambda.LayerVersion(this, 'SharpLayer', {
      code: lambda.Code.fromAsset(path.join(root, 'layers/sharp')),
      compatibleArchitectures: [lambda.Architecture.ARM_64],
      compatibleRuntimes: [lambda.Runtime.NODEJS_22_X],
      description: 'sharp (libvips) and heic-decode for linux-arm64',
    });

    const fn = (name: string, file: string, opts: Partial<nodejs.NodejsFunctionProps> & { images?: boolean } = {}) => {
      const { images, ...rest } = opts;
      const f = new nodejs.NodejsFunction(this, name, {
        entry: path.join(handlers, file),
        runtime: lambda.Runtime.NODEJS_22_X,
        architecture: lambda.Architecture.ARM_64,
        memorySize: 512,
        timeout: Duration.seconds(30),
        logGroup: new logs.LogGroup(this, `${name}Logs`, { retention: logs.RetentionDays.THREE_MONTHS, removalPolicy: RemovalPolicy.DESTROY }),
        layers: images ? [sharpLayer] : [],
        bundling: {
          // CommonJS, so require() finds the layer's modules in /opt/nodejs/node_modules.
          format: nodejs.OutputFormat.CJS,
          target: 'node22',
          minify: true,
          sourceMap: true,
          // From the layer. Everything else (AWS SDK included) is bundled, so versions are pinned.
          externalModules: ['sharp', 'heic-decode'],
        },
        environment: {
          NODE_OPTIONS: '--enable-source-maps',
          TABLE_NAME: table.tableName,
          ORIGINALS_BUCKET: originals.bucketName,
          RENDITIONS_BUCKET: renditions.bucketName,
          ...rest.environment,
        },
        ...rest,
      });
      return f;
    };

    const authorizerFn = fn('Authorizer', 'authorizer.ts', {
      memorySize: 256,
      timeout: Duration.seconds(5),
      environment: { USER_POOL_ID: settings.cognito.userPoolId, USER_POOL_CLIENT_IDS: settings.cognito.clientIds.join(',') },
    });
    table.grantReadData(authorizerFn);

    const renderer = fn('Renderer', 'renderer.ts', { images: true, memorySize: 4096, timeout: Duration.minutes(2) });
    table.grantReadData(renderer);
    originals.grantRead(renderer);
    renditions.grantPut(renderer);
    const rendererUrl = renderer.addFunctionUrl({
      authType: lambda.FunctionUrlAuthType.AWS_IAM,
      invokeMode: lambda.InvokeMode.RESPONSE_STREAM,
    });

    // ---------- CloudFront ----------
    const keygen = fn('Keygen', 'keygen.ts', { memorySize: 256, timeout: Duration.seconds(30) });
    signingKey.grantRead(keygen);
    signingKey.grantWrite(keygen);
    const keygenProvider = new cr.Provider(this, 'KeygenProvider', { onEventHandler: keygen });
    const keyResource = new CustomResource(this, 'SigningKeyPair', {
      serviceToken: keygenProvider.serviceToken,
      properties: { SecretArn: signingKey.secretArn },
    });
    const publicKey = new cf.PublicKey(this, 'SigningPublicKey', {
      encodedKey: keyResource.getAttString('PublicKey'),
      comment: 'Stills service signed URLs',
    });
    const keyGroup = new cf.KeyGroup(this, 'SigningKeyGroup', { items: [publicKey] });

    const httpApi = new apigw.HttpApi(this, 'Api', {
      description: 'Stills service API (/api) and client galleries (/g)',
      createDefaultStage: true,
    });
    const apiDomain = `${httpApi.apiId}.execute-api.${this.region}.amazonaws.com`;
    const apiOrigin = new origins.HttpOrigin(apiDomain, { protocolPolicy: cf.OriginProtocolPolicy.HTTPS_ONLY });

    const rendOrigin = new origins.OriginGroup({
      primaryOrigin: origins.S3BucketOrigin.withOriginAccessControl(renditions),
      fallbackOrigin: origins.FunctionUrlOrigin.withOriginAccessControl(rendererUrl, { readTimeout: Duration.seconds(60) }),
      fallbackStatusCodes: [403, 404],
    });

    const passThrough: cf.AddBehaviorOptions = {
      viewerProtocolPolicy: cf.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
      allowedMethods: cf.AllowedMethods.ALLOW_ALL,
      cachePolicy: cf.CachePolicy.CACHING_DISABLED,
      originRequestPolicy: cf.OriginRequestPolicy.ALL_VIEWER_EXCEPT_HOST_HEADER,
    };

    const certificate = settings.certificateArn
      ? acm.Certificate.fromCertificateArn(this, 'Certificate', settings.certificateArn)
      : undefined;

    const distribution = new cf.Distribution(this, 'Distribution', {
      comment: 'Stills service',
      priceClass: cf.PriceClass.PRICE_CLASS_100,
      httpVersion: cf.HttpVersion.HTTP2_AND_3,
      domainNames: settings.domainNames.length ? settings.domainNames : undefined,
      certificate,
      defaultRootObject: 'index.html',
      defaultBehavior: {
        origin: origins.S3BucketOrigin.withOriginAccessControl(web),
        viewerProtocolPolicy: cf.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        cachePolicy: cf.CachePolicy.CACHING_OPTIMIZED,
        responseHeadersPolicy: cf.ResponseHeadersPolicy.SECURITY_HEADERS,
      },
      additionalBehaviors: {
        // Renditions: S3 first, the renderer when missing. Signed URLs only.
        '/r/*': {
          origin: rendOrigin,
          viewerProtocolPolicy: cf.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
          cachePolicy: cf.CachePolicy.CACHING_OPTIMIZED,
          trustedKeyGroups: [keyGroup],
        },
        '/z/*': {
          origin: origins.S3BucketOrigin.withOriginAccessControl(renditions),
          viewerProtocolPolicy: cf.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
          cachePolicy: cf.CachePolicy.CACHING_OPTIMIZED,
          trustedKeyGroups: [keyGroup],
        },
        '/api/*': { origin: apiOrigin, ...passThrough },
        '/g/*': { origin: apiOrigin, ...passThrough },
      },
    });

    const publicBase = settings.domainNames.length
      ? `https://${settings.domainNames[0]}`
      : `https://${distribution.distributionDomainName}`;

    const signingEnv = {
      PUBLIC_BASE: publicBase,
      DISTRIBUTION_ID: distribution.distributionId,
      SIGNING_KEY_PAIR_ID: publicKey.publicKeyId,
      SIGNING_KEY_SECRET: signingKey.secretArn,
      COOKIE_KEY_SECRET: cookieKey.secretArn,
      WORK_QUEUE_URL: work.q.queueUrl,
      WEBHOOK_QUEUE_URL: hooks.q.queueUrl,
      MAIL_FROM: settings.mailFrom,
    };

    // The API, for people (library screens) and apps (engine, Happened).
    const api = fn('ApiFn', 'api.ts', { images: true, memorySize: 2048, timeout: Duration.seconds(29), environment: signingEnv });
    // Public client galleries.
    const gallery = fn('GalleryFn', 'gallery.ts', { memorySize: 512, timeout: Duration.seconds(15), environment: signingEnv });
    // Upload processing.
    const processor = fn('Processor', 'processor.ts', { images: true, memorySize: 3008, timeout: Duration.minutes(5), environment: signingEnv });
    // Zips and background renders.
    const worker = fn('Worker', 'worker.ts', { images: true, memorySize: 4096, timeout: Duration.minutes(15), environment: signingEnv });
    // Webhook delivery.
    const webhooks = fn('WebhooksFn', 'webhooks.ts', { memorySize: 256, timeout: Duration.seconds(30) });
    // Daily retention sweep.
    const retention = fn('Retention', 'retention.ts', { images: false, memorySize: 1024, timeout: Duration.minutes(15), environment: signingEnv });

    for (const f of [api, gallery, processor, worker, retention]) {
      table.grantReadWriteData(f);
      signingKey.grantRead(f);
      work.q.grantSendMessages(f);
      hooks.q.grantSendMessages(f);
    }
    cookieKey.grantRead(gallery);
    originals.grantReadWrite(api);
    originals.grantPut(api);
    renditions.grantReadWrite(processor);
    renditions.grantReadWrite(worker);
    renditions.grantRead(api);
    renditions.grantRead(gallery);
    originals.grantReadWrite(processor);
    originals.grantRead(worker);
    for (const f of [api, retention]) {
      originals.grantReadWrite(f);
      originals.grantDelete(f);
      renditions.grantReadWrite(f);
      renditions.grantDelete(f);
      f.addToRolePolicy(new iam.PolicyStatement({ actions: ['s3:ListBucketVersions', 's3:DeleteObjectVersion'], resources: [originals.bucketArn, originals.arnForObjects('*')] }));
      f.addToRolePolicy(
        new iam.PolicyStatement({
          actions: ['cloudfront:CreateInvalidation'],
          resources: [`arn:aws:cloudfront::${this.account}:distribution/${distribution.distributionId}`],
        }),
      );
    }
    originals.grantDelete(processor);
    worker.addToRolePolicy(new iam.PolicyStatement({ actions: ['ses:SendEmail'], resources: ['*'] }));
    // Webhook signing secrets, one per app, made by scripts/create-app.ts.
    webhooks.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['secretsmanager:GetSecretValue'],
        resources: [`arn:aws:secretsmanager:${this.region}:${this.account}:secret:stills-service/webhook/*`],
      }),
    );

    // Uploads arrive straight in S3 from the browser or uploader. The presigned
    // URL is what protects them; the origin list cannot name the CloudFront
    // domain (that would be a circular reference), so it is open until our own
    // domains are set.
    originals.addCorsRule({
      allowedMethods: [s3.HttpMethods.PUT],
      allowedOrigins: settings.domainNames.length ? [...settings.domainNames.map((d) => `https://${d}`), ...settings.devOrigins] : ['*'],
      allowedHeaders: ['content-type', 'content-length'],
      maxAge: 3600,
    });
    originals.addEventNotification(s3.EventType.OBJECT_CREATED, new s3n.SqsDestination(uploads.q), { prefix: 'o/' });

    processor.addEventSource(new eventsources.SqsEventSource(uploads.q, { batchSize: 1, reportBatchItemFailures: true, maxConcurrency: 50 }));
    worker.addEventSource(new eventsources.SqsEventSource(work.q, { batchSize: 1, reportBatchItemFailures: true, maxConcurrency: 20 }));
    webhooks.addEventSource(new eventsources.SqsEventSource(hooks.q, { batchSize: 10, reportBatchItemFailures: true }));

    new events.Rule(this, 'RetentionDaily', {
      schedule: events.Schedule.cron({ minute: '15', hour: '3' }),
      targets: [new targets.LambdaFunction(retention)],
    });

    // ---------- Routes ----------
    const authorizer = new authorizers.HttpLambdaAuthorizer('Auth', authorizerFn, {
      responseTypes: [authorizers.HttpLambdaResponseType.SIMPLE],
      identitySource: ['$request.header.Authorization'],
      resultsCacheTtl: Duration.minutes(5),
    });
    httpApi.addRoutes({
      path: '/api/{proxy+}',
      methods: [apigw.HttpMethod.GET, apigw.HttpMethod.POST, apigw.HttpMethod.PUT, apigw.HttpMethod.PATCH, apigw.HttpMethod.DELETE],
      integration: new integrations.HttpLambdaIntegration('ApiIntegration', api),
      authorizer,
    });
    httpApi.addRoutes({
      path: '/g/{proxy+}',
      methods: [apigw.HttpMethod.GET, apigw.HttpMethod.POST],
      integration: new integrations.HttpLambdaIntegration('GalleryIntegration', gallery),
    });
    const stage = httpApi.defaultStage!.node.defaultChild as apigw.CfnStage;
    stage.defaultRouteSettings = { throttlingRateLimit: 50, throttlingBurstLimit: 100 };

    // ---------- Library screens ----------
    new s3deploy.BucketDeployment(this, 'WebDeploy', {
      destinationBucket: web,
      distribution,
      distributionPaths: ['/index.html', '/config.json', '/app.js', '/app.css'],
      sources: [
        s3deploy.Source.asset(path.join(root, 'web/dist')),
        s3deploy.Source.jsonData('config.json', {
          apiBase: '/api',
          cognitoDomain: settings.cognito.hostedUiDomain,
          clientId: settings.cognito.webClientId,
        }),
      ],
    });

    // ---------- Alarms ----------
    if (settings.alarmEmail) {
      const topic = new sns.Topic(this, 'Alarms');
      topic.addSubscription(new subs.EmailSubscription(settings.alarmEmail));
      for (const [name, dlq] of [['Uploads', uploads.dlq], ['Work', work.dlq], ['Webhooks', hooks.dlq]] as const) {
        new cw.Alarm(this, `${name}DeadLetters`, {
          alarmDescription: `${name}: messages failed and went to the dead-letter queue`,
          metric: dlq.metricApproximateNumberOfMessagesVisible({ period: Duration.minutes(5) }),
          threshold: 1,
          evaluationPeriods: 1,
          treatMissingData: cw.TreatMissingData.NOT_BREACHING,
        }).addAlarmAction(new cwActions.SnsAction(topic));
      }
    }

    // ---------- Outputs ----------
    new CfnOutput(this, 'PublicBase', { value: publicBase, description: 'Base for galleries (/g), the API (/api) and renditions (/r)' });
    new CfnOutput(this, 'ApiBase', { value: `${publicBase}/api` });
    new CfnOutput(this, 'DistributionDomain', { value: distribution.distributionDomainName });
    new CfnOutput(this, 'TableName', { value: table.tableName });
    new CfnOutput(this, 'OriginalsBucket', { value: originals.bucketName });
    new CfnOutput(this, 'RenditionsBucket', { value: renditions.bucketName });
    new CfnOutput(this, 'SigningKeyPairId', { value: publicKey.publicKeyId });
  }
}
