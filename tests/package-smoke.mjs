import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { access, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';

const sourceManifest = JSON.parse(
  await readFile(new URL('../package.json', import.meta.url), 'utf8'),
);

const dir = await mkdtemp(join(tmpdir(), 'minotor-pack-'));

try {
  execFileSync(
    process.platform === 'win32' ? 'npm.cmd' : 'npm',
    [
      'install',
      '--ignore-scripts',
      '--prefix',
      dir,
      resolve(`${sourceManifest.name}-${sourceManifest.version}.tgz`),
    ],
    { stdio: 'inherit', shell: process.platform === 'win32' },
  );
  const base = join(dir, 'node_modules', 'minotor-mcp');
  const manifest = JSON.parse(
    await readFile(join(base, 'package.json'), 'utf8'),
  );
  assert.equal(manifest.name, 'minotor-mcp');
  await access(join(base, 'README.md'));
  await access(join(base, 'skills/minotor-mcp/SKILL.md'));
  await assert.rejects(access(join(base, 'docs')), { code: 'ENOENT' });
  assert.deepEqual(manifest.bin, {
    mn: 'dist/cli/index.js',
  });
  await assert.rejects(access(join(base, 'dist/mcp/index.js')), {
    code: 'ENOENT',
  });
  const binDir = join(dir, 'node_modules', '.bin');
  const windows = process.platform === 'win32';
  // Resolve Windows command shims from their directory to avoid shell path quoting.
  const executable = (name, args = []) =>
    windows
      ? {
          command: process.env.ComSpec ?? 'cmd.exe',
          args: ['/d', '/c', name, ...args],
        }
      : { command: join(binDir, name), args };

  for (const oldName of [
    'minotor-cli',
    'minotor-mcp',
    'minotor-agent',
    'minotor-agent-mcp',
  ]) {
    await assert.rejects(
      access(join(binDir, oldName + (windows ? '.cmd' : ''))),
      { code: 'ENOENT' },
    );
  }

  const cli = executable('mn', ['--help']);
  const help = execFileSync(cli.command, cli.args, {
    cwd: binDir,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  assert.match(help, /Usage: mn /);
  process.stdout.write(help);
  const version = executable('mn', ['--version']);
  assert.equal(
    execFileSync(version.command, version.args, {
      cwd: binDir,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim(),
    manifest.version,
  );
  const env = { ...process.env, MINOTOR_MCP_HOME: join(dir, 'state') };
  const listing = executable('mn', ['data', 'list', '--json']);
  assert.deepEqual(
    JSON.parse(
      execFileSync(listing.command, listing.args, {
        cwd: binDir,
        env,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      }),
    ),
    { datasets: [] },
  );
  execFileSync(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      `import assert from 'node:assert/strict';
       import { join } from 'node:path';
       import { RoutingService, Datasets } from 'minotor-mcp';
       assert.equal(typeof RoutingService, 'function');
       const datasets = new Datasets();
       assert.equal(datasets.data, join(process.env.MINOTOR_MCP_HOME, 'data'));
       assert.equal(datasets.cache, join(process.env.MINOTOR_MCP_HOME, 'cache'));`,
    ],
    { cwd: dir, env, stdio: ['ignore', 'inherit', 'inherit'] },
  );
  const client = new Client({ name: 'package-smoke', version: '1.0.0' });
  const transport = new StdioClientTransport({
    ...executable('mn', ['mcp']),
    cwd: binDir,
    stderr: 'pipe',
    env,
  });
  transport.stderr?.on('data', (chunk) => process.stderr.write(chunk));

  try {
    await client.connect(transport);
    assert.equal(client.getServerVersion().version, manifest.version);
    assert.equal(client.getServerVersion().name, 'minotor-mcp');
    const tools = (await client.listTools()).tools
      .map((tool) => tool.name)
      .sort();
    assert.deepEqual(tools, [
      'compute_reachability',
      'list_datasets',
      'plan_journey',
      'query_reachability',
      'search_stops',
    ]);
  } finally {
    await client.close();
  }

  console.log(
    'Installed tarball: mn CLI, core import, and mn mcp entrypoint passed.',
  );
} finally {
  await rm(dir, { recursive: true, force: true });
}
