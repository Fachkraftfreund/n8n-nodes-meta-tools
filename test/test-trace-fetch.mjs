/**
 * Run the same flow but:
 *   - Write request log to a separate file (so logs aren't lost)
 *   - Query container with extended fields to extract any error_user_msg
 *   - Compare what IG actually says vs the public 2207076 wrapper
 */
import { readFileSync, writeFileSync, appendFileSync, unlinkSync, existsSync } from 'fs';
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
const SERVE_PORT = 5682;
const REQ_LOG = 'w:/tmp/server-requests.log';

if (existsSync(REQ_LOG)) unlinkSync(REQ_LOG);

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

async function downloadVideo(url) {
	const res = await fetch(url);
	if (!res.ok) throw new Error(`Download failed: ${res.status}`);
	return Buffer.from(await res.arrayBuffer());
}

async function reencode(buffer) {
	const prefix = join(tmpdir(), `trace_${Date.now()}`);
	const tmpIn = `${prefix}_in.mp4`, tmpOut = `${prefix}_out.mp4`;
	writeFileSync(tmpIn, buffer);
	await spawnAwait(ffmpeg, [
		'-i', tmpIn,
		'-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-profile:v', 'high', '-level', '4.0',
		'-crf', '23', '-maxrate', '4500k', '-bufsize', '9000k', '-preset', 'medium',
		'-vf', 'scale=1080:1920:force_original_aspect_ratio=decrease,fps=30',
		'-c:a', 'aac', '-b:a', '128k', '-ac', '2', '-ar', '48000',
		'-movflags', '+faststart', '-map_metadata', '-1',
		'-f', 'mp4', '-y', tmpOut,
	]);
	const out = readFileSync(tmpOut);
	try { unlinkSync(tmpIn); unlinkSync(tmpOut); } catch {}
	return out;
}

function parseRange(h, total) {
	const m = h.match(/^bytes=(\d+)-(\d*)$/);
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
			const ts = new Date().toISOString();
			const ua = req.headers['user-agent'] || '<no-ua>';
			const range = req.headers['range'] || '<no-range>';
			const logLine = `${ts} ${req.method} ${req.url} | UA: ${ua} | Range: ${range}\n`;
			appendFileSync(REQ_LOG, logLine);
			console.log(`[server] ${logLine.trim()}`);
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

let tunnel, httpServer;
try {
	console.log('Re-encoding source...');
	const raw = await downloadVideo(VIDEO_URL);
	const enc = await reencode(raw);
	console.log(`Encoded: ${(enc.length / 1024 / 1024).toFixed(2)} MB`);

	const { path, server } = await startTempServer(enc, SERVE_PORT);
	httpServer = server;
	tunnel = await startCloudflared(SERVE_PORT);
	const url = `${tunnel.url}${path}`;
	console.log(`Public URL: ${url}\n`);

	// Get page token
	const pageRes = await gp(FB_PAGE, { fields: 'access_token', access_token: USER_TOKEN });
	const PAGE = pageRes.body.access_token;

	// Create container
	console.log('Creating IG Reel container with page token...');
	const cr = await gp(`${IG_ACCOUNT}/media`, {
		video_url: url, media_type: 'REELS', share_to_feed: 'true',
		caption: 'Trace test', access_token: PAGE,
	}, 'POST');
	console.log(`Container: ${JSON.stringify(cr.body)}\n`);
	if (!cr.body.id) throw new Error('Container creation failed');

	// Poll with extended fields
	for (let i = 1; i <= 15; i++) {
		await new Promise(r => setTimeout(r, 6000));
		const s = await gp(cr.body.id, {
			fields: 'id,status,status_code',
			access_token: PAGE,
		});
		console.log(`Poll ${i}: ${JSON.stringify(s.body)}`);
		if (['FINISHED', 'ERROR', 'EXPIRED'].includes(s.body.status_code)) break;
	}

	console.log(`\n=== Server request log (${REQ_LOG}) ===`);
	if (existsSync(REQ_LOG)) {
		console.log(readFileSync(REQ_LOG, 'utf-8') || '(empty — Instagram never connected)');
	} else {
		console.log('(file missing)');
	}
} finally {
	if (tunnel) await tunnel.close();
	if (httpServer) httpServer.close();
}
