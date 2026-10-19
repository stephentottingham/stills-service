import { App, Tags } from 'aws-cdk-lib';
import { StillsStack } from '../lib/stills-stack';
import { DeployAccessStack } from '../lib/deploy-access-stack';
import { settings } from '../config';

const app = new App();
const env = { account: settings.account, region: settings.region };

new StillsStack(app, 'StillsEngine', { env, description: 'Stills bank, client galleries and non-destructive adjustments' });
new DeployAccessStack(app, 'StillsEngineDeployAccess', { env, description: 'GitHub Actions deploy role for the Stills Engine' });

Tags.of(app).add('service', 'stills');
Tags.of(app).add('owner', 'big-small');
