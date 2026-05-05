/**
 * Verify Instagram's resumable upload API for Reels.
 * No public URL needed — we POST the bytes directly to rupload.facebook.com.
 *
 * Flow:
 *   1. POST /{ig-user-id}/media?media_type=REELS&upload_type=resumable
 *      → returns { id, uri }
 *   2. POST {uri} with Authorization: OAuth, offset, file_size headers + binary body
 *   3. Poll status until FINISHED
 *   4. Publish (skipped here — we just verify upload+process works)
 */
import { readFileSync, writeFileSync, unlinkSync, existsSync } from 'fs';
import { resolve, dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { spawn } from 'child_process';
import { tmpdir } from 'os';
import { createRequire } from 'module';

const __dirname = dirname(fileURLToPath(import.meta.url));
const envContent = readFileSync(resolve(__dirname, '..', '.env'), 'utf-8');
for (const line of envContent.split('\n')) {
	const t = line.trim();
	if (!t || t.startsWith('#')) continue;
	const i = t.indexOf('='); if (i === -1) continue;
	let v = t.slice(i + 1).trim();
	if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
	process.env[t.slice(0, i).trim()] = v;
}

const USER_TOKEN = process.env.USER_ACCESS_TOKEN;
const IG_ACCOUNT = process.env.INSTAGRAM_ACCOUNT_ID;
const FB_PAGE = process.env.FACEBOOK_PAGE_ID;
const VIDEO_URL = process.env.VIDEO_URL;
const API = process.env.GRAPH_API_VERSION || 'v25.0';
const BASE = 'https://graph.facebook.com';

const require = createRequire(import.meta.url);
const ffmpeg = require('ffmpeg-static');

async function gp(path, params, method = 'GET') {
	const url = new URL(`${BASE}/${API}/${path}`);
	for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
	const r = await fetch(url, { method });
	return { status: r.status, body: await r.json() };
}

function spawnAwait(cmd, args) {
	return new Promise((res, rej) => {
		const p = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
		let err = '';
		p.stderr.on('data', (c) => { err += c.toString(); });
		p.on('close', (code) => code === 0 ? res() : rej(new Error(err.slice(-2000))));
	});
}

console.log('Downloading & re-encoding source...');
const dl = await fetch(VIDEO_URL);
const raw = Buffer.from(await dl.arrayBuffer());
const prefix = join(tmpdir(), `resumable_${Date.now()}`);
const tmpIn = `${prefix}_in.mp4`, tmpOut = `${prefix}_out.mp4`;
writeFileSync(tmpIn, raw);
await spawnAwait(ffmpeg, [
	'-i', tmpIn,
	'-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-profile:v', 'high', '-level', '4.0',
	'-crf', '23', '-maxrate', '4500k', '-bufsize', '9000k', '-preset', 'medium',
	'-vf', 'scale=1080:1920:force_original_aspect_ratio=decrease,fps=30',
	'-c:a', 'aac', '-b:a', '128k', '-ac', '2', '-ar', '48000',
	'-movflags', '+faststart', '-map_metadata', '-1',
	'-f', 'mp4', '-y', tmpOut,
]);
const encoded = readFileSync(tmpOut);
try { unlinkSync(tmpIn); unlinkSync(tmpOut); } catch {}
console.log(`Encoded: ${(encoded.length / 1024 / 1024).toFixed(2)} MB (${encoded.length} bytes)\n`);

// Get page token
const pageRes = await gp(FB_PAGE, { fields: 'access_token', access_token: USER_TOKEN });
const PAGE = pageRes.body.access_token;

// Step 1: create resumable container
console.log('Step 1: Creating resumable Reel container...');
const cr = await gp(`${IG_ACCOUNT}/media`, {
	media_type: 'REELS',
	upload_type: 'resumable',
	share_to_feed: 'true',
	caption: 'Resumable upload test',
	access_token: PAGE,
}, 'POST');
console.log(`  Response: ${cr.status} ${JSON.stringify(cr.body)}\n`);
if (!cr.body.id || !cr.body.uri) {
	console.error('Container creation failed — no id/uri returned');
	process.exit(1);
}

// Step 2: upload bytes
console.log(`Step 2: POSTing ${encoded.length} bytes to ${cr.body.uri}...`);
const uploadRes = await fetch(cr.body.uri, {
	method: 'POST',
	headers: {
		'Authorization': `OAuth ${PAGE}`,
		'offset': '0',
		'file_size': encoded.length.toString(),
		'Content-Type': 'application/octet-stream',
	},
	body: encoded,
});
const uploadBody = await uploadRes.text();
console.log(`  Upload response: ${uploadRes.status} ${uploadBody}\n`);

// Step 3: poll status
console.log('Step 3: Polling container status...');
let finalStatus = null;
for (let i = 1; i <= 30; i++) {
	await new Promise(r => setTimeout(r, 6000));
	const s = await gp(cr.body.id, { fields: 'status_code,status', access_token: PAGE });
	console.log(`  Poll ${i}: ${s.body.status_code} ${s.body.status || ''}`);
	if (s.body.status_code === 'FINISHED') { finalStatus = 'FINISHED'; break; }
	if (s.body.status_code === 'ERROR' || s.body.status_code === 'EXPIRED') { finalStatus = s.body.status_code; break; }
}

if (finalStatus === 'FINISHED') {
	console.log('\n✅ RESUMABLE UPLOAD WORKS — container is ready to publish.');
	console.log('   (Skipping publish to avoid creating a real post.)');
} else {
	console.log(`\n❌ Upload pipeline failed: ${finalStatus}`);
}
