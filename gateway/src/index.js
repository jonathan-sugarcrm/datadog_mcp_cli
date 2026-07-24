import { loadConfig } from './config.js';
import { runStdio } from './server-stdio.js';

const config = loadConfig();

await runStdio(config);
