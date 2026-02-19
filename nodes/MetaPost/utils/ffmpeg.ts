import { spawn, execSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { IExecuteFunctions } from 'n8n-workflow';

let resolvedFfmpegPath: string | null = null;

/**
 * Ensure the ffmpeg binary exists, downloading it if necessary.
 * ffmpeg-static's postinstall may not run in all environments (e.g. n8n Docker).
 */
function ensureFfmpeg(): string {
	if (resolvedFfmpegPath) return resolvedFfmpegPath;

	// eslint-disable-next-line @typescript-eslint/no-var-requires
	const expectedPath: string = require('ffmpeg-static');
	if (!expectedPath) {
		throw new Error('ffmpeg-static: unsupported platform/architecture');
	}

	if (!fs.existsSync(expectedPath)) {
		const ffmpegStaticDir = path.dirname(require.resolve('ffmpeg-static'));
		try {
			execSync('node install.js', {
				cwd: ffmpegStaticDir,
				stdio: 'pipe',
				timeout: 120_000,
			});
		} catch (err) {
			throw new Error(
				`ffmpeg binary not found and automatic download failed. ` +
				`Expected path: ${expectedPath}. ` +
				`Error: ${err instanceof Error ? err.message : String(err)}`,
			);
		}

		if (!fs.existsSync(expectedPath)) {
			throw new Error(
				`ffmpeg binary download completed but file still missing at ${expectedPath}`,
			);
		}
	}

	resolvedFfmpegPath = expectedPath;
	return resolvedFfmpegPath;
}

export interface ImageConvertOptions {
	maxWidth: number;
	maxHeight: number;
	outputFormat: 'jpeg' | 'png';
}

export interface VideoConvertOptions {
	videoCodec: string;
	crf: number;
	preset: string;
	fps: number;
	audioCodec: string;
	audioBitrate: string;
	audioChannels: number;
	audioSampleRate: number;
	maxWidth: number;
	maxHeight: number;
}

/**
 * Convert image buffer using ffmpeg.
 * Images can be piped via stdin/stdout since there's no seeking requirement.
 */
export async function convertImage(
	inputBuffer: Buffer,
	options: ImageConvertOptions,
): Promise<Buffer> {
	const ffmpeg = ensureFfmpeg();

	const codec = options.outputFormat === 'jpeg' ? 'mjpeg' : 'png';
	const args = [
		'-i', 'pipe:0',
		'-vf', `scale=${options.maxWidth}:${options.maxHeight}:force_original_aspect_ratio=decrease`,
		'-map_metadata', '-1',
		'-f', 'image2',
		'-c:v', codec,
	];

	if (options.outputFormat === 'jpeg') {
		args.push('-q:v', '2');
	}

	args.push('pipe:1');

	return runFfmpegPipe(ffmpeg, args, inputBuffer);
}

/**
 * Convert video buffer using ffmpeg.
 * Videos write to a temp file because -movflags +faststart requires seeking.
 */
export async function convertVideo(
	inputBuffer: Buffer,
	options: VideoConvertOptions,
): Promise<Buffer> {
	const ffmpeg = ensureFfmpeg();

	const tmpFile = path.join(
		os.tmpdir(),
		`metapost_${Date.now()}_${Math.random().toString(36).slice(2)}.mp4`,
	);

	const args = [
		'-i', 'pipe:0',
		'-c:v', options.videoCodec,
		'-crf', options.crf.toString(),
		'-preset', options.preset,
		'-vf', `scale=${options.maxWidth}:${options.maxHeight}:force_original_aspect_ratio=decrease,fps=${options.fps}`,
		'-c:a', options.audioCodec,
		'-b:a', options.audioBitrate,
		'-ac', options.audioChannels.toString(),
		'-ar', options.audioSampleRate.toString(),
		'-movflags', '+faststart',
		'-map_metadata', '-1',
		'-f', 'mp4',
		'-y',
		tmpFile,
	];

	try {
		await runFfmpegToFile(ffmpeg, args, inputBuffer);
		return fs.readFileSync(tmpFile);
	} finally {
		try {
			if (fs.existsSync(tmpFile)) {
				fs.unlinkSync(tmpFile);
			}
		} catch {
			// Ignore cleanup errors
		}
	}
}

/**
 * Download a file from a URL as a Buffer.
 */
export async function downloadMedia(
	ctx: IExecuteFunctions,
	url: string,
): Promise<Buffer> {
	const response = await ctx.helpers.httpRequest({
		method: 'GET',
		url,
		encoding: 'arraybuffer',
		returnFullResponse: true,
	});
	return Buffer.from(response.body as ArrayBuffer);
}

/**
 * Run ffmpeg with stdin input and stdout output (for images).
 */
function runFfmpegPipe(bin: string, args: string[], inputBuffer: Buffer): Promise<Buffer> {
	return new Promise((resolve, reject) => {
		const proc = spawn(bin, args, {
			stdio: ['pipe', 'pipe', 'pipe'],
		});

		const chunks: Buffer[] = [];
		let stderr = '';

		proc.stdout.on('data', (chunk: Buffer) => chunks.push(chunk));
		proc.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });

		proc.on('close', (code) => {
			if (code === 0) {
				resolve(Buffer.concat(chunks));
			} else {
				reject(new Error(`ffmpeg exited with code ${code}: ${stderr}`));
			}
		});

		proc.on('error', (err) => {
			reject(new Error(`Failed to spawn ffmpeg: ${err.message}`));
		});

		proc.stdin.write(inputBuffer);
		proc.stdin.end();
	});
}

/**
 * Run ffmpeg with stdin input and file output (for video with faststart).
 */
function runFfmpegToFile(bin: string, args: string[], inputBuffer: Buffer): Promise<void> {
	return new Promise((resolve, reject) => {
		const proc = spawn(bin, args, {
			stdio: ['pipe', 'pipe', 'pipe'],
		});

		let stderr = '';

		proc.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });

		proc.on('close', (code) => {
			if (code === 0) {
				resolve();
			} else {
				reject(new Error(`ffmpeg exited with code ${code}: ${stderr}`));
			}
		});

		proc.on('error', (err) => {
			reject(new Error(`Failed to spawn ffmpeg: ${err.message}`));
		});

		proc.stdin.write(inputBuffer);
		proc.stdin.end();
	});
}
