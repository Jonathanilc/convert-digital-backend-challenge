import RedisMock from 'ioredis-mock';
import { runAppSuite } from './app-suite.js';

runAppSuite('ioredis-mock', () => new RedisMock());
