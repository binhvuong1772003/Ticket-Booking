const path = require('node:path');
const { spawnSync } = require('node:child_process');
const dotenv = require('dotenv');

dotenv.config({
  path: path.resolve('apps/auth-service/.env'),
});

const args = process.argv.slice(2);

if (args[0] === 'db' && args[1] === 'push' && process.env.DIRECT_URL) {
  process.env.DATABASE_URL = process.env.DIRECT_URL;
}

const result = spawnSync(
  process.execPath,
  [
    path.resolve('node_modules/prisma/build/index.js'),
    ...process.argv.slice(2),
  ],
  { stdio: 'inherit' },
);

process.exit(result.status ?? 1);
