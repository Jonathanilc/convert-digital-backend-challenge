import { describe } from 'vitest';
import { runAppSuite } from '../app/app-suite.js';
import { connect, REDIS_URL } from './redis.js';

describe.skipIf(!REDIS_URL)('integration', () => {
  runAppSuite('real Redis', () => connect());
});
