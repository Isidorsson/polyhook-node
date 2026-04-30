import { DatabaseSync } from 'node:sqlite';
import { randomBytes } from 'node:crypto';

const SCHEMA_STATEMENTS = [
	`CREATE TABLE IF NOT EXISTS bins (
    id           TEXT PRIMARY KEY,
    delete_token TEXT NOT NULL,
    created_at   INTEGER NOT NULL,
    expires_at   INTEGER NOT NULL
  )`,
	`CREATE INDEX IF NOT EXISTS bins_expires ON bins(expires_at)`,
	`CREATE TABLE IF NOT EXISTS requests (
    id          TEXT PRIMARY KEY,
    bin_id      TEXT NOT NULL,
    method      TEXT NOT NULL,
    headers     TEXT NOT NULL,
    body        BLOB NOT NULL,
    received_at INTEGER NOT NULL,
    FOREIGN KEY (bin_id) REFERENCES bins(id) ON DELETE CASCADE
  )`,
	`CREATE INDEX IF NOT EXISTS requests_bin_time ON requests(bin_id, received_at DESC, id)`,
	`CREATE TABLE IF NOT EXISTS replays (
    id          TEXT PRIMARY KEY,
    request_id  TEXT NOT NULL,
    target_url  TEXT NOT NULL,
    status      TEXT NOT NULL,
    attempts    INTEGER NOT NULL DEFAULT 0,
    max_retries INTEGER NOT NULL,
    last_error  TEXT,
    updated_at  INTEGER NOT NULL,
    FOREIGN KEY (request_id) REFERENCES requests(id) ON DELETE CASCADE
  )`,
	`CREATE INDEX IF NOT EXISTS replays_status ON replays(status, updated_at)`,
];

export type Bin = {
	id: string;
	delete_token: string;
	created_at: number;
	expires_at: number;
};

export type Request = {
	id: string;
	bin_id: string;
	method: string;
	headers: Record<string, string>;
	body: Buffer;
	received_at: number;
};

export type Replay = {
	id: string;
	request_id: string;
	target_url: string;
	status: 'queued' | 'in_progress' | 'succeeded' | 'failed';
	attempts: number;
	max_retries: number;
	last_error: string | null;
	updated_at: number;
};

const newId = (n: number): string => randomBytes(Math.ceil(n / 2)).toString('hex').slice(0, n);

// Wrap the body BLOB result. node:sqlite returns Uint8Array for BLOB columns; we
// expose Buffer for ergonomic parity with the rest of the Node ecosystem.
const toBuffer = (v: unknown): Buffer => {
	if (Buffer.isBuffer(v)) return v;
	if (v instanceof Uint8Array) return Buffer.from(v);
	if (typeof v === 'string') return Buffer.from(v);
	return Buffer.alloc(0);
};

export class Store {
	private db: DatabaseSync;

	constructor(path: string) {
		this.db = new DatabaseSync(path);
		// node:sqlite supports pragmas via the same prepare/run path.
		this.db.prepare('PRAGMA journal_mode = WAL').run();
		this.db.prepare('PRAGMA foreign_keys = ON').run();
		this.db.prepare('PRAGMA busy_timeout = 5000').run();
		for (const stmt of SCHEMA_STATEMENTS) {
			this.db.prepare(stmt).run();
		}
	}

	close(): void {
		this.db.close();
	}

	createBin(ttlMs: number): Bin {
		const now = Math.floor(Date.now() / 1000);
		const bin: Bin = {
			id: newId(12),
			delete_token: newId(32),
			created_at: now,
			expires_at: now + Math.floor(ttlMs / 1000),
		};
		this.db
			.prepare('INSERT INTO bins(id, delete_token, created_at, expires_at) VALUES(?,?,?,?)')
			.run(bin.id, bin.delete_token, bin.created_at, bin.expires_at);
		return bin;
	}

	getBin(id: string): Bin | null {
		const row = this.db
			.prepare('SELECT * FROM bins WHERE id = ? AND expires_at > ?')
			.get(id, Math.floor(Date.now() / 1000)) as Bin | undefined;
		return row ?? null;
	}

	deleteBin(id: string, token: string): boolean {
		const res = this.db
			.prepare('DELETE FROM bins WHERE id = ? AND delete_token = ?')
			.run(id, token);
		return Number(res.changes) > 0;
	}

	storeRequest(binId: string, method: string, headers: Record<string, string>, body: Buffer): Request {
		const req: Request = {
			id: newId(20),
			bin_id: binId,
			method,
			headers,
			body,
			received_at: Math.floor(Date.now() / 1000),
		};
		// node:sqlite binds BLOB as Uint8Array; Buffer extends Uint8Array but the
		// runtime's instanceof check is sensitive to its backing ArrayBuffer kind.
		// Copying into a fresh Uint8Array sidesteps `cannot be bound` errors.
		const blob = Uint8Array.from(body);
		this.db
			.prepare('INSERT INTO requests(id, bin_id, method, headers, body, received_at) VALUES(?,?,?,?,?,?)')
			.run(req.id, req.bin_id, req.method, JSON.stringify(headers), blob, req.received_at);
		return req;
	}

	listRequests(
		binId: string,
		cursor: string | undefined,
		limit: number,
	): { items: Request[]; nextCursor: string | null } {
		let ts = Number.MAX_SAFE_INTEGER;
		let id = '';
		if (cursor) {
			const idx = cursor.indexOf(':');
			if (idx <= 0) throw new Error('invalid cursor');
			ts = Number(cursor.slice(0, idx));
			id = cursor.slice(idx + 1);
			if (!Number.isFinite(ts)) throw new Error('invalid cursor');
		}
		const rows = this.db
			.prepare(
				`SELECT id, bin_id, method, headers, body, received_at
         FROM requests
         WHERE bin_id = ? AND (received_at < ? OR (received_at = ? AND id < ?))
         ORDER BY received_at DESC, id DESC
         LIMIT ?`,
			)
			.all(binId, ts, ts, id, limit + 1) as Array<{
			id: string;
			bin_id: string;
			method: string;
			headers: string;
			body: unknown;
			received_at: number;
		}>;

		const items: Request[] = rows.map((r) => ({
			id: r.id,
			bin_id: r.bin_id,
			method: r.method,
			headers: JSON.parse(r.headers) as Record<string, string>,
			body: toBuffer(r.body),
			received_at: r.received_at,
		}));

		let nextCursor: string | null = null;
		if (items.length > limit) {
			const last = items[limit - 1]!;
			nextCursor = `${last.received_at}:${last.id}`;
			items.length = limit;
		}
		return { items, nextCursor };
	}

	getRequest(id: string): Request | null {
		const r = this.db
			.prepare('SELECT id, bin_id, method, headers, body, received_at FROM requests WHERE id = ?')
			.get(id) as
			| {
					id: string;
					bin_id: string;
					method: string;
					headers: string;
					body: unknown;
					received_at: number;
			  }
			| undefined;
		if (!r) return null;
		return {
			id: r.id,
			bin_id: r.bin_id,
			method: r.method,
			headers: JSON.parse(r.headers) as Record<string, string>,
			body: toBuffer(r.body),
			received_at: r.received_at,
		};
	}

	createReplay(requestId: string, targetUrl: string, maxRetries: number): Replay {
		const r: Replay = {
			id: newId(20),
			request_id: requestId,
			target_url: targetUrl,
			status: 'queued',
			attempts: 0,
			max_retries: maxRetries,
			last_error: null,
			updated_at: Math.floor(Date.now() / 1000),
		};
		this.db
			.prepare(
				'INSERT INTO replays(id, request_id, target_url, status, attempts, max_retries, updated_at) VALUES(?,?,?,?,?,?,?)',
			)
			.run(r.id, r.request_id, r.target_url, r.status, 0, maxRetries, r.updated_at);
		return r;
	}

	getReplay(id: string): Replay | null {
		const row = this.db.prepare('SELECT * FROM replays WHERE id = ?').get(id) as Replay | undefined;
		return row ?? null;
	}

	updateReplay(id: string, status: Replay['status'], attempts: number, lastError: string | null): void {
		this.db
			.prepare('UPDATE replays SET status = ?, attempts = ?, last_error = ?, updated_at = ? WHERE id = ?')
			.run(status, attempts, lastError, Math.floor(Date.now() / 1000), id);
	}

	sweepExpired(): number {
		const res = this.db
			.prepare('DELETE FROM bins WHERE expires_at <= ?')
			.run(Math.floor(Date.now() / 1000));
		return Number(res.changes);
	}
}
