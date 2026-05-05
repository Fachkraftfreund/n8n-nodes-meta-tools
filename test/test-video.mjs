/**
 * Integration test: post a real Instagram Reel + Facebook Video using
 * the resumable upload flow (no public URL needed — same flow as the
 * production node). Cleans up created posts when done.
 *
 * Usage:  node test/test-video.mjs
 *         node test/test-video.mjs --keep   # don't delete on success
 *
 * Requires: .env in project root with USER_ACCESS_TOKEN, INSTAGRAM_ACCOUNT_ID,
 * FACEBOOK_PAGE_ID, VIDEO_URL.
 */

import { readFileSync, writeFileSync, unlinkSync, existsSync } from 'fs';
import { resolve, dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { spawn } from 'child_process';
import { tmpdir } from 'os';
import { createRequire } from 'module';

const __dirname = dirname(fileURLToPath(import.meta.url));
const envPath = resolve(__dirname, '..', '.env');

// ── Load .env ─────────────────────────────────────────────────
const envContent = readFileSync(envPath, 'utf-8');
for (const line of envContent.split('\n')) {
	const trimmed = line.trim();
	if (!trimmed || trimmed.startsWith('#')) continue;
	const idx = trimmed.indexOf('=');
	if (idx === -1) continue;
	const key = trimmed.slice(0, idx).trim();
	let val = trimmed.slice(idx + 1).trim();
	if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
		val = val.slice(1, -1);
	}
	if (!process.env[key]) process.env[key] = val;
}

const USER_TOKEN = process.env.USER_ACCESS_TOKEN;
const IG_ACCOUNT = process.env.INSTAGRAM_ACCOUNT_ID;
const FB_PAGE    = process.env.FACEBOOK_PAGE_ID;
const VIDEO_URL  = process.env.VIDEO_URL;
const CAPTION    = process.env.CAPTION || 'Video test – will be deleted';
const API        = process.env.GRAPH_API_VERSION || 'v25.0';
const BASE       = 'https://graph.facebook.com';
const KEEP       = process.argv.includes('--keep');

if (!USER_TOKEN || !IG_ACCOUNT || !FB_PAGE || !VIDEO_URL) {
	console.error('Missing required .env values (USER_ACCESS_TOKEN, INSTAGRAM_ACCOUNT_ID, FACEBOOK_PAGE_ID, VIDEO_URL).');
	process.exit(1);
}

const cleanup = { igPostId: null, fbVideoId: null };

// ── Graph API Helpers ───────────────────────────────────────────
async function graphGet(path, params) {
	const url = new URL(`${BASE}/${API}/${path}`);
	for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
	const res = await fetch(url);
	return { status: res.status, body: await res.json() };
}
async function graphPost(path, params) {
	const url = new URL(`${BASE}/${API}/${path}`);
	for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
	const res = await fetch(url, { method: 'POST' });
	return { status: res.status, body: await res.json() };
}
async function graphDelete(path, token) {
	const url = new URL(`${BASE}/${API}/${path}`);
	url.searchParams.set('access_token', token);
	const res = await fetch(url, { method: 'DELETE' });
	return { status: res.status, body: await res.json() };
}

function step(name) { console.log(`\n${'─'.repeat(60)}\n🔹 ${name}\n${'─'.repeat(60)}`); }
function ok(label, data) { console.log(`   ✅ ${label}:`, JSON.stringify(data, null, 2)); }
function fail(label, data) { console.log(`   ❌ ${label}:`, JSON.stringify(data, null, 2)); }

// ── FFmpeg ──────────────────────────────────────────────────────
function getFfmpegPath() {
	try {
		const require = createRequire(import.meta.url);
		const p = require('ffmpeg-static');
		if (p && existsSync(p)) return p;
	} catch { /* ignore */ }
	return 'ffmpeg';
}

async function downloadVideo(url) {
	console.log('   Downloading video…');
	const res = await fetch(url);
	if (!res.ok) throw new Error(`Download failed: ${res.status} ${res.statusText}`);
	const buf = Buffer.from(await res.arrayBuffer());
	console.log(`   Downloaded ${(buf.length / 1024 / 1024).toFixed(1)} MB`);
	return buf;
}

async function reencodeVideo(inputBuffer) {
	console.log('   Re-encoding video with ffmpeg (production args)…');
	const prefix = join(tmpdir(), `metapost_test_${Date.now()}_${Math.random().toString(36).slice(2)}`);
	const tmpIn = `${prefix}_in.mp4`;
	const tmpOut = `${prefix}_out.mp4`;
	writeFileSync(tmpIn, inputBuffer);

	// Mirror nodes/MetaPost/utils/ffmpeg.ts convertVideo()
	const args = [
		'-i', tmpIn,
		'-c:v', 'libx264',
		'-pix_fmt', 'yuv420p',
		'-profile:v', 'high',
		'-level', '4.0',
		'-crf', '23',
		'-maxrate', '4500k',
		'-bufsize', '9000k',
		'-preset', 'medium',
		'-vf', 'scale=1080:1920:force_original_aspect_ratio=decrease,fps=30',
		'-c:a', 'aac',
		'-b:a', '128k',
		'-ac', '2',
		'-ar', '48000',
		'-movflags', '+faststart',
		'-map_metadata', '-1',
		'-f', 'mp4',
		'-y',
		tmpOut,
	];

	await new Promise((res, rej) => {
		const proc = spawn(getFfmpegPath(), args, { stdio: ['ignore', 'pipe', 'pipe'] });
		let stderr = '';
		proc.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
		proc.on('close', (code) => code === 0 ? res() : rej(new Error(`ffmpeg exited with code ${code}: ${stderr}`)));
		proc.on('error', (err) => rej(new Error(`Failed to spawn ffmpeg: ${err.message}`)));
	});

	const output = readFileSync(tmpOut);
	console.log(`   Re-encoded: ${(output.length / 1024 / 1024).toFixed(1)} MB`);
	for (const f of [tmpIn, tmpOut]) {
		try { if (existsSync(f)) unlinkSync(f); } catch { /* ignore */ }
	}
	return output;
}

// ── Main ────────────────────────────────────────────────────────
async function run() {
	let pageAccessToken;

	step('1. Download & Re-encode Video');
	const rawVideo = await downloadVideo(VIDEO_URL);
	const videoBuffer = await reencodeVideo(rawVideo);

	step('2. Get Page Access Token');
	{
		const r = await graphGet(FB_PAGE, { fields: 'access_token', access_token: USER_TOKEN });
		if (r.status === 200 && r.body.access_token) {
			pageAccessToken = r.body.access_token;
			ok('Page token obtained', { id: r.body.id, token: pageAccessToken.slice(0, 20) + '…' });
		} else {
			fail('Get page token', r);
			return;
		}
	}

	step('3. Create Resumable IG Reel Container');
	let igContainerId;
	let uploadUri;
	{
		const r = await graphPost(`${IG_ACCOUNT}/media`, {
			media_type: 'REELS',
			upload_type: 'resumable',
			share_to_feed: 'true',
			caption: CAPTION,
			access_token: pageAccessToken,
		});
		console.log('   Response:', r.status, JSON.stringify(r.body, null, 2));
		if (!(r.status >= 200 && r.status < 300 && r.body.id && r.body.uri)) {
			fail('Container creation', r);
			return;
		}
		igContainerId = r.body.id;
		uploadUri = r.body.uri;
		ok('Container created', { id: igContainerId, uri: uploadUri });
	}

	step('4. Upload Video Bytes to Instagram');
	{
		const uploadRes = await fetch(uploadUri, {
			method: 'POST',
			headers: {
				'Authorization': `OAuth ${pageAccessToken}`,
				'offset': '0',
				'file_size': videoBuffer.length.toString(),
				'Content-Type': 'application/octet-stream',
			},
			body: videoBuffer,
		});
		const body = await uploadRes.text();
		console.log(`   Response: ${uploadRes.status} ${body}`);
		if (!uploadRes.ok) { fail('Upload bytes', { status: uploadRes.status, body }); return; }
		ok('Bytes uploaded', { bytes: videoBuffer.length });
	}

	step('5. Poll Container Status (up to 5 minutes)');
	{
		const maxPolls = 30;
		const pollInterval = 10_000;
		for (let i = 1; i <= maxPolls; i++) {
			const r = await graphGet(igContainerId, { fields: 'status_code,status', access_token: pageAccessToken });
			console.log(`   Poll ${i}/${maxPolls}: ${r.body.status_code} ${r.body.status || ''}`);
			if (r.body.status_code === 'FINISHED') { ok('Container ready', r.body); break; }
			if (r.body.status_code === 'ERROR' || r.body.status_code === 'EXPIRED') {
				fail('Container processing failed', r.body);
				return;
			}
			if (i === maxPolls) { fail('Timed out', r.body); return; }
			await new Promise(r => setTimeout(r, pollInterval));
		}
	}

	step('6. Publish Instagram Reel (with retry)');
	let igPostId;
	{
		for (let attempt = 1; attempt <= 5; attempt++) {
			console.log(`   Attempt ${attempt}/5…`);
			const r = await graphPost(`${IG_ACCOUNT}/media_publish`, {
				creation_id: igContainerId,
				access_token: pageAccessToken,
			});
			if (r.status >= 200 && r.status < 300 && r.body.id) {
				igPostId = r.body.id;
				cleanup.igPostId = igPostId;
				ok('Published', { id: igPostId });
				break;
			}
			console.log(`   Attempt ${attempt} failed (${r.status}): ${r.body?.error?.message || JSON.stringify(r.body)}`);
			if (attempt < 5) await new Promise(r => setTimeout(r, attempt * 2000));
			else { fail('Publish failed', r); return; }
		}
	}

	step('7. Get Instagram Permalink');
	{
		const r = await graphGet(igPostId, { fields: 'permalink', access_token: pageAccessToken });
		if (r.status === 200) ok('Permalink', r.body);
		else fail('Get permalink', r);
	}

	step('8. Upload Video to Facebook');
	{
		const fd = new FormData();
		fd.append('source', new Blob([videoBuffer], { type: 'video/mp4' }), 'video.mp4');
		fd.append('description', CAPTION);
		fd.append('published', 'true');
		fd.append('access_token', pageAccessToken);

		const url = `${BASE}/${API}/${FB_PAGE}/videos`;
		const res = await fetch(url, { method: 'POST', body: fd });
		const body = await res.json();
		if (res.status >= 200 && res.status < 300 && body.id) {
			cleanup.fbVideoId = body.id;
			ok('Facebook video uploaded', { id: body.id });
		} else {
			fail('Facebook video upload', { status: res.status, body });
		}
	}

	console.log('\n' + '═'.repeat(60));
	console.log('✅ All steps completed. Created IDs:', cleanup);
}

async function deleteCreated() {
	if (KEEP) {
		console.log('\n🗒  --keep specified, leaving posts in place:', cleanup);
		return;
	}
	console.log('\n' + '═'.repeat(60));
	console.log('🧹 Cleaning up…\n');

	const ptr = await graphGet(FB_PAGE, { fields: 'access_token', access_token: USER_TOKEN });
	const pageToken = ptr.body?.access_token || USER_TOKEN;

	if (cleanup.fbVideoId) {
		const r = await graphDelete(cleanup.fbVideoId, pageToken);
		console.log(`   FB video ${cleanup.fbVideoId}: ${r.body.success ? 'deleted ✅' : 'failed ❌ ' + JSON.stringify(r.body)}`);
	}
	if (cleanup.igPostId) {
		// Note: Meta's Graph API does not support deleting published Instagram posts —
		// even with a page token, DELETE returns "(#10) Insufficient permissions". The
		// posted Reel must be deleted manually via the Instagram app / web UI.
		const ptr2 = await graphGet(cleanup.igPostId, { fields: 'permalink', access_token: USER_TOKEN });
		const permalink = ptr2.body?.permalink || '(unknown)';
		console.log(`   ⚠ IG post ${cleanup.igPostId} cannot be deleted via API.`);
		console.log(`     Open ${permalink} in Instagram and delete it manually.`);
	}
	console.log('🧹 Cleanup done.');
}

try {
	await run();
} finally {
	await deleteCreated();
}
