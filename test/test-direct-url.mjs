/**
 * Upload an already-public mp4 directly to IG (no local serving, no re-encode).
 * If this works → our local tunnel is the issue.
 * If this fails too → Instagram's container processing is failing for a deeper reason.
 */
import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const envContent = readFileSync(resolve(__dirname, '..', '.env'), 'utf-8');
for (const line of envContent.split('\n')) {
	const t = line.trim();
	if (!t || t.startsWith('#')) continue;
	const i = t.indexOf('='); if (i === -1) continue;
	process.env[t.slice(0, i).trim()] = t.slice(i + 1).trim();
}

const USER_TOKEN = process.env.USER_ACCESS_TOKEN;
const IG_ACCOUNT = process.env.INSTAGRAM_ACCOUNT_ID;
const API = process.env.GRAPH_API_VERSION || 'v25.0';
const BASE = 'https://graph.facebook.com';

// Public 9:16 sample — used to test if IG can fetch from a non-cloudflare host
// Using a known stable URL: samplelib has 1920x1080 (16:9) which IG should still accept
const TEST_URL = 'https://download.samplelib.com/mp4/sample-5s.mp4';

async function gp(path, params, method = 'GET') {
	const url = new URL(`${BASE}/${API}/${path}`);
	for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
	const r = await fetch(url, { method });
	return { status: r.status, body: await r.json() };
}

console.log(`Posting ${TEST_URL} as IG Reel container...`);
const cr = await gp(`${IG_ACCOUNT}/media`, {
	video_url: TEST_URL, media_type: 'REELS', share_to_feed: 'true',
	caption: 'Direct URL test', access_token: USER_TOKEN,
}, 'POST');
console.log(`Container: ${cr.status} ${JSON.stringify(cr.body)}`);
if (!cr.body.id) process.exit(1);

for (let i = 1; i <= 30; i++) {
	await new Promise(r => setTimeout(r, 8000));
	const s = await gp(cr.body.id, { fields: 'status_code,status', access_token: USER_TOKEN });
	console.log(`Poll ${i}: ${s.body.status_code} ${s.body.status || ''}`);
	if (s.body.status_code === 'FINISHED') {
		console.log('\n✅ FINISHED — IG accepted samplelib.com URL.');
		// Don't publish — just verifying fetch works
		break;
	}
	if (s.body.status_code === 'ERROR' || s.body.status_code === 'EXPIRED') {
		console.log('\n❌ FAILED on a known-public URL — IG rejection is independent of our hosting.');
		break;
	}
}
