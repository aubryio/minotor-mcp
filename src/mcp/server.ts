import { McpServer } from '@modelcontextprotocol/server';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { z as zod } from 'zod';

import {
  computeReachabilityOutputSchema,
  datasetsOutputSchema,
  journeyToolOutputSchema,
  queryReachabilityOutputSchema,
  searchToolOutputSchema,
} from '../core/outputs.js';
import { Results } from '../core/results.js';
import { RoutingService } from '../core/router.js';
import {
  computeReachabilitySchema,
  journeyBatchSchema,
  journeySchema,
  journeyToolSchema,
  queryReachabilitySchema,
  searchBatchSchema,
  searchSchema,
  searchToolSchema,
  TransitError,
} from '../core/schemas.js';
import { version } from '../metadata.js';

const readOnly = { readOnlyHint: true, openWorldHint: false };

/** Convert service results and errors to the MCP structured response format. */
function toolHandler<Input>(
  execute: (input: Input) => Promise<Record<string, unknown>>,
) {
  return async (input: Input) => {
    try {
      const data = await execute(input);

      return {
        content: [{ type: 'text' as const, text: JSON.stringify(data) }],
        structuredContent: data,
      };
    } catch (error) {
      return {
        isError: true,
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({
              code: error instanceof TransitError ? error.code : 'QUERY_FAILED',
              message: error instanceof Error ? error.message : String(error),
              details:
                error instanceof TransitError ? error.details : undefined,
            }),
          },
        ],
      };
    }
  };
}

/** Register routing and saved-result tools against one local dataset service. */
export function createServer(service = new RoutingService()) {
  const server = new McpServer(
    { name: 'minotor-mcp', version },
    {
      instructions: [
        'Minotor provides local transit routing and reachability analysis from static GTFS timetables. Combine its results with local computation and visualization capabilities to answer the user’s question.',
        'Before routing, use list_datasets to check the active dataset and prepared service dates. Import missing feeds with mn data import <file> --service-date YYYY-MM-DD; prepare additional dates with mn data prepare --service-date YYYY-MM-DD. These commands require shell access on the server’s machine, using the same account and MINOTOR_MCP_HOME as the server. If unavailable, provide the required setup command to the user.',
        'Resolve stop IDs with search_stops. Use summaries and query_reachability for focused questions. For custom analysis and maps, execute code that reads the complete saved JSON file directly, returning findings or artifacts rather than printing every row. Previews are incomplete.',
        'When a map is requested, combine the complete results with available geographic rendering tools or libraries to produce and inspect a rendered map. Reachability describes stop/platform rows, not continuous walking coverage. Preserve routing metadata and warnings in the interpretation.',
        'Local file paths require access to the server’s filesystem; they do not provide remote access or cloud file transfer. Without that access, use focused queries and explain any limitation preventing the requested artifact. Full-detail pagination is a fallback when needed. Saved snapshots expire after 24 hours.',
      ].join(' '),
    },
  );
  const results = new Results(service.datasets);

  server.registerTool(
    'list_datasets',
    {
      description:
        'List local datasets, the active dataset, and prepared service days. Routing only uses prepared days. If no dataset exists, use mn data import <file> --service-date YYYY-MM-DD; prepare additional dates with mn data prepare --service-date YYYY-MM-DD on the server’s machine.',
      inputSchema: zod.object({}).strict(),
      outputSchema: datasetsOutputSchema,
      annotations: readOnly,
    },
    toolHandler(() => service.datasets.list()),
  );
  server.registerTool(
    'search_stops',
    {
      description:
        'Search stops by name; use returned GTFS IDs for routing. Accepts a single query or queries containing 1–20 complete queries. Batch results preserve input order and report execution errors per item; invalid input rejects the entire batch.',
      inputSchema: searchToolSchema,
      outputSchema: searchToolOutputSchema,
      annotations: readOnly,
    },
    toolHandler((query: zod.output<typeof searchToolSchema>) =>
      query.queries !== undefined
        ? service.searchStopsBatch(searchBatchSchema.parse(query))
        : service.searchStops(searchSchema.parse(query)),
    ),
  );
  server.registerTool(
    'plan_journey',
    {
      description:
        'Find an earliest-arrival journey, or set latestDeparture to return all retained departure/arrival alternatives ordered by departure. The inclusive window is a hard departure limit. Uses exact GTFS stop IDs and one prepared GTFS service day with minute precision. Accepts a single query or queries containing 1–20 complete queries. Batch results preserve input order and report execution errors per item; invalid input rejects the entire batch.',
      inputSchema: journeyToolSchema,
      outputSchema: journeyToolOutputSchema,
      annotations: readOnly,
    },
    toolHandler((query: zod.output<typeof journeyToolSchema>) =>
      query.queries !== undefined
        ? service.planJourneys(journeyBatchSchema.parse(query))
        : service.planJourney(journeySchema.parse(query)),
    ),
  );
  server.registerTool(
    'compute_reachability',
    {
      description:
        'Requires a prepared service day. Set latestDeparture in query to search a departure window; omit it for a single departure. Submit query to compute and save every reachable stop, or resultId to reuse a snapshot. Defaults to summary with statistics over all rows and at most five preview rows. For focused answers use query_reachability. For maps, process the complete JSON file with code on the same filesystem. Explicit view: page enables full-detail offset/limit pagination as a fallback. Files expire after 24 hours.',
      inputSchema: computeReachabilitySchema,
      outputSchema: computeReachabilityOutputSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    toolHandler(async (input: zod.output<typeof computeReachabilitySchema>) => {
      let id = input.resultId;

      if (id === undefined) {
        if (!input.query) {
          throw new TransitError(
            'INVALID_QUERY',
            'Provide a query or resultId',
          );
        }

        id = await results.save(await service.computeReachability(input.query));
      }

      return input.view === 'page'
        ? {
            ...(await results.page(id, input.offset, input.limit)),
            view: 'page',
          }
        : results.summary(id);
    }),
  );
  server.registerTool(
    'query_reachability',
    {
      description:
        'Filter, sort, project fields, and summarize a saved reachability result without rerouting. Statistics cover all matching stop/platform rows before pagination; limit: 0 returns statistics only. Duration/arrival/transfers use earliestArrival for single departures and shortestDuration for windows. Transfer filters inspect retained journeys, not alternate routes. Fetch a new routing result to change routing constraints. Files expire after 24 hours.',
      inputSchema: queryReachabilitySchema,
      outputSchema: queryReachabilityOutputSchema,
      annotations: readOnly,
    },
    toolHandler((query: zod.output<typeof queryReachabilitySchema>) =>
      results.query(query),
    ),
  );

  return server;
}

export function startServer() {
  const handle = serveStdio(() => createServer());
  process.once('SIGINT', () => void handle.close());
  process.once('SIGTERM', () => void handle.close());

  return handle;
}
