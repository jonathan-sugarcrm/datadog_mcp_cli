import { loadConfig } from './config.js';
import { runHttp } from './server-http.js';
import { runStdio } from './server-stdio.js';

const config = loadConfig();

if (config.transport === 'http') {
  await runHttp(config);
} else {
  await runStdio(config);
}
