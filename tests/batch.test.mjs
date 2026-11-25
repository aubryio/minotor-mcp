import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { Client } from '@modelcontextprotocol/client';
import { createServer } from '../dist/mcp/server.js';
import {
  Datasets,
  RoutingService,
  searchBatchOutputSchema,
  journeyBatchOutputSchema,
} from '../dist/index.js';

const journey = {
  origin: 'A',
  destination: 'B',
  departure: '2026-11-24T08:00:00+01:00',
};

test('batch service validates before execution and isolates ordered failures', async () => {
  const service = new RoutingService();
  const seen = [];

  service.searchStops = async ({ query, limit }) => {
    seen.push(query);
    assert.equal(limit, 10);

    if (query === 'fail') {
      throw new Error('failed');
    }

    return { datasetId: query, stops: [] };
  };

  await assert.rejects(
    service.searchStopsBatch({ queries: [{ query: 'first' }, { query: '' }] }),
  );
  assert.deepEqual(seen, []);
  const output = await service.searchStopsBatch({
    queries: ['first', 'fail', 'first'].map((query) => ({ query })),
  });
  searchBatchOutputSchema.parse(output);
  assert.deepEqual(seen, ['first', 'fail', 'first']);
  assert.deepEqual(
    output.results.map((item) => item.ok),
    [true, false, true],
  );
  assert.equal(output.results[1].error.code, 'QUERY_FAILED');
});

test('MCP batches preserve single results, schemas, defaults and ID-only routing', async (testContext) => {
  const root = await mkdtemp(join(tmpdir(), 'minotor-batch-'));
  testContext.after(() => rm(root, { recursive: true, force: true }));
  const datasets = new Datasets(root);
  await datasets.import('tests/fixtures/tiny.zip', {
    serviceDates: ['2026-11-24'],
  });
  const service = new RoutingService(datasets);
  const client = new Client({ name: 'batch-test', version: '1.0.0' });
  const server = createServer(service);
  const [clientTransport, serverTransport] = linkedTransports();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  testContext.after(async () => {
    await client.close();
    await server.close();
  });
  const tools = (await client.listTools()).tools;
  assert.equal(tools.length, 5);

  for (const name of ['search_stops', 'plan_journey']) {
    const tool = tools.find((entry) => entry.name === name);
    assert.equal(tool.inputSchema.type, 'object');
    assert.equal(tool.outputSchema.type, 'object');
    assert.equal(tool.inputSchema.properties.queries.minItems, 1);
    assert.equal(tool.inputSchema.properties.queries.maxItems, 20);
    const query = name === 'search_stops' ? { query: 'Alpha' } : journey;
    const single = await client.callTool({ name, arguments: query });
    assert.ok(!single.isError);

    for (const count of [1, 20]) {
      const batch = await client.callTool({
        name,
        arguments: { queries: Array(count).fill(query) },
      });
      assert.ok(!batch.isError, JSON.stringify(batch));
      assert.equal(batch.structuredContent.results.length, count);

      for (const item of batch.structuredContent.results) {
        assert.deepEqual(item, { ok: true, result: single.structuredContent });
      }
    }

    const invalid = [
      { queries: [] },
      { queries: Array(21).fill(query) },
      { ...query, queries: [query] },
      { queries: [{ queries: [query] }] },
      { queries: [query, { ...query, typo: true }] },
      { queries: [query], typo: true },
      {
        queries: [
          query,
          name === 'search_stops'
            ? { query: 'Alpha', limit: -1 }
            : {
                ...journey,
                latestDeparture: journey.departure,
                mode: 'single_departure',
              },
        ],
      },
    ];

    for (const args of invalid) {
      const result = await client.callTool({ name, arguments: args });
      assert.equal(result.isError, true, JSON.stringify(args));
    }
  }

  const queries = [
    journey,
    { ...journey, origin: 'Alpha' },
    { ...journey, destination: 'unknown' },
    { ...journey, departure: '2026-11-27T08:00:00+01:00' },
    { ...journey, latestDeparture: '2026-11-24T08:30:00+01:00' },
    { ...journey, maxDuration: 0 },
  ];
  const result = await client.callTool({
    name: 'plan_journey',
    arguments: { queries },
  });
  assert.ok(!result.isError, JSON.stringify(result));
  const output = journeyBatchOutputSchema.parse(result.structuredContent);
  assert.deepEqual(
    output.results.map((item) => item.ok),
    [true, false, false, false, true, true],
  );
  assert.equal(output.results[1].error.code, 'UNKNOWN_STOP');
  assert.equal(output.results[2].error.code, 'UNKNOWN_STOP');
  assert.equal(output.results[3].error.code, 'DAY_NOT_PREPARED');
  assert.deepEqual(output.results[5].result.itineraries, []);
  assert.deepEqual(
    JSON.parse(JSON.stringify(await service.planJourneys({ queries }))),
    output,
  );
  const failed = await client.callTool({
    name: 'plan_journey',
    arguments: { queries: queries.slice(1, 4) },
  });
  assert.ok(!failed.isError);
  assert.ok(failed.structuredContent.results.every((item) => !item.ok));
});

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
