import * as http from 'http';
import { randomUUID } from 'crypto';

export interface TempVideoServer {
	url: string;
	close: () => Promise<void>;
}

/**
 * Start a temporary HTTP server that serves a video buffer at a random UUID path.
 * Used to provide Instagram with a publicly accessible URL for the re-encoded video,
 * since FB CDN URLs are blocked by Instagram's processing servers.
 *
 * The server only serves the one file at an unguessable path and shuts down
 * after close() is called.
 */
export function startTempVideoServer(
	buffer: Buffer,
	host: string,
	port: number,
): Promise<TempVideoServer> {
	return new Promise((resolve, reject) => {
		const id = randomUUID();
		const servePath = `/${id}.mp4`;

		const server = http.createServer((req, res) => {
			if (req.url === servePath && (req.method === 'GET' || req.method === 'HEAD')) {
				res.writeHead(200, {
					'Content-Type': 'video/mp4',
					'Content-Length': buffer.length.toString(),
					'Accept-Ranges': 'bytes',
				});
				if (req.method === 'GET') {
					res.end(buffer);
				} else {
					res.end();
				}
			} else {
				res.writeHead(404);
				res.end();
			}
		});

		server.on('error', (err) => {
			reject(new Error(
				`Failed to start temporary video server on port ${port}: ${err.message}. ` +
				'Ensure the port is not in use and is accessible from the internet.',
			));
		});

		server.listen(port, '0.0.0.0', () => {
			const url = `http://${host}:${port}${servePath}`;
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
