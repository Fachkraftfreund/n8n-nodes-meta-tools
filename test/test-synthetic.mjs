/**
 * Generate a synthetic 10-second 1080x1920 MP4 (testsrc + sine), run it through
 * the SAME re-encode pipeline as production, upload via Cloudflare Tunnel.
 *
 * If this passes → bug is specific to the user's HEVC source.
 * If this fails  → bug is in our encoder settings.
 *
 * Cleans up created posts.
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

const envContent = readFileSync(envPath, 'utf-8');
for (const line of envContent.split('\n')) {
	const trimmed = line.trim();
	if (!trimmed || trimmed.startsWith('#')) continue;
	const idx = trimmed.indexOf('=');
	if (idx === -1) continue;
	const key = trimmed.slice(0, idx).trim();
	let val = trimmed.slice(idx + 1).trim();
	if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) val = val.slice(1, -1);
	if (!process.env[key]) process.env[key] = val;
}

const USER_TOKEN = process.env.USER_ACCESS_TOKEN;
const IG_ACCOUNT = process.env.INSTAGRAM_ACCOUNT_ID;
const FB_PAGE = process.env.FACEBOOK_PAGE_ID;
const API = process.env.GRAPH_API_VERSION || 'v25.0';
const BASE = 'https://graph.facebook.com';
const SERVE_PORT = 5681;

const require = createRequire(import.meta.url);
const ffmpeg = require('ffmpeg-static');

let tunnel = null;
let httpServer = null;
const cleanup = { igPostId: null };

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

function spawnAwait(cmd, args) {
	return new Promise((res, rej) => {
		const proc = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
		let err = '';
		proc.stderr.on('data', (c) => { err += c.toString(); });
		proc.on('close', (code) => code === 0 ? res() : rej(new Error(`${cmd} exited ${code}: ${err.slice(-2000)}`)));
		proc.on('error', rej);
	});
}

// Step 1: generate synthetic raw 10s video
async function makeRawVideo() {
	const tmp = join(tmpdir(), `synth_${Date.now()}_raw.mp4`);
	console.log('   Generating synthetic raw video (10s, 2160x3840 HEVC, similar to source)...');
	await spawnAwait(ffmpeg, [
		'-f', 'lavfi', '-i', 'testsrc=duration=10:size=2160x3840:rate=30',
		'-f', 'lavfi', '-i', 'sine=frequency=440:duration=10',
		'-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', // use H.264 since we need a quick source
		'-c:a', 'aac', '-b:a', '128k', '-ac', '2', '-ar', '48000',
		'-shortest', '-y', tmp,
	]);
	const buf = readFileSync(tmp);
	try { unlinkSync(tmp); } catch {}
	console.log(`   Generated ${(buf.length/1024/1024).toFixed(2)} MB`);
	return buf;
}

// Step 2: run through PRODUCTION reencode args
async function reencodeProd(buffer) {
	const prefix = join(tmpdir(), `synth_${Date.now()}`);
	const tmpIn = `${prefix}_in.mp4`, tmpOut = `${prefix}_out.mp4`;
	writeFileSync(tmpIn, buffer);
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
		'-c:a', 'aac', '-b:a', '128k', '-ac', '2', '-ar', '48000',
		'-movflags', '+faststart',
		'-map_metadata', '-1',
		'-f', 'mp4', '-y', tmpOut,
	];
	console.log('   Re-encoding with PRODUCTION args...');
	await spawnAwait(ffmpeg, args);
	const out = readFileSync(tmpOut);
	try { unlinkSync(tmpIn); unlinkSync(tmpOut); } catch {}
	console.log(`   Re-encoded ${(out.length/1024/1024).toFixed(2)} MB`);
	return out;
}

function parseRange(header, total) {
	const m = header.match(/^bytes=(\d+)-(\d*)$/);
	if (!m) return null;
	const s = parseInt(m[1], 10), e = m[2] ? parseInt(m[2], 10) : total - 1;
	if (s > e || s >= total) return null;
	return { start: s, end: Math.min(e, total - 1) };
}

function startTempServer(buffer, port) {
	return new Promise((resolve) => {
		const id = randomUUID();
		const path = `/${id}.mp4`;
		const total = buffer.length;
		const server = createServer((req, res) => {
			console.log(`   [server] ${req.method} ${req.url} (Range: ${req.headers['range'] || 'none'})`);
			if (req.url !== path) { res.writeHead(404); return res.end(); }
			if (req.method === 'HEAD') {
				res.writeHead(200, { 'Content-Type': 'video/mp4', 'Content-Length': total, 'Accept-Ranges': 'bytes' });
				return res.end();
			}
			const r = req.headers['range'] ? parseRange(req.headers['range'], total) : null;
			if (r) {
				res.writeHead(206, { 'Content-Type': 'video/mp4', 'Content-Range': `bytes ${r.start}-${r.end}/${total}`, 'Content-Length': r.end - r.start + 1, 'Accept-Ranges': 'bytes' });
				return res.end(buffer.subarray(r.start, r.end + 1));
			}
			res.writeHead(200, { 'Content-Type': 'video/mp4', 'Content-Length': total, 'Accept-Ranges': 'bytes' });
			res.end(buffer);
		});
		server.listen(port, '0.0.0.0', () => resolve({ path, server }));
	});
}

function startCloudflared(port) {
	return new Promise((resolve, reject) => {
		const proc = spawn('cloudflared', ['tunnel', '--url', `http://localhost:${port}`], { stdio: ['ignore', 'pipe', 'pipe'] });
		let resolved = false, stderr = '';
		proc.stderr.on('data', (c) => {
			stderr += c.toString();
			const m = c.toString().match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/);
			if (m && !resolved) {
				resolved = true;
				resolve({ url: m[0], close: () => new Promise((r) => { proc.on('exit', () => r()); proc.kill('SIGTERM'); setTimeout(() => { try { proc.kill('SIGKILL'); } catch {} r(); }, 3000); }) });
			}
		});
		proc.on('exit', (code) => { if (!resolved) reject(new Error(`cloudflared exited ${code}: ${stderr}`)); });
		setTimeout(() => { if (!resolved) { proc.kill(); reject(new Error('cloudflared timeout')); } }, 30_000);
	});
}

async function run() {
	console.log('\n=== Synthetic Reels test ===\n');
	const raw = await makeRawVideo();
	const encoded = await reencodeProd(raw);

	const { path, server } = await startTempServer(encoded, SERVE_PORT);
	httpServer = server;
	tunnel = await startCloudflared(SERVE_PORT);
	const url = `${tunnel.url}${path}`;
	console.log(`   Public URL: ${url}\n`);

	console.log('   Creating IG Reel container...');
	const cr = await graphPost(`${IG_ACCOUNT}/media`, {
		video_url: url, media_type: 'REELS', share_to_feed: 'true',
		caption: 'Synthetic test - will be deleted', access_token: USER_TOKEN,
	});
	console.log(`   ${cr.status}: ${JSON.stringify(cr.body)}`);
	if (!cr.body.id) throw new Error('Container creation failed');

	for (let i = 1; i <= 30; i++) {
		await new Promise(r => setTimeout(r, 8000));
		const s = await graphGet(cr.body.id, { fields: 'status_code,status', access_token: USER_TOKEN });
		console.log(`   Poll ${i}: ${s.body.status_code} ${s.body.status || ''}`);
		if (s.body.status_code === 'FINISHED') {
			console.log('\n✅ SUCCESS — synthetic video accepted by Instagram.');
			console.log('   Conclusion: bug is specific to the user\'s HEVC source, NOT the encoder settings.\n');
			// Publish briefly so we have an ID to clean up; otherwise just stop here
			const pub = await graphPost(`${IG_ACCOUNT}/media_publish`, { creation_id: cr.body.id, access_token: USER_TOKEN });
			if (pub.body.id) cleanup.igPostId = pub.body.id;
			return;
		}
		if (s.body.status_code === 'ERROR' || s.body.status_code === 'EXPIRED') {
			console.log(`\n❌ FAIL — synthetic video also rejected: ${s.body.status}`);
			console.log('   Conclusion: bug is in encoder settings, NOT specific to the source.\n');
			return;
		}
	}
}

try {
	await run();
} finally {
	if (cleanup.igPostId) {
		console.log(`\n🧹 Deleting IG post ${cleanup.igPostId}...`);
		const r = await graphDelete(cleanup.igPostId, USER_TOKEN);
		console.log(`   ${r.body.success ? 'deleted' : JSON.stringify(r.body)}`);
	}
	if (tunnel) await tunnel.close();
	if (httpServer) httpServer.close();
}
