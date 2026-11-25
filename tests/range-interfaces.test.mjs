import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { promisify } from 'node:util';
import { Client } from '@modelcontextprotocol/client';
import { createServer } from '../dist/mcp/server.js';
import {
  Datasets,
  RoutingService,
  journeyOutputSchema,
} from '../dist/index.js';

const executeFile = promisify(execFile);

const query = {
  origin: 'A',
  destination: 'B',
  departure: '2026-11-24T08:00:00+01:00',
  latestDeparture: '2026-11-24T08:30:00+01:00',
};

async function prepare(testContext) {
  const root = await mkdtemp(join(tmpdir(), 'minotor-range-interface-'));
  testContext.after(() => rm(root, { recursive: true, force: true }));
  const datasets = new Datasets(root);
  await datasets.import('tests/fixtures/tiny.zip', {
    serviceDates: ['2026-11-24'],
  });

  return {
    root,
    env: { ...process.env, MINOTOR_MCP_HOME: root },
    service: new RoutingService(datasets),
    expected: JSON.parse(
      JSON.stringify(await new RoutingService(datasets).planJourney(query)),
    ),
  };
}

test(
  'range CLI output and exports agree with the JavaScript API',
  { timeout: 15000 },
  async (testContext) => {
    const { root, env, expected } = await prepare(testContext);
    const args = [
      'route',
      'A',
      'B',
      '--depart',
      query.departure,
      '--latest-departure',
      query.latestDeparture,
    ];
    const cli = (...options) =>
      executeFile(
        process.execPath,
        ['dist/cli/index.js', ...args, ...options],
        { env, timeout: 5000 },
      );
    const json = await cli('--json');
    assert.deepEqual(JSON.parse(json.stdout), expected);
    const human = await cli('--no-color');
    assert.match(human.stdout, /Departure window: 08:00–08:30/);
    assert.match(human.stdout, /Journey 1/);
    assert.match(human.stdout, /Journey 2/);
    assert.doesNotMatch(human.stdout, /Requested|Note:|\u001b/);
    const file = join(root, 'range.json');
    const exported = await cli('--output', file, '--json');
    assert.deepEqual(JSON.parse(exported.stdout), { file });
    assert.deepEqual(JSON.parse(await readFile(file, 'utf8')), expected);

    for (const options of [
      ['--mode', 'single_departure'],
      ['--max-initial-waiting-time', '0'],
    ]) {
      await assert.rejects(cli(...options, '--json'), (error) => {
        assert.equal(error.code, 1);
        assert.ok(JSON.parse(error.stderr).message);

        return true;
      });
    }
  },
);

// Exercise the real MCP client/server protocol without a subprocess transport.
function linkedTransports() {
  let closed = false;
  const transports = [0, 1].map((index) => ({
    async start() {},
    async send(message) {
      const payload = JSON.parse(JSON.stringify(message));
      queueMicrotask(() => transports[1 - index].onmessage?.(payload));
    },
    async close() {
      if (!closed) {
        closed = true;

        for (const transport of transports) {
          transport.onclose?.();
        }
      }
    },
  }));

  return transports;
}

test(
  'MCP journey schema and range results agree with the JavaScript API',
  { timeout: 15000 },
  async (testContext) => {
    const { service, expected } = await prepare(testContext);
    const client = new Client({ name: 'range-journey-test', version: '1.0.0' });
    const server = createServer(service);
    const [clientTransport, serverTransport] = linkedTransports();

    try {
      await server.connect(serverTransport);
      await client.connect(clientTransport, { timeout: 5000 });
      const tool = (await client.listTools()).tools.find(
        (entry) => entry.name === 'plan_journey',
      );
      assert.deepEqual(tool.inputSchema.properties.mode.enum, [
        'single_departure',
        'departure_window',
      ]);
      assert.ok(tool.inputSchema.properties.latestDeparture);
      assert.ok(tool.outputSchema.properties.effectiveLatestDeparture);
      const result = await client.callTool({
        name: 'plan_journey',
        arguments: query,
      });
      assert.ok(!result.isError, JSON.stringify(result));
      journeyOutputSchema.parse(result.structuredContent);
      assert.deepEqual(result.structuredContent, expected);
      assert.deepEqual(JSON.parse(result.content[0].text), expected);

      const { destination, ...reachabilityQuery } = query;
      const reachable = await client.callTool({
        name: 'compute_reachability',
        arguments: { query: reachabilityQuery },
      });
      assert.ok(!reachable.isError, JSON.stringify(reachable));
      assert.equal(reachable.structuredContent.mode, 'departure_window');
      assert.equal(reachable.structuredContent.basis, 'shortestDuration');

      for (const argumentsValue of [
        { ...query, mode: 'departure_window', latestDeparture: undefined },
        { ...query, maxInitialWaitingTime: 0 },
        { ...query, latestDeparture: '2026-11-24T07:00:00+01:00' },
      ]) {
        const rejected = await client.callTool({
          name: 'plan_journey',
          arguments: argumentsValue,
        });
        assert.equal(rejected.isError, true);
      }
    } finally {
      await client.close();
      await server.close();
    }
  },
);
