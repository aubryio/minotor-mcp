import { test } from 'node:test';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';

test('published types support direct routing and result consumption', () => {
  execFileSync(
    process.execPath,
    [
      resolve('node_modules/typescript/bin/tsc'),
      '--project',
      'tests/tsconfig.json',
    ],
    { stdio: 'pipe' },
  );
});
