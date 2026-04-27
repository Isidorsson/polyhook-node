# polyhook-node

Webhook bin with live SSE streaming and replay-with-retries — **Node.js implementation**.

This is one half of a two-implementation polyglot study. The Go twin is at
[Isidorsson/polyhook-go](https://github.com/Isidorsson/polyhook-go). Both
implement the same [`openapi.yaml`](./openapi.yaml) and are compared
side-by-side at [andreasisidorsson.com/projects/polyhook](https://andreasisidorsson.com/projects/polyhook).

## What it does

- Create an ephemeral bin → get an `ingest_url`, a `view_url`, and a `delete_token`.
- POST anything to `ingest_url` (any HTTP method, any content-type, any body).
- Subscribe to the bin's SSE stream → captured requests arrive in real time.
- Replay a captured request to a target URL with exponential-backoff retries.
- Bins auto-expire after 24h.

## Stack

| Concern               | Choice                                                       |
| --------------------- | ------------------------------------------------------------ |
| HTTP                  | Fastify 5 (TypeScript)                                       |
| Persistence           | `node:sqlite` (built-in to Node 22+, no native deps)         |
| Logging               | `pino` (structured JSON)                                     |
| Metrics               | `prom-client` (text exposition at `/metrics`)                |
| Concurrency           | event loop, per-bin subscriber `Set<callback>`, non-blocking emit |
| Rate limiting         | per-IP token bucket (10 req/s, burst 30) on ingest           |
| Replay worker         | single in-process queue drained sequentially, exp. backoff   |

> No `better-sqlite3`, no `pg`, no `redis`. The DB story is "use what Node gives you."

## Running locally

Requires Node 22 or newer (for `node:sqlite`).

```bash
npm install
npm run dev
# listens on :8080 by default; DB at ./polyhook.db
```

Try it (identical curl examples to the Go twin — that's the point):

```bash
# 1. Create a bin
curl -s -X POST http://localhost:8080/v1/bins | tee /tmp/bin.json

INGEST=$(jq -r .ingest_url /tmp/bin.json)
VIEW=$(jq -r .view_url   /tmp/bin.json)
ID=$(jq -r .id           /tmp/bin.json)

# 2. POST anything to it
curl -s -X POST -H "Content-Type: application/json" \
  -d '{"event":"order.created","amount":4200}' "$INGEST"

# 3. List captured requests (cursor-paginated, ETag-cacheable)
curl -s "$VIEW?limit=10" | jq

# 4. Stream new requests as they arrive
curl -N "http://localhost:8080/v1/bins/$ID/stream"

# 5. Replay any captured request
RID=$(curl -s "$VIEW" | jq -r '.items[0].id')
curl -s -X POST -H "Content-Type: application/json" \
  -d '{"target_url":"https://httpbin.org/post"}' \
  "http://localhost:8080/v1/bins/$ID/requests/$RID/replay"
```

## Configuration (env)

| Var          | Default               | Notes                                       |
| ------------ | --------------------- | ------------------------------------------- |
| `PORT`       | `8080`                | HTTP listen port                            |
| `DB_PATH`    | `/data/polyhook.db`*  | SQLite file path (*falls back to `./polyhook.db` if `/data` not writable) |
| `PUBLIC_URL` | (derived from request)| Sets the host returned in `ingest_url`/`view_url` |
| `LOG_LEVEL`  | `info`                | `debug` for verbose                         |

## Deploying to Railway

1. Push this repo to GitHub.
2. New Railway project → "Deploy from GitHub repo" → select `polyhook-node`.
3. Railway auto-detects the `Dockerfile`. Set `PUBLIC_URL` once the public URL is assigned.
4. Add a volume mounted at `/data` for SQLite persistence.
5. Healthcheck path: `/healthz`.

The image is `~150 MB` (Node 22 alpine base) and the process holds `~70 MB` RSS at idle.

## What's interesting in the code

| File              | What to look at                                                         |
| ----------------- | ----------------------------------------------------------------------- |
| `src/store.ts:60-75`  | `node:sqlite` setup (no native build, no `better-sqlite3`)          |
| `src/store.ts:125`    | Cursor pagination via composite `(received_at, id)` key             |
| `src/server.ts:35`    | SSE broadcaster: `Set<callback>` per bin, try/catch isolates slow subscribers |
| `src/server.ts:75`    | Token-bucket rate limiter (per-IP, lazily allocated)                |
| `src/server.ts:115`   | Replay worker: single drain loop with exp. backoff `1s → 16s`       |
| `src/server.ts:225`   | Strong ETag via `crypto.createHash('sha1')` + `If-None-Match` shortcut |
| `src/server.ts:265`   | SSE: `reply.hijack()` + writes to `reply.raw` for Fastify-friendly streaming |

## Spec

See [`openapi.yaml`](./openapi.yaml) — identical to the Go twin's. Both implementations conform.

## License

MIT
