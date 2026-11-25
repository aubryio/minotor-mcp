---
name: minotor-mcp
description: Use Minotor MCP or its mn CLI to plan public transport journeys, analyze reachable stops, and produce maps from local GTFS timetables. Use for schedule-based transit analysis, including dataset preparation and complete-result computation.
---

# Transit analysis with Minotor

Use Minotor for transit computation, local code for custom analysis, and available
geographic rendering tools for maps. Produce the requested answer or artifact using
the complete relevant results, while keeping bulk rows out of model context.

## Establish data and routing inputs

- Call `list_datasets` to inspect the active dataset and prepared service dates.
  Use the user's intended date; do not silently substitute an available day.
- If a feed is missing, import a user-selected static GTFS ZIP on the server's machine:
  `mn data import /path/to/feed.zip --service-date YYYY-MM-DD`.
  Prepare additional dates with `mn data prepare --service-date YYYY-MM-DD`.
  Use `mn data use <dataset-id>` when a different imported feed is needed.
- Shell commands and MCP must use the same account and `MINOTOR_MCP_HOME`, if set.
  Without shell access to that machine, give the user the exact setup command.
  No feed is bundled; ask for the feed or intended region if it is unknown.
- Resolve exact GTFS IDs with `search_stops`; distinguish ambiguous names using
  location and station context. Use an explicit departure timezone offset.
- Call `plan_journey` for destinations or `compute_reachability` for all reachable
  stops. Set `latestDeparture` only for a requested departure window. For broad
  searches, use an explicit duration bound and avoid unnecessarily long windows.
  Search and journey tools support batches of 1–20 independent queries; check each
  item status as well as MCP `isError`.

## Choose the smallest useful result

- Start with the reachability summary. Its preview contains at most five rows and
  cannot establish complete coverage or support population-wide conclusions.
- Reuse `resultId` with `query_reachability` for filtering and aggregation;
  `limit: 0` returns statistics over all matches without rows. Filters operate on
  retained journeys; reroute when changing routing constraints.
- For custom calculations or maps, execute code that reads the returned file on
  the server's filesystem. Do not print or read the entire JSON into model context.
  MCP snapshots contain `{ resultId, expiresAt, result }`; CLI exports contain the
  result directly. All rows are in `result.stops`.
- Each row contains `stop` metadata. Use `row.earliestArrival` for single departures
  and `row.shortestDuration` for departure windows when comparing travel duration.
  Keep duration, arrival, departure, and transfers from the same alternative.
- Snapshots expire after 24 hours. Recompute expired or missing results; use explicit
  CLI exports when a persistent artifact is needed.
- A local path does not provide remote file access. Without shared filesystem
  access, use focused queries. Full-detail pages (`view: "page"`, up to 500 rows,
  following `nextOffset`) are a fallback when necessary; fetching all pages into
  conversation consumes context. Explain if missing access prevents an artifact.

## Produce a map when requested

Use an available mapping tool or library to render a geographic artifact. Pass a
file or artifact reference when supported, keeping the full data flow in code.
Do not assume a particular mapping service or claim that Minotor renders maps.

- Build features from all relevant rows with finite `stop.longitude` and
  `stop.latitude`; GeoJSON coordinates use `[longitude, latitude]`. Report omitted
  rows with missing coordinates and handle an empty result explicitly.
- Preserve stop IDs and names and the chosen travel-time basis. Style points by
  duration when useful, add a legend, and fit the map to their bounds.
- Label service date, departure or window, timezone, origin, and relevant routing
  constraints. Preserve material warnings and provider attribution.
- Describe reachable stops, not a continuous walking isochrone. Do not invent
  street paths or journey geometry. Separate pedestrian networks or basemaps need
  their own source and compatible tools.
- Inspect the rendered artifact for coordinate placement, extent, and readable
  labels or legend before returning it with a concise explanation.

See the project's readme.md for installation and CLI usage.
