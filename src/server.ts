import Fastify, { type FastifyReply, type FastifyRequest } from 'fastify';
import cors from '@fastify/cors';
import pino from 'pino';
import { Counter, Gauge, Registry, collectDefaultMetrics } from 'prom-client';
import { Store, type Request as CapturedRequest } from './store.js';

const BIN_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_BODY_BYTES = 1 << 20; // 1 MiB
const RATE_LIMIT_PER_SEC = 10;
const RATE_LIMIT_BURST = 30;

// ── metrics ────────────────────────────────────────────────────────────────

const registry = new Registry();
collectDefaultMetrics({ register: registry });

const mIngestTotal = new Counter({
	name: 'polyhook_ingest_total',
	help: 'Webhook captures.',
	registers: [registry],
});
const mReplayAttempts = new Counter({
	name: 'polyhook_replay_attempts_total',
	help: 'Replay attempts (success or failure).',
	registers: [registry],
});
const mSSEClients = new Gauge({
	name: 'polyhook_sse_clients',
	help: 'Live SSE subscribers.',
	registers: [registry],
});

// ── SSE broadcaster ────────────────────────────────────────────────────────

type SSEEvent = { id: string; data: string };

class Broadcaster {
	private subs = new Map<string, Set<(e: SSEEvent) => void>>();

	subscribe(binId: string, cb: (e: SSEEvent) => void): () => void {
		let set = this.subs.get(binId);
		if (!set) {
			set = new Set();
			this.subs.set(binId, set);
		}
		set.add(cb);
		mSSEClients.inc();
		return () => {
			const s = this.subs.get(binId);
			if (!s) return;
			s.delete(cb);
			if (s.size === 0) this.subs.delete(binId);
			mSSEClients.dec();
		};
	}

	publish(binId: string, ev: SSEEvent): void {
		const set = this.subs.get(binId);
		if (!set) return;
		for (const cb of set) {
			try {
				cb(ev);
			} catch {
				// One bad subscriber must not stall ingest.
			}
		}
	}
}

// ── rate limiter (per-IP token bucket) ─────────────────────────────────────

type Bucket = { tokens: number; last: number };

class Limiter {
	private buckets = new Map<string, Bucket>();
	constructor(
		private rps: number,
		private burst: number,
	) {}

	allow(key: string): { ok: boolean; retryAfterMs: number; remaining: number } {
		const now = Date.now();
		let b = this.buckets.get(key);
		if (!b) {
			b = { tokens: this.burst, last: now };
			this.buckets.set(key, b);
		}
		const elapsed = (now - b.last) / 1000;
		b.tokens = Math.min(this.burst, b.tokens + elapsed * this.rps);
		b.last = now;
		if (b.tokens < 1) {
			const retry = ((1 - b.tokens) / this.rps) * 1000 + 1;
			return { ok: false, retryAfterMs: retry, remaining: 0 };
		}
		b.tokens -= 1;
		return { ok: true, retryAfterMs: 0, remaining: Math.floor(b.tokens) };
	}
}

const clientIp = (req: FastifyRequest): string => {
	const xff = req.headers['x-forwarded-for'];
	if (typeof xff === 'string' && xff.length > 0) {
		const i = xff.indexOf(',');
		return i > 0 ? xff.slice(0, i).trim() : xff.trim();
	}
	return req.ip;
};

// ── replay worker ──────────────────────────────────────────────────────────

class ReplayWorker {
	private queue: string[] = [];
	private running = false;
	constructor(
		private store: Store,
		private log: pino.Logger,
	) {}

	enqueue(replayId: string): void {
		this.queue.push(replayId);
		void this.drain();
	}

	private async drain(): Promise<void> {
		if (this.running) return;
		this.running = true;
		try {
			while (this.queue.length > 0) {
				const id = this.queue.shift()!;
				await this.process(id);
			}
		} finally {
			this.running = false;
		}
	}

	private async process(id: string): Promise<void> {
		const rep = this.store.getReplay(id);
		if (!rep) return;
		const req = this.store.getRequest(rep.request_id);
		if (!req) {
			this.store.updateReplay(rep.id, 'failed', rep.attempts, 'source request gone');
			return;
		}
		for (let attempt = rep.attempts; attempt <= rep.max_retries; attempt++) {
			this.store.updateReplay(rep.id, 'in_progress', attempt + 1, null);
			mReplayAttempts.inc();
			const err = await this.send(rep.target_url, req);
			if (!err) {
				this.store.updateReplay(rep.id, 'succeeded', attempt + 1, null);
				return;
			}
			this.log.warn({ id: rep.id, attempt: attempt + 1, err }, 'replay: attempt failed');
			if (attempt === rep.max_retries) {
				this.store.updateReplay(rep.id, 'failed', attempt + 1, err);
				return;
			}
			// Exponential backoff: 1s, 2s, 4s, 8s, 16s.
			const backoff = (1 << attempt) * 1000;
			await new Promise((r) => setTimeout(r, backoff));
		}
	}

	private async send(target: string, req: CapturedRequest): Promise<string | null> {
		const skip = new Set(['host', 'content-length', 'connection', 'transfer-encoding']);
		const headers: Record<string, string> = {};
		for (const [k, v] of Object.entries(req.headers)) {
			if (skip.has(k.toLowerCase())) continue;
			headers[k] = v;
		}
		headers['x-polyhook-replay-of'] = req.id;
		const ctrl = new AbortController();
		const t = setTimeout(() => ctrl.abort(), 10_000);
		// Buffer's generic ArrayBufferLike (which can be SharedArrayBuffer) trips
		// up Blob's BlobPart type. Copy into a plain Uint8Array<ArrayBuffer>.
		const body = req.body.length > 0 ? new Blob([Uint8Array.from(req.body)]) : undefined;
		try {
			const res = await fetch(target, {
				method: req.method,
				headers,
				body,
				signal: ctrl.signal,
			});
			if (res.status >= 500 || res.status === 429) {
				return `target returned ${res.status}`;
			}
			return null;
		} catch (e) {
			return (e as Error).message;
		} finally {
			clearTimeout(t);
		}
	}
}

// ── server ─────────────────────────────────────────────────────────────────

async function main() {
	const log = pino({ level: process.env.LOG_LEVEL ?? 'info' });

	let dbPath = process.env.DB_PATH;
	if (!dbPath) {
		const fs = await import('node:fs');
		dbPath = fs.existsSync('/data') ? '/data/polyhook.db' : 'polyhook.db';
	}
	const store = new Store(dbPath);
	const broadcaster = new Broadcaster();
	const limiter = new Limiter(RATE_LIMIT_PER_SEC, RATE_LIMIT_BURST);
	const replay = new ReplayWorker(store, log);
	const startedAt = Date.now();

	const app = Fastify({ loggerInstance: log, bodyLimit: MAX_BODY_BYTES + 1 });
	await app.register(cors, {
		origin: '*',
		methods: ['GET', 'POST', 'DELETE', 'OPTIONS'],
		allowedHeaders: ['Content-Type', 'X-Delete-Token', 'Last-Event-ID', 'If-None-Match'],
	});

	// Webhook ingest must accept any content-type and preserve raw bytes.
	app.addContentTypeParser('*', { parseAs: 'buffer' }, (_req, body, done) => {
		done(null, body);
	});

	// Periodic sweeper for expired bins.
	const sweeper = setInterval(() => {
		const n = store.sweepExpired();
		if (n > 0) log.info({ expired_bins: n }, 'sweep');
	}, 5 * 60 * 1000);

	const publicURL = (req: FastifyRequest): string => {
		if (process.env.PUBLIC_URL) return process.env.PUBLIC_URL.replace(/\/$/, '');
		const proto = (req.headers['x-forwarded-proto'] as string | undefined) ?? req.protocol;
		const host = (req.headers['x-forwarded-host'] as string | undefined) ?? req.headers.host;
		return `${proto}://${host}`;
	};

	const writeErr = (reply: FastifyReply, status: number, msg: string, details?: string) =>
		reply.status(status).send({ error: msg, ...(details ? { details } : {}) });

	// ── routes ────────────────────────────────────────────────────────────

	app.get('/healthz', async (_req, reply) => {
		return reply.send({
			status: 'ok',
			impl: 'node',
			uptime_seconds: Math.floor((Date.now() - startedAt) / 1000),
		});
	});

	app.get('/metrics', async (_req, reply) => {
		reply.header('Content-Type', registry.contentType);
		return reply.send(await registry.metrics());
	});

	app.post('/v1/bins', async (req, reply) => {
		const bin = store.createBin(BIN_TTL_MS);
		const host = publicURL(req);
		return reply.status(201).send({
			id: bin.id,
			ingest_url: `${host}/v1/bins/${bin.id}/in`,
			view_url: `${host}/v1/bins/${bin.id}/requests`,
			delete_token: bin.delete_token,
			expires_at: new Date(bin.expires_at * 1000).toISOString(),
		});
	});

	app.delete<{ Params: { id: string } }>('/v1/bins/:id', async (req, reply) => {
		const tok = req.headers['x-delete-token'];
		if (typeof tok !== 'string' || tok === '') {
			return writeErr(reply, 401, 'missing X-Delete-Token');
		}
		const ok = store.deleteBin(req.params.id, tok);
		if (!ok) return writeErr(reply, 404, 'not found');
		return reply.status(204).send();
	});

	app.route<{ Params: { id: string }; Body: Buffer }>({
		method: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'],
		url: '/v1/bins/:id/in',
		handler: async (req, reply) => {
			const ip = clientIp(req);
			const rl = limiter.allow(ip);
			reply.header('X-RateLimit-Limit', RATE_LIMIT_BURST);
			reply.header('X-RateLimit-Remaining', rl.remaining);
			if (!rl.ok) {
				reply.header('Retry-After', Math.ceil(rl.retryAfterMs / 1000));
				return writeErr(reply, 429, 'rate limit exceeded');
			}

			const bin = store.getBin(req.params.id);
			if (!bin) return writeErr(reply, 404, 'bin not found');

			const body = (req.body as Buffer | undefined) ?? Buffer.alloc(0);
			if (body.length > MAX_BODY_BYTES) {
				return writeErr(reply, 413, 'body too large');
			}

			const headers: Record<string, string> = {};
			for (const [k, v] of Object.entries(req.headers)) {
				if (v == null) continue;
				headers[k.toLowerCase()] = Array.isArray(v) ? v.join(', ') : String(v);
			}

			const stored = store.storeRequest(bin.id, req.method, headers, body);
			mIngestTotal.inc();

			const payload = {
				id: stored.id,
				method: stored.method,
				headers: stored.headers,
				body_size: stored.body.length,
				body_b64: stored.body.toString('base64'),
				received_at: new Date(stored.received_at * 1000).toISOString(),
			};
			broadcaster.publish(bin.id, { id: stored.id, data: JSON.stringify(payload) });

			return reply.status(202).send({
				request_id: stored.id,
				received_at: payload.received_at,
			});
		},
	});

	app.get<{ Params: { id: string }; Querystring: { cursor?: string; limit?: string } }>(
		'/v1/bins/:id/requests',
		async (req, reply) => {
			if (!store.getBin(req.params.id)) return writeErr(reply, 404, 'bin not found');
			const limitParsed = Number(req.query.limit ?? '20');
			const limit = Number.isFinite(limitParsed) && limitParsed > 0 && limitParsed <= 100 ? Math.floor(limitParsed) : 20;
			let page;
			try {
				page = store.listRequests(req.params.id, req.query.cursor, limit);
			} catch (e) {
				return writeErr(reply, 400, 'list', (e as Error).message);
			}

			const body = JSON.stringify({
				items: page.items.map((it) => ({
					id: it.id,
					method: it.method,
					headers: it.headers,
					body_size: it.body.length,
					received_at: new Date(it.received_at * 1000).toISOString(),
				})),
				next_cursor: page.nextCursor,
			});

			const { createHash } = await import('node:crypto');
			const etag = `"${createHash('sha1').update(body).digest('hex')}"`;
			if (req.headers['if-none-match'] === etag) {
				return reply.status(304).send();
			}
			reply.header('ETag', etag);
			reply.header('Cache-Control', 'private, max-age=2');
			reply.header('Content-Type', 'application/json');
			return reply.send(body);
		},
	);

	app.get<{ Params: { id: string } }>('/v1/bins/:id/stream', async (req, reply) => {
		if (!store.getBin(req.params.id)) return writeErr(reply, 404, 'bin not found');

		reply.raw.writeHead(200, {
			'Content-Type': 'text/event-stream',
			'Cache-Control': 'no-cache',
			Connection: 'keep-alive',
			'X-Accel-Buffering': 'no',
		});
		reply.raw.write(': ok\n\n');

		const unsubscribe = broadcaster.subscribe(req.params.id, (ev) => {
			reply.raw.write(`id: ${ev.id}\nevent: request\ndata: ${ev.data}\n\n`);
		});

		const heartbeat = setInterval(() => {
			reply.raw.write(': ping\n\n');
		}, 15_000);

		req.raw.on('close', () => {
			clearInterval(heartbeat);
			unsubscribe();
		});

		// Tell Fastify we're handling the response ourselves.
		return reply.hijack();
	});

	app.post<{ Params: { id: string; rid: string }; Body: { target_url?: string; max_retries?: number } }>(
		'/v1/bins/:id/requests/:rid/replay',
		async (req, reply) => {
			const bin = store.getBin(req.params.id);
			if (!bin) return writeErr(reply, 404, 'bin not found');
			const sourceReq = store.getRequest(req.params.rid);
			if (!sourceReq || sourceReq.bin_id !== bin.id) return writeErr(reply, 404, 'request not found');

			const body = req.body ?? {};
			const targetUrl = typeof body.target_url === 'string' ? body.target_url : '';
			if (!/^https?:\/\//.test(targetUrl)) {
				return writeErr(reply, 400, 'target_url must be http(s)');
			}
			let maxRetries = 5;
			if (typeof body.max_retries === 'number') {
				if (body.max_retries < 0 || body.max_retries > 5) {
					return writeErr(reply, 400, 'max_retries must be 0..5');
				}
				maxRetries = Math.floor(body.max_retries);
			}

			const rep = store.createReplay(sourceReq.id, targetUrl, maxRetries);
			replay.enqueue(rep.id);
			return reply.status(202).send({ replay_id: rep.id });
		},
	);

	app.get<{ Params: { rid: string } }>('/v1/replays/:rid', async (req, reply) => {
		const rep = store.getReplay(req.params.rid);
		if (!rep) return writeErr(reply, 404, 'not found');
		return reply.send({
			id: rep.id,
			request_id: rep.request_id,
			target_url: rep.target_url,
			status: rep.status,
			attempts: rep.attempts,
			last_error: rep.last_error,
			updated_at: new Date(rep.updated_at * 1000).toISOString(),
		});
	});

	const port = Number(process.env.PORT ?? '8080');
	await app.listen({ host: '0.0.0.0', port });
	log.info({ addr: `:${port}`, impl: 'node', db: dbPath }, 'listening');

	const shutdown = async (sig: string) => {
		log.info({ sig }, 'shutting down');
		clearInterval(sweeper);
		await app.close();
		store.close();
		process.exit(0);
	};
	process.on('SIGINT', () => void shutdown('SIGINT'));
	process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
