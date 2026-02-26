import * as http from 'http';
import { randomUUID } from 'crypto';

export interface TempVideoServer {
	url: string;
	close: () => Promise<void>;
}

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
 * Start a temporary HTTP server that serves a video buffer at a random UUID path.
 * Used to provide Instagram with a publicly accessible URL for the re-encoded video,
 * since FB CDN URLs are blocked by Instagram's processing servers.
 *
 * Supports HEAD requests and byte-range requests (Range header), which Instagram's
 * video fetcher uses for parallel/resumable downloads.
 *
 * The server only serves the one file at an unguessable path and shuts down
 * after close() is called.
 */
export function startTempVideoServer(
	buffer: Buffer,
	baseUrl: string,
	port: number,
): Promise<TempVideoServer> {
	return new Promise((resolve, reject) => {
		const id = randomUUID();
		const servePath = `/${id}.mp4`;
		const total = buffer.length;

		const server = http.createServer((req, res) => {
			if (req.url !== servePath || (req.method !== 'GET' && req.method !== 'HEAD')) {
				res.writeHead(404);
				res.end();
				return;
			}

			const rangeHeader = req.headers['range'];

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

			// GET request — check for Range header
			if (rangeHeader) {
				const range = parseRange(rangeHeader, total);
				if (!range) {
					res.writeHead(416, { 'Content-Range': `bytes */${total}` });
					res.end();
					return;
				}
				const { start, end } = range;
				const chunkSize = end - start + 1;
				res.writeHead(206, {
					'Content-Type': 'video/mp4',
					'Content-Range': `bytes ${start}-${end}/${total}`,
					'Content-Length': chunkSize.toString(),
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

		server.on('error', (err) => {
			reject(new Error(
				`Failed to start temporary video server on port ${port}: ${err.message}. ` +
				'Ensure the port is not in use and is accessible from the internet.',
			));
		});

		server.listen(port, '0.0.0.0', () => {
			const url = `${baseUrl}${servePath}`;
			resolve({
				url,
				close: () => new Promise<void>((res) => {
					server.close(() => res());
					// Force-close lingering connections after 2s
					setTimeout(() => res(), 2000);
				}),
			});
		});
	});
}
