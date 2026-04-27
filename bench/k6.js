// Polyhook bench — k6 script.
// Run with: k6 run -e BASE_URL=https://polyhook-go.up.railway.app bench/k6.js
// (Identical script committed to polyhook-node — pass BASE_URL to point at either.)

import http from 'k6/http';
import { check, sleep } from 'k6';
import { Trend, Counter } from 'k6/metrics';

const BASE = __ENV.BASE_URL || 'http://localhost:8080';
const SUSTAIN_RPS = Number(__ENV.RPS || 200);

const ingestLatency = new Trend('ingest_latency_ms', true);
const listLatency = new Trend('list_latency_ms', true);
const ingestErrors = new Counter('ingest_errors');

export const options = {
	scenarios: {
		ingest: {
			executor: 'constant-arrival-rate',
			rate: SUSTAIN_RPS,
			timeUnit: '1s',
			duration: '60s',
			preAllocatedVUs: 50,
			maxVUs: 200,
			exec: 'ingest',
		},
		list: {
			executor: 'constant-arrival-rate',
			rate: 20,
			timeUnit: '1s',
			duration: '60s',
			preAllocatedVUs: 5,
			maxVUs: 20,
			exec: 'list',
			startTime: '5s', // let some bins exist first
		},
	},
	thresholds: {
		'ingest_latency_ms': ['p(99)<500'],
		'http_req_failed{scenario:ingest}': ['rate<0.01'],
	},
};

// Single bin per VU iteration is too churn-heavy; create a small pool up front.
const POOL_SIZE = 10;
let pool = [];

export function setup() {
	const bins = [];
	for (let i = 0; i < POOL_SIZE; i++) {
		const r = http.post(`${BASE}/v1/bins`);
		if (r.status === 201) bins.push(JSON.parse(r.body).id);
	}
	if (bins.length === 0) throw new Error('failed to create any bins');
	return { bins };
}

const PAYLOAD = JSON.stringify({
	event: 'order.created',
	id: 'evt_bench_xxxxx',
	data: { amount: 4200, currency: 'usd' },
});

export function ingest(data) {
	const id = data.bins[Math.floor(Math.random() * data.bins.length)];
	const r = http.post(`${BASE}/v1/bins/${id}/in`, PAYLOAD, {
		headers: { 'Content-Type': 'application/json' },
		tags: { scenario: 'ingest' },
	});
	ingestLatency.add(r.timings.duration);
	const ok = check(r, { 'ingest 202': (res) => res.status === 202 });
	if (!ok) ingestErrors.add(1);
}

export function list(data) {
	const id = data.bins[Math.floor(Math.random() * data.bins.length)];
	const r = http.get(`${BASE}/v1/bins/${id}/requests?limit=20`, {
		tags: { scenario: 'list' },
	});
	listLatency.add(r.timings.duration);
	check(r, { 'list 200': (res) => res.status === 200 });
}

export function teardown(data) {
	// Bins auto-expire in 24h; leaving them is fine for repeat-runs.
}
