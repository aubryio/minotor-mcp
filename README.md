# minotor-mcp

[Quick start](#quick-start) · [What it can do](#what-it-can-do) · [CLI](#cli) ·
[Why Minotor](#why-minotor) · [Privacy policy](#privacy-policy) ·
[License](#license) · [Author](#author)

**Fast, unlimited, public transit routing for your agents.**

Give your assistant an unlimited transit routing engine: find journeys, explore reachable destinations,
and analyze transport networks. Powered by [Minotor](https://github.com/aubryio/minotor).

- **🔓 Unlimited routing queries.** No routing API keys, per-query fees, rate limits,
  or service quotas. Import a timetable, prepare your dates, and explore freely.
- **🚆 Country-scale networks.** Work with national GTFS feeds such as Switzerland's,
  bringing trains, buses, trams, and other scheduled services into one analysis.
- **⚡ Fast, local computation.** Minotor's in-memory RAPTOR engine computes journeys
  and travel times to every reachable stop.
- **🧭 Go beyond directions.** Combine reachability results with mapping tools to
  create stop-based isochrone maps, travel-time cartograms, and accessibility
  comparisons across origins or departure times.
- **🛠️ Built for agents and code.** Compact summaries answer focused questions;
  complete local artifacts let code analyze every result without filling the
  model's context with raw data.

Query volume is limited by your hardware and AI client, not a routing service.
Map rendering uses complementary visualization tools. Transit data is not provided.

## Quick start

### 1. Install

Requires **Node.js 24.15 or later**. Install the CLI globally so your assistant
can launch `mn` from any directory:

```sh
npm install -g minotor-mcp
```

This installs the `mn` command. Check it with `mn --help`.

### 2. Import a timetable

Download a **static GTFS ZIP** from your transit provider, for example the
[Swiss timetable catalogue](https://data.opentransportdata.swiss/en/dataset/timetable-2026-gtfs2020).

```sh
curl -fL "https://data.opentransportdata.swiss/en/dataset/timetable-2026-gtfs2020/permalink" -o swiss-2026.zip
mn data import ./swiss-2026.zip --service-date 2026-11-24 --name "Switzerland 2026"
mn data list
```

Choose a service date covered by your feed. Import prepares that day's timetable;
large feeds may take a few minutes. The first successfully prepared dataset becomes
active. Prepare another day or select a different imported dataset with:

```sh
mn data prepare --service-date 2026-11-25
mn data use <dataset-id>
```

### 3. Connect your assistant

Choose your client below. Each launches `mn mcp` as a local **stdio** server;
no server URL or API key is needed.

**[Codex](https://learn.chatgpt.com/docs/extend/mcp)**

```sh
codex mcp add minotor-mcp -- mn mcp
codex mcp list
```

**[Claude Code](https://code.claude.com/docs/en/mcp)**

```sh
claude mcp add --transport stdio --scope user minotor-mcp -- mn mcp
claude mcp list
```

**[Claude Desktop](https://modelcontextprotocol.io/docs/develop/connect-local-servers)**

Open **Settings → Developer → Edit Config** and merge the following into
`claude_desktop_config.json`, then restart Claude Desktop:

```json
{
  "mcpServers": {
    "minotor-mcp": {
      "command": "mn",
      "args": ["mcp"]
    }
  }
}
```

**[Cursor](https://cursor.com/docs/mcp) and other MCP clients**

For Cursor, put the same JSON in `~/.cursor/mcp.json` for all projects, or
`.cursor/mcp.json` for one project. For other clients, configure a local stdio
server with command `mn` and arguments `["mcp"]`; configuration formats vary.

### 4. Optional: add the companion skill

The server already supplies workflow instructions. The
[companion skill](skills/minotor-mcp/SKILL.md) adds guidance for dataset preparation,
local analysis, and maps.

## What it can do

Adapt the places and departure dates in these example questions to your feed.

| Tool                   | Example questions                                                                                                                    |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `list_datasets`        | Which timetables are installed, and which dates are ready to query?                                                                  |
| `search_stops`         | Which stops and stations match “Lausanne”?                                                                                           |
| `plan_journey`         | How can I travel from Lausanne to Genève on November 24, 2026, leaving at 08:00? What alternatives depart before?                    |
| `compute_reachability` | Which stops can I reach from Lausanne within an hour on November 24, 2026, leaving at 08:00 +01:00? Can you map them by travel time? |
| `query_reachability`   | Of those reachable stops, how many are within 30 minutes? Which ten have the shortest travel times?                                  |

**Limits.** Results use static schedules, without live delays or disruptions, and
one prepared service day per query with minute precision. Maps require additional geographic rendering tools or libraries.

### CLI

The same engine works from your terminal without an AI client:

```sh
mn stops search "Lausanne"
mn route "Lausanne" "Genève" --depart "2026-11-24T08:00:00+01:00" --latest-departure "2026-11-24T08:30:00+01:00"
mn reachability "Lausanne" --depart "2026-11-24T08:00:00+01:00" --max-duration 60 --output reachability.json
```

## Why Minotor

**🏠 A whole network on your machine, ready for repeated exploration.**
[Minotor](https://github.com/aubryio/minotor) parses GTFS timetables and routes over
prepared, in-memory data using RAPTOR. It supports national feeds such as
Switzerland's and computes travel times from an origin to every reachable stop,
providing the foundation for network-wide accessibility analysis.

**🔓 Ask more questions without paying for each route.** Compare origins, departure
times, and travel budgets without routing API keys, service quotas, or per-query
charges. Once prepared, timetables can be queried offline. Actual speed and capacity
depend on the feed, hardware, and query constraints; broad departure windows cost
more than single-departure searches.

**🗺️ Turn travel times into something you can interpret.** Combine the results with
geographic rendering tools for stop-based isochrone maps, or build travel-time
cartograms that show destinations by how long they take to reach. Complete local
artifacts support custom calculations and comparisons; saved-result queries answer
follow-up questions without rerouting. Continuous walking coverage requires
additional pedestrian data and computation.

## Privacy policy

Imported timetables and routing queries are processed locally. It does not
include telemetry, upload feeds, or automatically download timetable data. Tool
requests and responses pass through your connected AI client, which may send them
to its model provider under that service's policies. Local computation reduces the
amount returned to the model; it does not make the AI client offline.

Imported ZIPs, metadata, and prepared timetables remain in OS-specific data storage.
Saved reachability snapshots reside in cache storage, expire after 24 hours, and are
cleaned up when another result is saved. Explicit CLI exports do not expire.
External map tools, basemaps, and transit data providers have their own network behavior
and privacy policies.

## License

[MIT](LICENSE). Minotor and other dependencies retain their own licenses. GTFS feeds
remain subject to their providers' terms, including any required attribution; the
software license does not grant rights to timetable data.

## Author

[Aubry Cholleton — aubry.io](https://aubry.io)
