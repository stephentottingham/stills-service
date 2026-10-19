import { App, Tags } from 'aws-cdk-lib';
import { StillsStack } from '../lib/stills-stack';
import { DeployAccessStack } from '../lib/deploy-access-stack';
import { settings } from '../config';

const app = new App();
const env = { account: settings.account, region: settings.region };

new StillsStack(app, 'StillsService', { env, description: 'Stills bank, client galleries and non-destructive adjustments' });
new DeployAccessStack(app, 'StillsServiceDeployAccess', { env, description: 'GitHub Actions deploy role for the stills service' });

Tags.of(app).add('service', 'stills');
Tags.of(app).add('owner', 'big-small');
