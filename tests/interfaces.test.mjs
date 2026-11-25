import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { Datasets } from '../dist/index.js';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';

test('CLI missing commands show usage, explicit help succeeds, and JSON errors stay structured', () => {
  for (const group of [[], ['data'], ['stops']]) {
    const run = (...args) =>
      spawnSync(process.execPath, ['dist/cli/index.js', ...group, ...args], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    const missing = run();
    assert.ifError(missing.error);
    assert.equal(missing.status, 1);
    assert.equal(missing.stdout, '');
    assert.match(missing.stderr, /Usage: mn/);
    assert.doesNotMatch(missing.stderr, /\(outputHelp\)/);
    const json = run('--json');
    assert.equal(json.status, 1);
    assert.equal(json.stdout, '');
    assert.equal(JSON.parse(json.stderr).code, 'MISSING_COMMAND');
    const help = run('--help');
    assert.equal(help.status, 0);
    assert.match(help.stdout, /Usage: mn/);
    assert.equal(help.stderr, '');
  }
});

test('CLI and actual MCP stdio share results', async (testContext) => {
  const root = await mkdtemp(join(tmpdir(), 'minotor-interfaces-'));
  testContext.after(() => rm(root, { recursive: true, force: true }));
  const departure = '2026-11-24T08:00:00+01:00';
  const env = { ...process.env, MINOTOR_MCP_HOME: root };
  const cli = (...args) =>
    execFileSync(process.execPath, ['dist/cli/index.js', ...args], {
      env,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  assert.throws(() =>
    cli('data', 'import', resolve('tests/fixtures/tiny.zip')),
  );
  const importRun = spawnSync(
    process.execPath,
    [
      'dist/cli/index.js',
      'data',
      'import',
      resolve('tests/fixtures/tiny.zip'),
      '--service-date',
      '2026-11-24',
      '--service-date',
      '2026-11-24',
      '--json',
    ],
    { env, encoding: 'utf8' },
  );
  assert.ifError(importRun.error);
  assert.equal(importRun.status, 0, importRun.stderr);
  assert.match(
    importRun.stderr,
    /Parsing timetable for 2026-11-24 with Minotor\. This may take a few minutes\./,
  );
  assert.equal(importRun.stderr.match(/few minutes/g)?.length, 1);
  const imported = JSON.parse(importRun.stdout);
  assert.equal(imported.preparedDays.length, 1);
  const prepared = JSON.parse(
    cli('data', 'prepare', '--service-date', '2026-11-26', '--json'),
  );
  assert.equal(prepared.preparedDays.length, 2);
  assert.throws(
    () => cli('data', 'prepare', '--service-date', '2026-11-25', '--json'),
    (error) => {
      assert.equal(error.status, 1);
      assert.equal(error.stdout, '');
      const details = JSON.parse(error.stderr.trim().split('\n').at(-1));
      assert.equal(details.code, 'NO_SERVICE');

      return true;
    },
  );
  assert.equal(JSON.parse(cli('data', 'list', '--json')).active, imported.id);
  assert.match(cli('data', 'list'), /Ready: 24 Nov 2026, 26 Nov 2026/);
  const humanSearch = cli('stops', 'search', 'Hub');
  assert.match(humanSearch, /Station/);
  assert.match(humanSearch, /GTFS ID/);
  assert.doesNotMatch(humanSearch, /\u001b/);
  assert.match(cli('stops', 'search', '--', '--json'), /Stops matching/);
  assert.match(cli('data', 'use', imported.id), /Active dataset: tiny.zip/);
  assert.deepEqual(JSON.parse(cli('data', 'use', imported.id, '--json')), {
    active: imported.id,
  });
  const reused = cli('data', 'prepare', '--service-date', '2026-11-24');
  assert.match(reused, /24 Nov 2026 · already prepared/);
  assert.doesNotMatch(reused, /preparedAt|Coverage|[a-f0-9]{64}/);

  for (const args of [
    ['route', 'Alpha', 'B', '--depart', departure],
    ['route', 'A', 'B'],
    ['unknown'],
  ]) {
    const humanError = spawnSync(
      process.execPath,
      ['dist/cli/index.js', ...args],
      { env, encoding: 'utf8' },
    );
    assert.equal(humanError.status, 1);
    assert.equal(humanError.stdout, '');
    assert.doesNotMatch(humanError.stderr, /\u001b|"code":/);
    const jsonError = spawnSync(
      process.execPath,
      ['dist/cli/index.js', ...args, '--json'],
      { env, encoding: 'utf8' },
    );
    assert.equal(jsonError.status, 1);
    assert.ok(JSON.parse(jsonError.stderr).message);
  }

  const unknownStop = spawnSync(
    process.execPath,
    [
      'dist/cli/index.js',
      'route',
      'No such stop',
      'B',
      '--depart',
      departure,
      '--json',
    ],
    { env, encoding: 'utf8' },
  );
  assert.equal(unknownStop.status, 1);
  assert.equal(JSON.parse(unknownStop.stderr).code, 'UNKNOWN_STOP');
  const humanRoute = cli(
    'route',
    'A',
    'C',
    '--depart',
    departure,
    '--no-color',
  );
  assert.match(humanRoute, /Alpha -> Gamma/);
  assert.match(humanRoute, /1 h 5 min journey/);
  assert.match(humanRoute, /1 h 10 min total/);
  assert.match(humanRoute, /Train R/);
  assert.match(humanRoute, /Bus S/);
  assert.doesNotMatch(humanRoute, /\u001b/);
  const exportPath = join(root, 'route.json');
  const routeJSON = JSON.parse(
    cli('route', 'A', 'C', '--depart', departure, '--json'),
  );
  assert.match(
    cli('route', 'A', 'C', '--depart', departure, '--output', exportPath),
    /Saved/,
  );
  assert.deepEqual(JSON.parse(await readFile(exportPath, 'utf8')), routeJSON);
  assert.deepEqual(
    JSON.parse(
      cli(
        'route',
        'A',
        'C',
        '--depart',
        departure,
        '--output',
        exportPath,
        '--json',
      ),
    ),
    { file: exportPath },
  );
  assert.match(
    cli('reachability', 'A', '--depart', departure),
    /Earliest arrival, including initial waiting/,
  );
  assert.match(
    cli(
      'reachability',
      'A',
      '--depart',
      departure,
      '--mode',
      'departure_window',
      '--latest-departure',
      '2026-11-24T08:30:00+01:00',
    ),
    /Shortest duration in departure window/,
  );
  let expected;

  for (const TZ of ['UTC', 'America/Los_Angeles', 'Asia/Tokyo']) {
    const output = execFileSync(
      process.execPath,
      [
        'dist/cli/index.js',
        'reachability',
        'A',
        '--depart',
        departure,
        '--json',
      ],
      { env: { ...env, TZ }, encoding: 'utf8' },
    );
    const result = JSON.parse(output);
    assert.equal(result.stops[1].earliestArrival.durationMinutes, 50);
    expected = result;
  }

  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [resolve('dist/cli/index.js'), 'mcp'],
    env,
    stderr: 'pipe',
  });
  const client = new Client({ name: 'minotor-test', version: '1.0.0' });
  const protocolErrors = [];
  client.onerror = (error) => protocolErrors.push(error);
  await client.connect(transport);
  testContext.after(() => client.close());
  const instructions = client.getInstructions();
  assert.equal(typeof instructions, 'string');
  assert.match(instructions, /summaries and focused queries/);
  assert.match(instructions, /Previews are incomplete/);
  assert.match(
    instructions,
    /local file path does not provide remote filesystem access/,
  );
  const tools = (await client.listTools()).tools;
  assert.equal(tools.length, 5);

  for (const tool of tools) {
    assert.equal(tool.annotations.openWorldHint, false);
    assert.equal(
      tool.annotations.readOnlyHint,
      tool.name !== 'compute_reachability',
    );

    if (tool.name === 'compute_reachability') {
      assert.equal(tool.annotations.destructiveHint, false);
      assert.equal(tool.annotations.idempotentHint, false);
    }
  }

  const listing = await client.callTool({
    name: 'list_datasets',
    arguments: {},
  });
  assert.equal(listing.structuredContent.datasets[0].preparedDays.length, 2);
  const missing = await client.callTool({
    name: 'plan_journey',
    arguments: {
      origin: 'A',
      destination: 'B',
      departure: '2026-11-27T08:00:00+01:00',
    },
  });
  assert.equal(missing.isError, true);
  const error = JSON.parse(missing.content[0].text);
  assert.equal(error.code, 'DAY_NOT_PREPARED');
  assert.deepEqual(error.details.availableDates, ['2026-11-24', '2026-11-26']);
  assert.equal(
    error.details.command,
    `mn data prepare --dataset ${imported.id} --service-date 2026-11-27`,
  );
  const invalid = await client.callTool({
    name: 'search_stops',
    arguments: { query: 'Alpha', limit: -1 },
  });
  assert.equal(invalid.isError, true);

  for (const request of [
    { name: 'search_stops', arguments: { query: 'Alpha', limt: 1 } },
    {
      name: 'plan_journey',
      arguments: { origin: 'A', destination: 'B', departure, maxTransfer: 0 },
    },
    {
      name: 'compute_reachability',
      arguments: { query: { origin: 'A', departure, maxTransfer: 0 } },
    },
    {
      name: 'compute_reachability',
      arguments: { query: { origin: 'A', departure }, limt: 1 },
    },
  ]) {
    const rejected = await client.callTool(request);
    assert.equal(rejected.isError, true, JSON.stringify(rejected));
    assert.match(rejected.content[0].text, /Unrecognized key/);
  }

  const search = await client.callTool({
    name: 'search_stops',
    arguments: { query: 'Alpha' },
  });
  const summary = await client.callTool({
    name: 'compute_reachability',
    arguments: { query: { origin: 'A', departure } },
  });
  assert.ok(!summary.isError, JSON.stringify(summary));
  const summaryData = summary.structuredContent;
  assert.equal(summaryData.view, 'summary');
  assert.equal(summaryData.total, expected.stops.length);
  assert.equal(summaryData.statistics.durationMinutes.mean, 40);
  assert.equal(summaryData.stops, undefined);
  assert.deepEqual(
    JSON.parse(await readFile(summaryData.file, 'utf8')).result,
    expected,
  );
  const rejectedPage = await client.callTool({
    name: 'compute_reachability',
    arguments: { resultId: summaryData.resultId, limit: 2 },
  });
  assert.equal(rejectedPage.isError, true);
  const first = await client.callTool({
    name: 'compute_reachability',
    arguments: { resultId: summaryData.resultId, view: 'page', limit: 2 },
  });
  assert.ok(!first.isError);
  const firstPage = first.structuredContent;
  const next = await client.callTool({
    name: 'compute_reachability',
    arguments: {
      resultId: firstPage.resultId,
      view: 'page',
      offset: firstPage.nextOffset,
      limit: 2,
    },
  });
  assert.deepEqual(
    [...firstPage.stops, ...next.structuredContent.stops],
    expected.stops,
  );
  const route = await client.callTool({
    name: 'plan_journey',
    arguments: { origin: 'A', destination: 'C', departure },
  });
  assert.equal(route.structuredContent.itineraries[0].elapsedMinutes, 70);

  for (const result of [listing, search, summary, first, next, route]) {
    assert.deepEqual(
      JSON.parse(result.content[0].text),
      result.structuredContent,
    );
  }

  // A fresh server can query the snapshot even after its timetable is removed.
  await client.close();
  assert.deepEqual(
    protocolErrors,
    [],
    'stdout must contain only valid MCP messages',
  );
  const data = new Datasets(root);
  const dataset = await data.active();
  await rm(join(data.data, dataset.id, 'timetables'), { recursive: true });
  const restarted = new Client({ name: 'minotor-restarted', version: '1.0.0' });
  restarted.onerror = (protocolError) => protocolErrors.push(protocolError);
  await restarted.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: [resolve('dist/cli/index.js'), 'mcp'],
      env,
      stderr: 'pipe',
    }),
  );
  testContext.after(() => restarted.close());
  const again = await restarted.callTool({
    name: 'compute_reachability',
    arguments: { resultId: summaryData.resultId },
  });
  assert.deepEqual(again.structuredContent, summaryData);
  const focused = await restarted.callTool({
    name: 'query_reachability',
    arguments: {
      resultId: summaryData.resultId,
      filters: { minDuration: 50 },
      fields: ['name'],
      limit: 1,
    },
  });
  assert.ok(!focused.isError, JSON.stringify(focused));
  assert.equal(focused.structuredContent.matched, 2);
  assert.equal(focused.structuredContent.statistics.durationMinutes.mean, 60);
  assert.deepEqual(focused.structuredContent.rows, [{ id: 'B', name: 'Beta' }]);
  assert.equal(focused.structuredContent.nextOffset, 1);
  const aggregates = await restarted.callTool({
    name: 'query_reachability',
    arguments: { resultId: summaryData.resultId, limit: 0 },
  });
  assert.equal(aggregates.structuredContent.matched, 3);
  assert.deepEqual(aggregates.structuredContent.rows, []);

  for (const result of [again, focused, aggregates]) {
    assert.deepEqual(
      JSON.parse(result.content[0].text),
      result.structuredContent,
    );
  }

  const invalidQuery = await restarted.callTool({
    name: 'query_reachability',
    arguments: { resultId: summaryData.resultId, fields: ['unknown'] },
  });
  assert.equal(invalidQuery.isError, true);
  assert.deepEqual(protocolErrors, []);
});
