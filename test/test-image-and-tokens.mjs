/**
 * Two diagnostics to narrow the 2207076 cause:
 *   A) Post an IMAGE Reel container to the same IG account.
 *      If that works → issue is video-specific (encoder/transport).
 *      If that fails → issue is account-wide.
 *   B) Repeat the video container with the PAGE access token instead of
 *      the SYSTEM_USER token (sometimes IG publishing prefers page tokens).
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
const FB_PAGE = process.env.FACEBOOK_PAGE_ID;
const API = process.env.GRAPH_API_VERSION || 'v25.0';
const BASE = 'https://graph.facebook.com';

async function gp(path, params, method = 'GET') {
	const url = new URL(`${BASE}/${API}/${path}`);
	for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
	const r = await fetch(url, { method });
	return { status: r.status, body: await r.json() };
}

async function pollContainer(containerId, token, label) {
	for (let i = 1; i <= 12; i++) {
		await new Promise(r => setTimeout(r, 5000));
		const s = await gp(containerId, { fields: 'status_code,status', access_token: token });
		console.log(`   [${label}] poll ${i}: ${s.body.status_code} ${s.body.status || ''}`);
		if (s.body.status_code === 'FINISHED') return 'FINISHED';
		if (s.body.status_code === 'ERROR' || s.body.status_code === 'EXPIRED') return s.body.status_code;
	}
	return 'TIMEOUT';
}

// Get page access token
console.log('Getting page access token...');
const pageRes = await gp(FB_PAGE, { fields: 'access_token', access_token: USER_TOKEN });
const PAGE_TOKEN = pageRes.body.access_token;
if (!PAGE_TOKEN) { console.error('No page token'); process.exit(1); }
console.log(`Got page token: ${PAGE_TOKEN.slice(0, 20)}...\n`);

// === A) Try IMAGE ===
console.log('=== A) Post IMAGE container (same account) ===');
const IMAGE_URL = 'https://upload.wikimedia.org/wikipedia/commons/thumb/4/47/PNG_transparency_demonstration_1.png/280px-PNG_transparency_demonstration_1.png';
const imgRes = await gp(`${IG_ACCOUNT}/media`, {
	image_url: IMAGE_URL,
	caption: 'Image diag - will not be published',
	access_token: USER_TOKEN,
}, 'POST');
console.log(`Image container: ${imgRes.status} ${JSON.stringify(imgRes.body)}`);
if (imgRes.body.id) {
	const result = await pollContainer(imgRes.body.id, USER_TOKEN, 'IMG-USER');
	console.log(`Image (user token) result: ${result}\n`);
}

// === B) Video with page token ===
console.log('=== B) Post VIDEO container with PAGE token ===');
const VIDEO_URL = 'https://download.samplelib.com/mp4/sample-5s.mp4';
const vidRes = await gp(`${IG_ACCOUNT}/media`, {
	video_url: VIDEO_URL,
	media_type: 'REELS',
	share_to_feed: 'true',
	caption: 'Video diag with page token',
	access_token: PAGE_TOKEN,
}, 'POST');
console.log(`Video (page token) container: ${vidRes.status} ${JSON.stringify(vidRes.body)}`);
if (vidRes.body.id) {
	const result = await pollContainer(vidRes.body.id, PAGE_TOKEN, 'VID-PAGE');
	console.log(`Video (page token) result: ${result}\n`);
}
