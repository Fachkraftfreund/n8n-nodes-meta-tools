/**
 * Integration test: video posting via Cloudflare Tunnel.
 *
 * Downloads a video, re-encodes it with ffmpeg, serves it via a local HTTP
 * server tunneled through cloudflared (no interstitial, unlike ngrok free tier),
 * then posts it to Instagram (Reel) and Facebook (Video).
 * Cleans up created posts when done.
 *
 * Usage:  node test/test-video.mjs            # full test with tunnel
 *         node test/test-video.mjs --direct    # test with original VIDEO_URL only
 *
 * Requires: .env in project root, cloudflared on PATH
 */

import { readFileSync, writeFileSync, unlinkSync, existsSync } from 'fs';
import { resolve, dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { createServer } from 'http';
import { spawn } from 'child_process';
import { randomUUID } from 'crypto';
import { tmpdir } from 'os';
import { createRequire } from 'module';

const __dirname = dirname(fileURLToPath(import.meta.url));
const envPath = resolve(__dirname, '..', '.env');

// ── Load .env manually ──────────────────────────────────────────
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

// ── Config ──────────────────────────────────────────────────────
const USER_TOKEN = process.env.USER_ACCESS_TOKEN;
const IG_ACCOUNT = process.env.INSTAGRAM_ACCOUNT_ID;
const FB_PAGE    = process.env.FACEBOOK_PAGE_ID;
const VIDEO_URL  = process.env.VIDEO_URL;
const CAPTION    = process.env.CAPTION || 'Video test – will be deleted';
const API        = process.env.GRAPH_API_VERSION || 'v23.0';
const BASE       = 'https://graph.facebook.com';
const SERVE_PORT = 5680;

if (!USER_TOKEN || !IG_ACCOUNT || !FB_PAGE || !VIDEO_URL) {
	console.error('Missing required .env values (USER_ACCESS_TOKEN, INSTAGRAM_ACCOUNT_ID, FACEBOOK_PAGE_ID, VIDEO_URL).');
	process.exit(1);
}

// IDs for cleanup
const cleanup = { igPostId: null, fbVideoId: null };

// ── Graph API Helpers ───────────────────────────────────────────
async function graphGet(path, params) {
	const url = new URL(`${BASE}/${API}/${path}`);
	for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
	const res = await fetch(url);
	const body = await res.json();
	return { status: res.status, body };
}

async function graphPost(path, params) {
	const url = new URL(`${BASE}/${API}/${path}`);
	for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
	const res = await fetch(url, { method: 'POST' });
	const body = await res.json();
	return { status: res.status, body };
}

async function graphDelete(path, token) {
	const url = new URL(`${BASE}/${API}/${path}`);
	url.searchParams.set('access_token', token);
	const res = await fetch(url, { method: 'DELETE' });
	const body = await res.json();
	return { status: res.status, body };
}

function step(name) {
	console.log(`\n${'─'.repeat(60)}\n🔹 ${name}\n${'─'.repeat(60)}`);
}

function ok(label, data) {
	console.log(`   ✅ ${label}:`, JSON.stringify(data, null, 2));
}

function fail(label, data) {
	console.log(`   ❌ ${label}:`, JSON.stringify(data, null, 2));
}

// ── FFmpeg Helpers ──────────────────────────────────────────────

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
	console.log('   Re-encoding video with ffmpeg…');
	const prefix = join(tmpdir(), `metapost_test_${Date.now()}_${Math.random().toString(36).slice(2)}`);
	const tmpIn  = `${prefix}_in.mp4`;
	const tmpOut = `${prefix}_out.mp4`;

	writeFileSync(tmpIn, inputBuffer);

	const ffmpeg = getFfmpegPath();
	const args = [
		'-i', tmpIn,
		'-c:v', 'libx264',
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

	await new Promise((resolve, reject) => {
		const proc = spawn(ffmpeg, args, { stdio: ['ignore', 'pipe', 'pipe'] });
		let stderr = '';
		proc.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
		proc.on('close', (code) => {
			if (code === 0) resolve();
			else reject(new Error(`ffmpeg exited with code ${code}: ${stderr}`));
		});
		proc.on('error', (err) => reject(new Error(`Failed to spawn ffmpeg: ${err.message}`)));
	});

	const output = readFileSync(tmpOut);
	console.log(`   Re-encoded: ${(output.length / 1024 / 1024).toFixed(1)} MB`);

	for (const f of [tmpIn, tmpOut]) {
		try { if (existsSync(f)) unlinkSync(f); } catch { /* ignore */ }
	}

	return output;
}

// ── Temp Video Server ──────────────────────────────────────────

function parseRange(header, total) {
	const match = header.match(/^bytes=(\d+)-(\d*)$/);
	if (!match) return null;
	const start = parseInt(match[1], 10);
	const end = match[2] ? parseInt(match[2], 10) : total - 1;
	if (start > end || start >= total) return null;
	return { start, end: Math.min(end, total - 1) };
}

function startTempServer(buffer, port) {
	return new Promise((resolve, reject) => {
		const id = randomUUID();
		const servePath = `/${id}.mp4`;
		const total = buffer.length;

		const server = createServer((req, res) => {
			console.log(`   [server] ${req.method} ${req.url} (Range: ${req.headers['range'] || 'none'})`);

			if (req.url !== servePath || (req.method !== 'GET' && req.method !== 'HEAD')) {
				res.writeHead(404);
				res.end();
				return;
			}

			if (req.method === 'HEAD') {
				res.writeHead(200, {
					'Content-Type': 'video/mp4',
					'Content-Length': total.toString(),
					'Accept-Ranges': 'bytes',
					'Connection': 'keep-alive',
				});
				res.end();
				return;
			}

			const rangeHeader = req.headers['range'];
			if (rangeHeader) {
				const range = parseRange(rangeHeader, total);
				if (!range) {
					res.writeHead(416, { 'Content-Range': `bytes */${total}` });
					res.end();
					return;
				}
				const { start, end } = range;
				res.writeHead(206, {
					'Content-Type': 'video/mp4',
					'Content-Range': `bytes ${start}-${end}/${total}`,
					'Content-Length': (end - start + 1).toString(),
					'Accept-Ranges': 'bytes',
					'Connection': 'keep-alive',
				});
				res.end(buffer.subarray(start, end + 1));
			} else {
				res.writeHead(200, {
					'Content-Type': 'video/mp4',
					'Content-Length': total.toString(),
					'Accept-Ranges': 'bytes',
					'Connection': 'keep-alive',
				});
				res.end(buffer);
			}
		});

		server.on('error', reject);
		server.listen(port, '0.0.0.0', () => {
			resolve({ servePath, server });
		});
	});
}

// ── Cloudflare Tunnel ──────────────────────────────────────────

function startCloudflaredTunnel(port) {
	return new Promise((resolve, reject) => {
		const proc = spawn('cloudflared', ['tunnel', '--url', `http://localhost:${port}`], {
			stdio: ['ignore', 'pipe', 'pipe'],
		});

		let resolved = false;
		let stderr = '';

		// cloudflared prints the public URL to stderr
		proc.stderr.on('data', (chunk) => {
			const text = chunk.toString();
			stderr += text;

			// Look for the tunnel URL in cloudflared output
			const match = text.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/);
			if (match && !resolved) {
				resolved = true;
				resolve({
					url: match[0],
					process: proc,
					close: () => new Promise((res) => {
						proc.on('exit', () => res());
						proc.kill('SIGTERM');
						setTimeout(() => { try { proc.kill('SIGKILL'); } catch {} res(); }, 3000);
					}),
				});
			}
		});

		proc.on('error', (err) => {
			if (!resolved) reject(new Error(`Failed to start cloudflared: ${err.message}`));
		});

		proc.on('exit', (code) => {
			if (!resolved) reject(new Error(`cloudflared exited with code ${code} before establishing tunnel.\n${stderr}`));
		});

		// Timeout after 30 seconds
		setTimeout(() => {
			if (!resolved) {
				proc.kill();
				reject(new Error(`cloudflared timed out (30s). Output:\n${stderr}`));
			}
		}, 30_000);
	});
}

// ── Main ────────────────────────────────────────────────────────

let tunnel = null;
let httpServer = null;

async function run() {
	let pageAccessToken;

	// ── 1. Download & Re-encode Video ────────────────────────────
	step('1. Download & Re-encode Video');
	const rawVideo = await downloadVideo(VIDEO_URL);
	const videoBuffer = await reencodeVideo(rawVideo);

	// ── 2. Start Local Server + Cloudflare Tunnel ────────────────
	step('2. Start Local HTTP Server + Cloudflare Tunnel');
	const { servePath, server } = await startTempServer(videoBuffer, SERVE_PORT);
	httpServer = server;
	console.log(`   Local server listening on port ${SERVE_PORT}, path: ${servePath}`);

	console.log('   Starting cloudflared tunnel (this may take a few seconds)…');
	tunnel = await startCloudflaredTunnel(SERVE_PORT);
	const videoPublicUrl = `${tunnel.url}${servePath}`;
	ok('Cloudflare tunnel', { tunnelUrl: tunnel.url, videoPublicUrl });

	// Quick self-test (retry a few times — DNS propagation may take a moment)
	console.log('   Verifying tunnel (waiting for DNS propagation)…');
	for (let attempt = 1; attempt <= 10; attempt++) {
		try {
			const headRes = await fetch(videoPublicUrl, { method: 'HEAD' });
			if (headRes.ok) {
				ok('Tunnel self-test', { status: headRes.status, contentLength: headRes.headers.get('content-length') });
				break;
			}
			console.log(`   Attempt ${attempt}/10: HTTP ${headRes.status}, retrying…`);
		} catch (err) {
			console.log(`   Attempt ${attempt}/10: ${err.cause?.code || err.message}, retrying…`);
		}
		if (attempt === 10) {
			fail('Tunnel self-test failed after 10 attempts', {});
			return;
		}
		await new Promise(r => setTimeout(r, 3000));
	}

	// ── 3. Get Page Access Token ─────────────────────────────────
	step('3. Get Page Access Token');
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

	// ── 4. Create Instagram Reel Container ───────────────────────
	step('4. Create Instagram Reel Container');
	let igContainerId;
	{
		const r = await graphPost(`${IG_ACCOUNT}/media`, {
			video_url: videoPublicUrl,
			media_type: 'REELS',
			share_to_feed: 'true',
			caption: CAPTION,
			access_token: USER_TOKEN,
		});
		console.log('   Response:', r.status, JSON.stringify(r.body, null, 2));

		if (r.status >= 200 && r.status < 300 && r.body.id) {
			igContainerId = r.body.id;
			ok('Container created', { id: igContainerId });
		} else {
			fail('Container creation failed', r);
			return;
		}
	}

	// ── 5. Poll Container Status ─────────────────────────────────
	step('5. Poll Container Status (up to 5 minutes)');
	{
		const maxPolls = 30;
		const pollInterval = 10_000;
		for (let i = 1; i <= maxPolls; i++) {
			const r = await graphGet(igContainerId, {
				fields: 'status_code,status',
				access_token: USER_TOKEN,
			});
			const status = r.body.status_code;
			console.log(`   Poll ${i}/${maxPolls}: ${status} ${r.body.status || ''}`);

			if (status === 'FINISHED') {
				ok('Container ready', r.body);
				break;
			} else if (status === 'ERROR' || status === 'EXPIRED') {
				fail('Container processing failed', r.body);
				return;
			}

			if (i === maxPolls) {
				fail('Timed out waiting for container', r.body);
				return;
			}
			await new Promise(r => setTimeout(r, pollInterval));
		}
	}

	// ── 6. Publish Instagram Reel ────────────────────────────────
	step('6. Publish Instagram Reel (with retry, up to 5 attempts)');
	let igPostId;
	{
		for (let attempt = 1; attempt <= 5; attempt++) {
			console.log(`   Attempt ${attempt}/5…`);
			const r = await graphPost(`${IG_ACCOUNT}/media_publish`, {
				creation_id: igContainerId,
				access_token: USER_TOKEN,
			});
			if (r.status >= 200 && r.status < 300 && r.body.id) {
				igPostId = r.body.id;
				cleanup.igPostId = igPostId;
				ok('Published', { id: igPostId });
				break;
			} else {
				console.log(`   Attempt ${attempt} failed (${r.status}): ${r.body?.error?.message || JSON.stringify(r.body)}`);
				if (attempt < 5) {
					const delay = attempt * 2000;
					console.log(`   Waiting ${delay / 1000}s before retry…`);
					await new Promise(r => setTimeout(r, delay));
				} else {
					fail('Publish failed after 5 attempts', r);
					return;
				}
			}
		}
	}

	// ── 7. Get Instagram Permalink ───────────────────────────────
	step('7. Get Instagram Permalink');
	{
		const r = await graphGet(igPostId, { fields: 'permalink', access_token: USER_TOKEN });
		if (r.status === 200) {
			ok('Permalink', r.body);
		} else {
			fail('Get permalink', r);
		}
	}

	// ── 8. Upload Video to Facebook ──────────────────────────────
	step('8. Upload Video to Facebook');
	{
		console.log('   Uploading video buffer to Facebook…');
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
	console.log('\n' + '═'.repeat(60));
	console.log('🧹 Cleaning up…\n');

	const ptr = await graphGet(FB_PAGE, { fields: 'access_token', access_token: USER_TOKEN });
	const pageToken = ptr.body?.access_token || USER_TOKEN;

	if (cleanup.fbVideoId) {
		const r = await graphDelete(cleanup.fbVideoId, pageToken);
		console.log(`   FB video ${cleanup.fbVideoId}: ${r.body.success ? 'deleted ✅' : 'failed ❌ ' + JSON.stringify(r.body)}`);
	}

	if (cleanup.igPostId) {
		const r = await graphDelete(cleanup.igPostId, USER_TOKEN);
		console.log(`   IG post ${cleanup.igPostId}: ${r.body.success ? 'deleted ✅' : 'failed ❌ ' + JSON.stringify(r.body)}`);
	}

	console.log('🧹 Cleanup done.');
}

async function shutdown() {
	if (tunnel) {
		console.log('\n   Closing cloudflared tunnel…');
		try { await tunnel.close(); } catch { /* ignore */ }
	}
	if (httpServer) {
		console.log('   Stopping local server…');
		httpServer.close();
	}
}

// ── Quick direct-URL test (no tunnel, no re-encode) ─────────
async function runDirect() {
	step('DIRECT TEST: Create IG Reel Container with original VIDEO_URL');
	const r = await graphPost(`${IG_ACCOUNT}/media`, {
		video_url: VIDEO_URL,
		media_type: 'REELS',
		share_to_feed: 'true',
		caption: CAPTION + ' (direct URL test)',
		access_token: USER_TOKEN,
	});
	console.log('   Response:', r.status, JSON.stringify(r.body, null, 2));
	if (!(r.status >= 200 && r.status < 300 && r.body.id)) {
		fail('Container creation', r);
		return;
	}
	const containerId = r.body.id;
	ok('Container created', { id: containerId });

	step('DIRECT TEST: Poll Container Status');
	for (let i = 1; i <= 30; i++) {
		const s = await graphGet(containerId, { fields: 'status_code,status', access_token: USER_TOKEN });
		console.log(`   Poll ${i}/30: ${s.body.status_code} ${s.body.status || ''}`);
		if (s.body.status_code === 'FINISHED') { ok('Container ready', s.body); break; }
		if (s.body.status_code === 'ERROR' || s.body.status_code === 'EXPIRED') {
			fail('Container failed', s.body);
			return;
		}
		if (i === 30) { fail('Timeout', s.body); return; }
		await new Promise(r => setTimeout(r, 10_000));
	}
}

// ── Entry Point ─────────────────────────────────────────────────
const mode = process.argv[2];
if (mode === '--direct') {
	await runDirect();
} else {
	try {
		await run();
	} finally {
		await deleteCreated();
		await shutdown();
	}
}
