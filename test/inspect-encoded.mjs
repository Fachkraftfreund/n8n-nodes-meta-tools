/**
 * Re-encode the configured VIDEO_URL with the production ffmpeg args,
 * then ffprobe the output to inspect what Instagram is actually receiving.
 */
import { readFileSync, writeFileSync, unlinkSync, existsSync } from 'fs';
import { resolve, dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { spawn } from 'child_process';
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
	if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
		val = val.slice(1, -1);
	}
	if (!process.env[key]) process.env[key] = val;
}

const VIDEO_URL = process.env.VIDEO_URL;
if (!VIDEO_URL) {
	console.error('Missing VIDEO_URL');
	process.exit(1);
}

const require = createRequire(import.meta.url);
const ffmpeg = require('ffmpeg-static');
const ffprobe = 'ffprobe'; // use system ffprobe (ffmpeg-static does not ship one)

async function downloadVideo(url) {
	const res = await fetch(url);
	if (!res.ok) throw new Error(`Download failed: ${res.status}`);
	return Buffer.from(await res.arrayBuffer());
}

async function reencode(inputBuffer) {
	const prefix = join(tmpdir(), `metapost_inspect_${Date.now()}`);
	const tmpIn = `${prefix}_in.mp4`;
	const tmpOut = `${prefix}_out.mp4`;
	writeFileSync(tmpIn, inputBuffer);

	// EXACT production args from nodes/MetaPost/utils/ffmpeg.ts
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
		const proc = spawn(ffmpeg, args, { stdio: ['ignore', 'pipe', 'pipe'] });
		let err = '';
		proc.stderr.on('data', (c) => { err += c.toString(); });
		proc.on('close', (code) => code === 0 ? res() : rej(new Error(err)));
	});

	const output = readFileSync(tmpOut);
	try { unlinkSync(tmpIn); } catch {}
	console.log(`\n=== Re-encoded file: ${tmpOut} (${(output.length / 1024 / 1024).toFixed(2)} MB) ===\n`);
	return tmpOut;
}

async function probe(file) {
	return new Promise((res, rej) => {
		const proc = spawn(ffprobe, [
			'-v', 'error',
			'-show_format',
			'-show_streams',
			'-print_format', 'json',
			file,
		], { stdio: ['ignore', 'pipe', 'pipe'] });
		let out = '', err = '';
		proc.stdout.on('data', (c) => { out += c.toString(); });
		proc.stderr.on('data', (c) => { err += c.toString(); });
		proc.on('close', (code) => code === 0 ? res(JSON.parse(out)) : rej(new Error(err)));
	});
}

console.log('Downloading video...');
const buf = await downloadVideo(VIDEO_URL);
console.log(`Downloaded ${(buf.length / 1024 / 1024).toFixed(1)} MB`);

console.log('Re-encoding (production args)...');
const outFile = await reencode(buf);

console.log('Probing output...');
const probed = await probe(outFile);

console.log('=== FORMAT ===');
console.log(JSON.stringify(probed.format, null, 2));

for (const stream of probed.streams) {
	console.log(`\n=== STREAM ${stream.index} (${stream.codec_type}) ===`);
	console.log(JSON.stringify(stream, null, 2));
}
