import * as http from 'http';
import { randomUUID } from 'crypto';

export interface TempVideoServer {
	url: string;
	close: () => Promise<void>;
}

/**
 * Map of active video filenames → buffers.
 * Shared across all concurrent executions so a single interceptor can serve them.
 */
const activeVideos = new Map<string, Buffer>();

/** Whether we've already installed the request interceptor on n8n's server. */
let interceptorInstalled = false;

const TMP_VIDEO_PREFIX = '/tmp-video/';

/**
 * Parse an HTTP Range header like "bytes=0-999" against a total file size.
 * Returns { start, end } (inclusive) or undefined if unparseable.
 */
function parseRange(header: string, total: number): { start: number; end: number } | undefined {
	const match = header.match(/^bytes=(\d+)-(\d*)$/);
	if (!match) return undefined;
	const start = parseInt(match[1], 10);
	const end = match[2] ? parseInt(match[2], 10) : total - 1;
	if (start > end || start >= total) return undefined;
	return { start, end: Math.min(end, total - 1) };
}

/**
 * Serve a video buffer, supporting HEAD and byte-range (206 Partial Content) requests
 * which Instagram's video fetcher uses for parallel/resumable downloads.
 */
function serveBuffer(req: http.IncomingMessage, res: http.ServerResponse, buffer: Buffer): void {
	const total = buffer.length;

	if (req.method === 'HEAD') {
		res.writeHead(200, {
			'Content-Type': 'video/mp4',
			'Content-Length': total.toString(),
			'Accept-Ranges': 'bytes',
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
		});
		res.end(buffer.subarray(start, end + 1));
	} else {
		res.writeHead(200, {
			'Content-Type': 'video/mp4',
			'Content-Length': total.toString(),
			'Accept-Ranges': 'bytes',
		});
		res.end(buffer);
	}
}

/**
 * Find n8n's running HTTP server via Node.js process internals.
 * Returns the first listening http.Server (there's typically only one in n8n).
 */
function findN8nServer(): http.Server | null {
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	const handles: any[] = (process as any)._getActiveHandles?.() || [];
	return handles.find(
		(h: unknown) => h instanceof http.Server && (h as http.Server).listening,
	) ?? null;
}

/**
 * Install a request interceptor on n8n's HTTP server (once).
 *
 * Replaces the server's 'request' listeners with a wrapper that:
 * 1. Serves videos from the activeVideos map at /tmp-video/{uuid}.mp4
 * 2. Passes all other requests through to the original handler (Express/n8n)
 */
function installInterceptor(server: http.Server): void {
	if (interceptorInstalled) return;

	const listeners = server.listeners('request') as Array<(...args: unknown[]) => void>;
	if (listeners.length === 0) {
		throw new Error('No request handlers found on n8n HTTP server');
	}

	const originalHandler = listeners[0];
	server.removeAllListeners('request');

	server.on('request', (req: http.IncomingMessage, res: http.ServerResponse) => {
		// Check for /tmp-video/{uuid}.mp4 path
		if (
			req.url?.startsWith(TMP_VIDEO_PREFIX) &&
			(req.method === 'GET' || req.method === 'HEAD')
		) {
			const filename = req.url.slice(TMP_VIDEO_PREFIX.length);
			const buffer = activeVideos.get(filename);
			if (buffer) {
				serveBuffer(req, res, buffer);
				return;
			}
		}
		// Pass through to n8n/Express
		originalHandler(req, res);
	});

	interceptorInstalled = true;
}

/**
 * Register a video buffer on n8n's HTTP server at a random UUID path.
 *
 * Instead of starting a separate HTTP server, this piggybacks on n8n's
 * existing server so the video is accessible at the same public URL/port.
 * This is critical for hosted environments (sliplane, Railway, etc.) where
 * only n8n's port is exposed.
 *
 * Supports HEAD and byte-range requests for Instagram's video fetcher.
 *
 * @param buffer     The re-encoded video buffer to serve
 * @param baseUrl    The n8n instance base URL (from getInstanceBaseUrl())
 * @returns          A TempVideoServer with the public URL and a close() to unregister
 */
export function startTempVideoServer(
	buffer: Buffer,
	baseUrl: string,
): Promise<TempVideoServer> {
	return new Promise((resolve, reject) => {
		try {
			const server = findN8nServer();
			if (!server) {
				reject(new Error(
					'Could not find n8n\'s HTTP server. Ensure the node is running inside n8n.',
				));
				return;
			}

			installInterceptor(server);

			const filename = `${randomUUID()}.mp4`;
			activeVideos.set(filename, buffer);

			const url = `${baseUrl.replace(/\/+$/, '')}${TMP_VIDEO_PREFIX}${filename}`;

			resolve({
				url,
				close: () => {
					activeVideos.delete(filename);
					return Promise.resolve();
				},
			});
		} catch (err) {
			reject(err);
		}
	});
}
