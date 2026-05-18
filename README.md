# chatbot-evals

A three-phase LLM evaluation pipeline for a Vercel AI SDK chatbot, with
telemetry round-trip through [Bronto](https://bronto.io). Built for the
companion repo
[BrontoStephen/BrontoVercelAIsample](https://github.com/BrontoStephen/BrontoVercelAIsample).

- **Phase 1 — `run-eval.ts`**: POSTs 8 test prompts at the deployed chatbot,
  streams the Vercel AI SDK v6 SSE response, captures raw outputs.
- **Phase 2 — `score-eval.ts`**: scores each answer using
  `claude-sonnet-4-20250514` as judge on correctness / completeness / clarity,
  then writes the scores back into Bronto so they are queryable alongside the
  original chat traces.
- **Phase 3 — `report.ts`**: renders a Markdown report with summary tables,
  ASCII score-distribution bars, per-tag aggregates, and per-case judge
  rationale.

A convenience driver `run-all.ts` chains all three phases with a configurable
wait between Phase 1 and Phase 2 so Bronto's Log Drain has time to ingest the
chat events.

See [`examples/run-traces-1779110399/report.md`](examples/run-traces-1779110399/report.md)
for the canonical end-to-end run output (traces source, 8/8 passed, avg 5.0).
[`examples/run-demo-1779108303/report.md`](examples/run-demo-1779108303/report.md)
is the earlier logs-source run for reference.

## How it tags requests

Each request to the chatbot carries two headers:

```
x-eval-run-id:  <run id>      e.g. run-demo-1779108303
x-eval-case-id: <case id>     e.g. js-closures
```

The chatbot's `/api/chat` route reads these headers and stamps them on the
active OTel span (so child spans inherit), and on the `logWithStatement`
payloads (so Vercel Log Drains route them into Bronto with the eval tags
embedded). The full assistant text is also logged on completion when eval
headers are present, so Phase 2 can score either from local raw captures or
from the Bronto round-trip.

The chatbot-side patch is small — see
[BrontoVercelAIsample/src/instrumentation.ts](https://github.com/BrontoStephen/BrontoVercelAIsample/blob/main/src/instrumentation.ts)
and
[BrontoVercelAIsample/src/app/api/chat/route.ts](https://github.com/BrontoStephen/BrontoVercelAIsample/blob/main/src/app/api/chat/route.ts).

## Quick start

```bash
git clone https://github.com/BrontoStephen/chatbot-evals
cd chatbot-evals
npm install

cp .env.example .env.local
# fill in BRONTO_API_KEY and ANTHROPIC_API_KEY

export $(grep -v '^#' .env.local | xargs)
npm run -- run        # alias for: tsx scripts/eval/run-all.ts
```

Output lands in `eval-results/<run-id>/`:
- `raw-responses.json` — Phase 1 captures.
- `scores.json` — Phase 2 score records and metadata.
- `report.md` — Phase 3 rendered Markdown.

## Flags

```bash
# Skip Phase 1 (use existing raw-responses.json)
npx tsx scripts/eval/run-all.ts --skip-run

# Force scoring from local (bypass Bronto query)
npx tsx scripts/eval/run-all.ts --source local

# Custom wait between phase 1 and 2 (default 45s)
npx tsx scripts/eval/run-all.ts --wait 90

# Score a previous run only
npx tsx scripts/eval/score-eval.ts --run <run-id> --source local
npx tsx scripts/eval/report.ts --run <run-id>
```

## Source modes

Phase 2 can pull the chatbot's responses either from Bronto's Traces drain
(preferred) or from the Vercel Logs drain. Set `BRONTO_SOURCE`:

- **`BRONTO_SOURCE=traces`** (default): query
  `dataset = '${BRONTO_TRACES_DATASET}' AND collection = '${BRONTO_TRACES_COLLECTION}'`
  for `ai.streamText` spans with
  `"$ai.telemetry.metadata.eval_run_id"='<run-id>'`. Pulls
  `$ai.response.text`, `$ai.prompt`, `$ai.usage.{input,output}Tokens`, and
  span duration as first-class indexed attributes. Requires:
  - `experimental_telemetry: { isEnabled: true, metadata: { eval_run_id, eval_case_id } }`
    on the `streamText` call in your chatbot's `/api/chat` route.
  - A Vercel **Traces** drain configured to Bronto's
    `https://ingestion.<region>.bronto.io/v1/traces` endpoint.
- **`BRONTO_SOURCE=logs`**: fall back to the Logs drain dataset and filter
  with `@raw LIKE '%<run-id>%'`. Brittle string match; only useful when you
  don't have Traces drain set up.

## Notes from the end-to-end runs

These are quirks of this particular setup that the scripts already work around:

- **AI SDK v6 SSE format**: response is `data: {"type":"text-delta","delta":"..."}\n\n`,
  not the legacy `0:"..."` prefix. The client parses SSE and concatenates
  `text-delta` events.
- **Bronto Search API**: path is `/search` (not `/v1/search`); `from`,
  `select` are arrays; query by dataset name uses `from_expr`; use
  `select: ["*"]` to get all attributes back.
- **Attribute namespace is `$ai.*` not `$gen_ai.*`**: the Vercel AI SDK
  emits its own `ai.*` semantic-convention names rather than OTel's
  GenAI conventions. Once on Bronto they're prefixed with `$`.
- **`maxDuration` matters**: if the Lambda is killed mid-stream, the
  `ai.streamText` span never records `ai.response.text` or `ai.usage.*`.
  Set `maxDuration` ≥ ~60 s for explanation-style prompts on gpt-4-turbo.
- **Vercel `onFinish` may still not flush** for the longest streams —
  `score-eval` falls back to the local raw captures automatically when the
  Bronto query returns fewer events than expected.
- **Anthropic rate limit** on `claude-sonnet-4-20250514` is 5 req/min on
  default tier — the script paces calls at one every 13 s with 429-backoff
  retries.

## Sanity-checking the Bronto round trip

After a run, you can list the original chat traces …

```bash
curl -s -X POST "https://api.eu.bronto.io/search" \
  -H "X-BRONTO-API-KEY: $BRONTO_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "from_expr": "dataset = \"vercel-ai-demo\" AND collection = \".traces\"",
    "time_range": "Last 1 hour",
    "select": ["*"],
    "where":  "\"$span.name\"=\"ai.streamText\" AND \"$ai.telemetry.metadata.eval_run_id\"=\"<your-run-id>\"",
    "limit":  50,
    "most_recent_first": true
  }'
```

… and the score events that were written back:

```bash
curl -s -X POST "https://api.eu.bronto.io/search" \
  -H "X-BRONTO-API-KEY: $BRONTO_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "from_expr": "dataset = \"chatbot\" AND collection = \"vercel\"",
    "time_range": "Last 1 hour",
    "select": ["@raw","@time"],
    "where":  "@raw LIKE \"%<your-run-id>%\" AND @raw LIKE \"%llm_eval_score%\"",
    "limit":  50,
    "most_recent_first": true
  }'
```

Or via the [Bronto MCP](https://docs.bronto.io/ai-features/hosted-mcp) once
attached to your Claude Code session:

```
mcp__bronto__search_logs \
  where='"$span.name"="ai.streamText" AND "$ai.telemetry.metadata.eval_run_id"="<your-run-id>"' \
  limit=50
```

## License

MIT.
