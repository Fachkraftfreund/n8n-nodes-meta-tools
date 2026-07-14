import type {
	IDataObject,
	IExecuteFunctions,
	INodeExecutionData,
	INodeType,
	INodeTypeDescription,
} from 'n8n-workflow';
import { NodeOperationError } from 'n8n-workflow';

import type { MetaPostParams, MetaPostResult, CarouselItem, IgStatusResponse } from './types';
import * as graphApi from './utils/graphApi';
import { convertImage, convertVideo, downloadMedia } from './utils/ffmpeg';

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * True for Meta's transient throttling errors — safe to back off and retry
 * rather than fail the whole post. Covers app (#4), user (#17), page (#32),
 * temporary (#341) and custom (#613) rate limits.
 */
function isRateLimitError(err: unknown): boolean {
	const msg = (err as Error)?.message ?? '';
	return /\(#(4|17|32|341|613)\)/.test(msg) || /request limit reached/i.test(msg);
}

function formatIgApiError(resp: graphApi.FullResponse): string {
	const err = resp.body?.error;
	if (!err) return `HTTP ${resp.statusCode}: ${JSON.stringify(resp.body)}`;
	const parts = [`HTTP ${resp.statusCode}`];
	if (err.code) parts.push(`code ${err.code}`);
	if (err.error_subcode) parts.push(`subcode ${err.error_subcode}`);
	const msg = err.error_user_msg || err.message || '';
	return `Instagram publish failed (${parts.join(', ')}): ${msg}`;
}

async function publishIgContainerWithRetry(
	ctx: IExecuteFunctions,
	userAccessToken: string,
	igAccountId: string,
	containerId: string,
	apiVersion: string,
): Promise<{ id: string }> {
	const delays = [1000, 2000, 3000, 4000, 5000];
	for (let attempt = 0; ; attempt++) {
		const resp = await graphApi.publishIgContainer(
			ctx, userAccessToken, igAccountId, containerId, apiVersion,
		);

		if (resp.statusCode >= 200 && resp.statusCode < 300 && resp.body?.id) {
			return { id: resp.body.id };
		}

		// Subcode 2207027 = "media not ready yet" — transient, safe to retry
		const isMediaNotReady = resp.body?.error?.error_subcode === 2207027;

		// Don't retry permanent client errors (4xx), except "media not ready"
		if (resp.statusCode >= 400 && resp.statusCode < 500 && !isMediaNotReady) {
			throw new Error(formatIgApiError(resp));
		}

		if (attempt >= delays.length) {
			throw new Error(formatIgApiError(resp));
		}

		await sleep(delays[attempt]);
	}
}

function prepareCaption(caption: string, hashSuffix: string): string {
	let result = caption;
	if (hashSuffix && !result.endsWith(hashSuffix)) {
		result = result + '\n' + hashSuffix;
	}
	return result.replace(/\n{3,}/g, '\n\n');
}

const VIDEO_EXTENSIONS = new Set(['.mp4', '.mov', '.avi', '.webm', '.mkv', '.m4v']);

function detectItemMediaTypeByExt(url: string): 'image' | 'video' | null {
	try {
		const pathname = new URL(url).pathname.toLowerCase();
		const ext = pathname.slice(pathname.lastIndexOf('.'));
		if (VIDEO_EXTENSIONS.has(ext)) return 'video';
		if (['.jpg', '.jpeg', '.png', '.gif', '.bmp', '.webp', '.heic'].includes(ext)) return 'image';
		return null;
	} catch {
		return null;
	}
}

async function detectItemMediaType(
	ctx: IExecuteFunctions,
	url: string,
): Promise<'image' | 'video'> {
	// Try extension first
	const byExt = detectItemMediaTypeByExt(url);
	if (byExt) return byExt;

	// Fall back to HEAD request for Content-Type
	try {
		const resp = (await ctx.helpers.httpRequest({
			method: 'HEAD',
			url,
			returnFullResponse: true,
			ignoreHttpStatusErrors: true,
		})) as { headers: Record<string, string> };
		const ct = (resp.headers?.['content-type'] || '').toLowerCase();
		if (ct.startsWith('video/')) return 'video';
	} catch {
		// Ignore — default to image
	}
	return 'image';
}

async function readParams(ctx: IExecuteFunctions, i: number): Promise<MetaPostParams> {
	const mediaType = ctx.getNodeParameter('mediaType', i) as string;
	const mediaUrl = ctx.getNodeParameter('mediaUrl', i) as string;
	const imageSettings = ctx.getNodeParameter('imageSettings', i, {}) as IDataObject;
	const videoSettings = ctx.getNodeParameter('videoSettings', i, {}) as IDataObject;

	let carouselItems: CarouselItem[] = [];
	if (mediaType === 'carousel') {
		const urls = mediaUrl.split(',').map((u) => u.trim()).filter((u) => u.length > 0);
		carouselItems = await Promise.all(
			urls.map(async (u) => ({
				mediaType: await detectItemMediaType(ctx, u),
				mediaUrl: u,
			})),
		);
	}

	return {
		mediaType: mediaType as 'image' | 'video' | 'carousel',
		mediaUrl,
		carouselItems,
		caption: ctx.getNodeParameter('caption', i, '') as string,
		hashSuffix: ctx.getNodeParameter('hashSuffix', i, '') as string,
		location: ctx.getNodeParameter('location', i, '') as string,
		instagramAccountId: ctx.getNodeParameter('instagramAccountId', i) as string,
		facebookPageId: ctx.getNodeParameter('facebookPageId', i) as string,
		graphApiVersion: ctx.getNodeParameter('graphApiVersion', i, 'v25.0') as string,
		imageMaxWidth: (imageSettings.imageMaxWidth as number) ?? 1080,
		imageMaxHeight: (imageSettings.imageMaxHeight as number) ?? 1920,
		imageOutputFormat: (imageSettings.imageOutputFormat as 'jpeg' | 'png') ?? 'jpeg',
		videoCodec: (videoSettings.videoCodec as string) ?? 'libx264',
		videoCrf: (videoSettings.videoCrf as number) ?? 23,
		videoPreset: (videoSettings.videoPreset as string) ?? 'medium',
		videoFps: (videoSettings.videoFps as number) ?? 30,
		audioCodec: (videoSettings.audioCodec as string) ?? 'aac',
		audioBitrate: (videoSettings.audioBitrate as string) ?? '128k',
		audioChannels: (videoSettings.audioChannels as number) ?? 2,
		audioSampleRate: (videoSettings.audioSampleRate as number) ?? 48000,
		videoMaxWidth: (videoSettings.videoMaxWidth as number) ?? 1080,
		videoMaxHeight: (videoSettings.videoMaxHeight as number) ?? 1920,
		videoMaxBitrate: (videoSettings.videoMaxBitrate as string) ?? '4500k',
	};
}

// ── Image Flow ─────────────────────────────────────────────────────

async function handleImage(
	ctx: IExecuteFunctions,
	userAccessToken: string,
	pageAccessToken: string,
	params: MetaPostParams,
	caption: string,
): Promise<MetaPostResult> {
	const { instagramAccountId, facebookPageId, graphApiVersion, mediaUrl, locationId } = params;

	let fbPhotoId: string | undefined;
	let igContainerId: string;

	// Step 1: Try creating IG container with original URL
	// Use ignoreHttpStatusErrors + returnFullResponse so we can inspect the response
	// for format errors (Instagram rejects certain image formats like WebP)
	const containerResp = await graphApi.tryCreateIgImageContainer(
		ctx, userAccessToken, instagramAccountId, mediaUrl, caption, graphApiVersion, locationId,
	);

	if (containerResp.statusCode >= 200 && containerResp.statusCode < 300 && containerResp.body?.id) {
		igContainerId = containerResp.body.id;
	} else {
		// Check for format error in response headers and body (matching workflow logic)
		const wwwAuth = (containerResp.headers?.['www-authenticate'] as string) || '';
		const bodyMsg = containerResp.body?.error?.message || '';
		const errorText = wwwAuth + ' ' + bodyMsg;
		const isFormatError = errorText.includes('Only photo or video can be accepted');

		if (!isFormatError) {
			throw new Error(
				`Instagram container creation failed (HTTP ${containerResp.statusCode}): ${bodyMsg || JSON.stringify(containerResp.body)}`,
			);
		}

		// Step 2: Convert image and retry via Facebook CDN
		const imageBuffer = await downloadMedia(ctx, mediaUrl);
		const convertedBuffer = await convertImage(imageBuffer, {
			maxWidth: params.imageMaxWidth,
			maxHeight: params.imageMaxHeight,
			outputFormat: params.imageOutputFormat,
		});

		const ext = params.imageOutputFormat;
		const mime = ext === 'jpeg' ? 'image/jpeg' : 'image/png';

		// Upload to Facebook as unpublished photo to get a CDN URL
		const fbPhoto = await graphApi.uploadFbPhotoFromBuffer(
			ctx, pageAccessToken, facebookPageId,
			convertedBuffer, `converted.${ext}`, mime, false, graphApiVersion,
		);
		fbPhotoId = fbPhoto.id;

		// Get CDN URL from Facebook
		const photoImages = await graphApi.getFbPhotoImages(
			ctx, pageAccessToken, fbPhotoId, graphApiVersion,
		);
		const cdnUrl = photoImages.images[0]?.source;
		if (!cdnUrl) {
			throw new Error('Could not retrieve CDN URL for converted image from Facebook');
		}

		// Retry IG container with Facebook CDN URL
		const retryContainer = await graphApi.createIgImageContainer(
			ctx, userAccessToken, instagramAccountId, cdnUrl, caption, graphApiVersion, locationId,
		);
		igContainerId = retryContainer.id;
	}

	// Step 3: Publish IG post (retry – container may still be processing)
	const igPost = await publishIgContainerWithRetry(
		ctx, userAccessToken, instagramAccountId, igContainerId, graphApiVersion,
	);

	// Step 4: Upload photo to Facebook (if not already done during conversion).
	// Always go through download + convertImage + buffer upload — Facebook's /photos
	// endpoint rejects URLs whose target exceeds 10 MB (subcode 1366046), even when
	// Instagram accepts the same URL. Local conversion also normalises the format.
	if (!fbPhotoId) {
		const imageBuffer = await downloadMedia(ctx, mediaUrl);
		const convertedBuffer = await convertImage(imageBuffer, {
			maxWidth: params.imageMaxWidth,
			maxHeight: params.imageMaxHeight,
			outputFormat: params.imageOutputFormat,
		});
		const ext = params.imageOutputFormat;
		const mime = ext === 'jpeg' ? 'image/jpeg' : 'image/png';
		const fbPhoto = await graphApi.uploadFbPhotoFromBuffer(
			ctx, pageAccessToken, facebookPageId,
			convertedBuffer, `photo.${ext}`, mime, false, graphApiVersion,
		);
		fbPhotoId = fbPhoto.id;
	}

	// Step 5: Create Facebook feed post with attached photo
	const fbFeedPost = await graphApi.createFbFeedPost(
		ctx, pageAccessToken, facebookPageId, caption, fbPhotoId, graphApiVersion, locationId,
	);

	// Step 6: Get IG permalink
	const igPermalink = await graphApi.getIgPermalink(
		ctx, userAccessToken, igPost.id, graphApiVersion,
	);

	return {
		instagram_post_id: igPost.id,
		instagram_permalink: igPermalink.permalink,
		facebook_post_id: fbFeedPost.id,
		facebook_photo_id: fbPhotoId,
		location_id: locationId,
	};
}

// ── Video Flow ─────────────────────────────────────────────────────

async function pollIgContainer(
	ctx: IExecuteFunctions,
	userAccessToken: string,
	containerId: string,
	apiVersion: string,
): Promise<void> {
	const pollInterval = 10000;
	const maxTotalMs = 8 * 60 * 1000; // hard cap including rate-limit backoff
	const maxRateLimitRetries = 8;
	const start = Date.now();
	let rateLimitRetries = 0;

	while (Date.now() - start < maxTotalMs) {
		await sleep(pollInterval);

		let status: IgStatusResponse;
		try {
			status = await graphApi.getIgContainerStatus(
				ctx, userAccessToken, containerId, apiVersion,
			);
		} catch (err) {
			// Meta rate-limit (#4 etc.) is transient: back off exponentially and
			// keep polling instead of failing the whole reel.
			if (isRateLimitError(err) && rateLimitRetries < maxRateLimitRetries) {
				rateLimitRetries++;
				await sleep(Math.min(pollInterval * 2 ** rateLimitRetries, 60000));
				continue;
			}
			throw err;
		}
		rateLimitRetries = 0;

		if (status.status_code === 'FINISHED') return;

		if (status.status_code === 'ERROR' || status.status_code === 'EXPIRED') {
			throw new Error(
				`Instagram Reel processing failed: ${status.status || status.status_code}. ` +
				'Ensure the video meets Instagram Reels requirements ' +
				'(MP4 H.264, max 5 Mbps bitrate, max 90s, 9:16 aspect ratio recommended).',
			);
		}
	}

	throw new Error(
		'Instagram Reel status polling timed out. If this recurs with "(#4) Application request ' +
		'limit reached", your Meta app is hitting its API rate limit — reduce call volume or ' +
		'request a higher limit in the Meta App Dashboard.',
	);
}

async function handleVideo(
	ctx: IExecuteFunctions,
	userAccessToken: string,
	pageAccessToken: string,
	params: MetaPostParams,
	caption: string,
): Promise<MetaPostResult> {
	const { instagramAccountId, facebookPageId, graphApiVersion, locationId } = params;

	// Parse media URL: if comma-separated, split into video + cover image
	let videoUrl: string;
	let coverUrl: string | undefined;
	const urls = params.mediaUrl.split(',').map((u) => u.trim()).filter((u) => u.length > 0);
	if (urls.length >= 2) {
		const detected = await Promise.all(
			urls.map(async (u) => ({ url: u, type: await detectItemMediaType(ctx, u) })),
		);
		const video = detected.find((d) => d.type === 'video');
		const image = detected.find((d) => d.type === 'image');
		if (!video) {
			throw new Error('No video URL found. When providing two URLs for a video post, one must be a video.');
		}
		videoUrl = video.url;
		coverUrl = image?.url;
	} else {
		videoUrl = urls[0];
	}

	// Step 1: Download and convert video
	const videoBuffer = await downloadMedia(ctx, videoUrl);
	const convertedBuffer = await convertVideo(videoBuffer, {
		videoCodec: params.videoCodec,
		crf: params.videoCrf,
		preset: params.videoPreset,
		fps: params.videoFps,
		audioCodec: params.audioCodec,
		audioBitrate: params.audioBitrate,
		audioChannels: params.audioChannels,
		audioSampleRate: params.audioSampleRate,
		maxWidth: params.videoMaxWidth,
		maxHeight: params.videoMaxHeight,
		maxBitrate: params.videoMaxBitrate,
	});

	// Step 2: Upload converted video to Facebook (published) — runs in parallel with IG flow
	// Also download cover image (if provided) so we can use it as FB thumbnail
	let fbThumbnail: { buffer: Buffer; mimeType: string; filename: string } | undefined;
	if (coverUrl) {
		try {
			const coverBuffer = await downloadMedia(ctx, coverUrl);
			const ext = detectItemMediaTypeByExt(coverUrl);
			// Derive mime type from URL extension; default to JPEG
			const url = new URL(coverUrl);
			const lower = url.pathname.toLowerCase();
			let mime = 'image/jpeg';
			let fname = 'cover.jpg';
			if (lower.endsWith('.png')) { mime = 'image/png'; fname = 'cover.png'; }
			else if (lower.endsWith('.gif')) { mime = 'image/gif'; fname = 'cover.gif'; }
			else if (lower.endsWith('.webp')) { mime = 'image/webp'; fname = 'cover.webp'; }
			fbThumbnail = { buffer: coverBuffer, mimeType: mime, filename: fname };
			void ext; // suppress unused
		} catch {
			// Cover download failed — proceed without thumbnail
		}
	}
	const fbVideoPromise = graphApi.uploadFbVideoFromBuffer(
		ctx, pageAccessToken, facebookPageId,
		convertedBuffer, 'video.mp4', caption, true, graphApiVersion, locationId, fbThumbnail,
	);

	// Step 3-6: IG flow — wrapped in try-catch to clean up FB video on failure
	let igPost: { id: string };
	try {
		// Step 3: Create IG Reel container via resumable upload (no public URL needed)
		const igContainer = await graphApi.createIgReelContainerResumable(
			ctx, userAccessToken, instagramAccountId,
			caption, graphApiVersion, coverUrl, locationId,
		);

		// Step 4: POST the video bytes to Instagram's upload endpoint
		await graphApi.uploadIgVideoBytes(
			ctx, userAccessToken, igContainer.uri, convertedBuffer,
		);

		// Step 5: Poll IG container status
		await pollIgContainer(ctx, userAccessToken, igContainer.id, graphApiVersion);

		// Step 6: Publish IG Reel (retry – may briefly lag behind status poll)
		igPost = await publishIgContainerWithRetry(
			ctx, userAccessToken, instagramAccountId, igContainer.id, graphApiVersion,
		);
	} catch (error) {
		// IG failed — clean up the parallel FB video upload so we don't leave orphaned posts
		try {
			const fbVideo = await fbVideoPromise;
			await graphApi.deleteFbVideo(ctx, pageAccessToken, fbVideo.id, graphApiVersion);
		} catch {
			// Ignore cleanup errors — the IG error is what matters
		}

		const msg = (error as Error).message || '';
		if (msg.includes('2207089') || msg.toLowerCase().includes('carousel')) {
			throw new Error(
				'Instagram rejected the video as a Reel. The video likely exceeds Instagram Reels ' +
				'requirements (max 5 Mbps bitrate, H.264 High profile, max 90s duration). ' +
				'Please re-encode the source video to a lower bitrate before posting. ' +
				`(Original error: ${msg})`,
			);
		}
		throw error;
	}

	// Step 7: Wait for FB upload to complete
	const fbVideo = await fbVideoPromise;

	// Step 8: Get IG permalink
	const igPermalink = await graphApi.getIgPermalink(
		ctx, userAccessToken, igPost.id, graphApiVersion,
	);

	return {
		instagram_post_id: igPost.id,
		instagram_permalink: igPermalink.permalink,
		facebook_post_id: `${facebookPageId}_${fbVideo.id}`,
		facebook_video_id: fbVideo.id,
		location_id: locationId,
	};
}

// ── Carousel Flow ──────────────────────────────────────────────────

async function handleCarousel(
	ctx: IExecuteFunctions,
	userAccessToken: string,
	pageAccessToken: string,
	params: MetaPostParams,
	caption: string,
): Promise<MetaPostResult> {
	const { instagramAccountId, facebookPageId, graphApiVersion, carouselItems, locationId } = params;

	if (carouselItems.length < 2 || carouselItems.length > 10) {
		throw new Error(`Carousel requires 2-10 items, got ${carouselItems.length}`);
	}

	// Step 1: Create child containers for each item.
	// Keep the first converted video buffer in memory so we can mirror it to FB
	// when the carousel has no image items.
	const childIds: string[] = [];
	let firstVideoBuffer: Buffer | undefined;

	for (const item of carouselItems) {
		if (item.mediaType === 'image') {
			const child = await graphApi.createIgCarouselImageItemContainer(
				ctx, userAccessToken, instagramAccountId,
				item.mediaUrl, graphApiVersion,
			);
			childIds.push(child.id);
		} else {
			// Video carousel item: re-encode locally, upload bytes via resumable API
			const videoBuffer = await downloadMedia(ctx, item.mediaUrl);
			const convertedBuffer = await convertVideo(videoBuffer, {
				videoCodec: params.videoCodec,
				crf: params.videoCrf,
				preset: params.videoPreset,
				fps: params.videoFps,
				audioCodec: params.audioCodec,
				audioBitrate: params.audioBitrate,
				audioChannels: params.audioChannels,
				audioSampleRate: params.audioSampleRate,
				maxWidth: params.videoMaxWidth,
				maxHeight: params.videoMaxHeight,
				maxBitrate: params.videoMaxBitrate,
			});

			const child = await graphApi.createIgCarouselVideoItemContainerResumable(
				ctx, userAccessToken, instagramAccountId, graphApiVersion,
			);
			await graphApi.uploadIgVideoBytes(
				ctx, userAccessToken, child.uri, convertedBuffer,
			);
			await pollIgContainer(ctx, userAccessToken, child.id, graphApiVersion);
			childIds.push(child.id);

			if (!firstVideoBuffer) firstVideoBuffer = convertedBuffer;
		}
	}

	// Step 2: Create parent carousel container
	const carouselContainer = await graphApi.createIgCarouselContainer(
		ctx, userAccessToken, instagramAccountId,
		childIds, caption, graphApiVersion, locationId,
	);

	// Step 3: Publish carousel
	const igPost = await publishIgContainerWithRetry(
		ctx, userAccessToken, instagramAccountId, carouselContainer.id, graphApiVersion,
	);

	// Step 4: Mirror the carousel to Facebook.
	// If any image items exist, attach all of them to a single multi-photo feed post.
	// Otherwise (video-only carousel), publish the first video as a standalone FB video.
	const imageItems = carouselItems.filter((item) => item.mediaType === 'image');
	let fbPostId = '';
	if (imageItems.length > 0) {
		// Pre-download + convert each image so the FB upload uses a buffer.
		// FB rejects /photos URL ingestion when the source exceeds 10 MB
		// (subcode 1366046), even for URLs that work fine for Instagram.
		const photoIds = await Promise.all(
			imageItems.map(async (item) => {
				const imageBuffer = await downloadMedia(ctx, item.mediaUrl);
				const convertedBuffer = await convertImage(imageBuffer, {
					maxWidth: params.imageMaxWidth,
					maxHeight: params.imageMaxHeight,
					outputFormat: params.imageOutputFormat,
				});
				const ext = params.imageOutputFormat;
				const mime = ext === 'jpeg' ? 'image/jpeg' : 'image/png';
				const fbPhoto = await graphApi.uploadFbPhotoFromBuffer(
					ctx, pageAccessToken, facebookPageId,
					convertedBuffer, `photo.${ext}`, mime, false, graphApiVersion,
				);
				return fbPhoto.id;
			}),
		);
		const fbFeedPost = await graphApi.createFbFeedPost(
			ctx, pageAccessToken, facebookPageId, caption, photoIds, graphApiVersion, locationId,
		);
		fbPostId = fbFeedPost.id;
	} else if (firstVideoBuffer) {
		const fbVideo = await graphApi.uploadFbVideoFromBuffer(
			ctx, pageAccessToken, facebookPageId,
			firstVideoBuffer, 'video.mp4', caption, true, graphApiVersion, locationId,
		);
		fbPostId = `${facebookPageId}_${fbVideo.id}`;
	}

	// Step 5: Get IG permalink
	const igPermalink = await graphApi.getIgPermalink(
		ctx, userAccessToken, igPost.id, graphApiVersion,
	);

	return {
		instagram_post_id: igPost.id,
		instagram_permalink: igPermalink.permalink,
		facebook_post_id: fbPostId,
		location_id: locationId,
	};
}

// ── Node Definition ────────────────────────────────────────────────

export class MetaPost implements INodeType {
	description: INodeTypeDescription = {
		displayName: 'Meta Post',
		name: 'metaPost',
		icon: 'file:metaPost.svg',
		group: ['output'],
		version: 1,
		subtitle: '={{$parameter["mediaType"] === "image" ? "Post Image" : $parameter["mediaType"] === "video" ? "Post Video" : "Post Carousel"}}',
		description: 'Post images and videos to Facebook Pages and Instagram',
		defaults: {
			name: 'Meta Post',
		},
		inputs: ['main'],
		outputs: ['main'],
		credentials: [
			{
				name: 'facebookGraphApi',
				required: true,
			},
		],
		properties: [
			// ── Core Parameters ──
			{
				displayName: 'Media Type',
				name: 'mediaType',
				type: 'options',
				options: [
					{ name: 'Image', value: 'image' },
					{ name: 'Video', value: 'video' },
					{ name: 'Carousel', value: 'carousel' },
				],
				default: 'image',
				description: 'Type of media to post',
			},
			{
				displayName: 'Media URL',
				name: 'mediaUrl',
				type: 'string',
				default: '',
				required: true,
				description: 'Publicly accessible URL. For carousel: comma-separated URLs (2-10). Video URLs are auto-detected by extension (.mp4, .mov, .avi, .webm).',
			},
			{
				displayName: 'Caption',
				name: 'caption',
				type: 'string',
				typeOptions: { rows: 4 },
				default: '',
				description: 'Post caption text',
			},
			{
				displayName: 'Hash Suffix',
				name: 'hashSuffix',
				type: 'string',
				default: '',
				description: 'Optional hashtag suffix appended to caption',
			},
			{
				displayName: 'Location',
				name: 'location',
				type: 'string',
				default: '',
				description: 'Optional location to tag the post with. Accepts a free-form query (city name, postal code, landmark, e.g. "Berlin", "10115", "Brandenburger Tor") which is resolved via Facebook\'s page search, or a Facebook Place Page ID (10+ digits) to use directly. Applied as location_id on Instagram and place on Facebook.',
			},
			{
				displayName: 'Instagram Account ID',
				name: 'instagramAccountId',
				type: 'string',
				default: '',
				required: true,
				description: 'Instagram Business Account ID',
			},
			{
				displayName: 'Facebook Page ID',
				name: 'facebookPageId',
				type: 'string',
				default: '',
				required: true,
				description: 'Facebook Page ID',
			},
			{
				displayName: 'Graph API Version',
				name: 'graphApiVersion',
				type: 'string',
				default: 'v25.0',
				description: 'Facebook Graph API version to use',
			},

			// ── Image Conversion Settings ──
			{
				displayName: 'Image Conversion Settings',
				name: 'imageSettings',
				type: 'collection',
				placeholder: 'Add Setting',
				default: {},
				displayOptions: { show: { mediaType: ['image'] } },
				description: 'Settings for image conversion (used as fallback when Instagram rejects the format)',
				options: [
					{
						displayName: 'Max Width',
						name: 'imageMaxWidth',
						type: 'number',
						default: 1080,
						description: 'Maximum width in pixels',
					},
					{
						displayName: 'Max Height',
						name: 'imageMaxHeight',
						type: 'number',
						default: 1920,
						description: 'Maximum height in pixels',
					},
					{
						displayName: 'Output Format',
						name: 'imageOutputFormat',
						type: 'options',
						options: [
							{ name: 'JPEG', value: 'jpeg' },
							{ name: 'PNG', value: 'png' },
						],
						default: 'jpeg',
						description: 'Output image format after conversion',
					},
				],
			},

			// ── Video Conversion Settings ──
			{
				displayName: 'Video Conversion Settings',
				name: 'videoSettings',
				type: 'collection',
				placeholder: 'Add Setting',
				default: {},
				displayOptions: { show: { mediaType: ['video', 'carousel'] } },
				description: 'Settings for video conversion (always applied for videos)',
				options: [
					{
						displayName: 'Video Codec',
						name: 'videoCodec',
						type: 'string',
						default: 'libx264',
					},
					{
						displayName: 'CRF (Quality)',
						name: 'videoCrf',
						type: 'number',
						default: 23,
						description: 'Constant Rate Factor (0-51, lower = better quality)',
					},
					{
						displayName: 'Preset',
						name: 'videoPreset',
						type: 'options',
						options: [
							{ name: 'ultrafast', value: 'ultrafast' },
							{ name: 'superfast', value: 'superfast' },
							{ name: 'veryfast', value: 'veryfast' },
							{ name: 'faster', value: 'faster' },
							{ name: 'fast', value: 'fast' },
							{ name: 'medium', value: 'medium' },
							{ name: 'slow', value: 'slow' },
							{ name: 'slower', value: 'slower' },
							{ name: 'veryslow', value: 'veryslow' },
						],
						default: 'medium',
					},
					{
						displayName: 'FPS',
						name: 'videoFps',
						type: 'number',
						default: 30,
					},
					{
						displayName: 'Audio Codec',
						name: 'audioCodec',
						type: 'string',
						default: 'aac',
					},
					{
						displayName: 'Audio Bitrate',
						name: 'audioBitrate',
						type: 'string',
						default: '128k',
					},
					{
						displayName: 'Audio Channels',
						name: 'audioChannels',
						type: 'number',
						default: 2,
					},
					{
						displayName: 'Audio Sample Rate',
						name: 'audioSampleRate',
						type: 'number',
						default: 48000,
					},
					{
						displayName: 'Max Width',
						name: 'videoMaxWidth',
						type: 'number',
						default: 1080,
					},
					{
						displayName: 'Max Height',
						name: 'videoMaxHeight',
						type: 'number',
						default: 1920,
					},
					{
						displayName: 'Max Bitrate',
						name: 'videoMaxBitrate',
						type: 'string',
						default: '4500k',
						description: 'Maximum video bitrate (Instagram Reels limit is 5 Mbps)',
					},
					],
			},

		],
	};

	async execute(this: IExecuteFunctions): Promise<INodeExecutionData[][]> {
		const items = this.getInputData();
		const returnData: INodeExecutionData[] = [];

		for (let i = 0; i < items.length; i++) {
			try {
				const credentials = await this.getCredentials('facebookGraphApi');
				const userAccessToken = credentials.accessToken as string;

				const params = await readParams(this, i);
				const caption = prepareCaption(params.caption, params.hashSuffix);

				// Get page access token
				const pageTokenResp = await graphApi.getPageAccessToken(
					this, userAccessToken, params.facebookPageId, params.graphApiVersion,
				);
				const pageAccessToken = pageTokenResp.access_token;

				// Resolve optional location to a Facebook Place ID (shared by IG location_id and FB place)
				if (params.location && params.location.trim().length > 0) {
					params.locationId = await graphApi.searchPlaceId(
						this, userAccessToken, params.location, params.graphApiVersion,
					);
				}

				let result: MetaPostResult;
				if (params.mediaType === 'image') {
					result = await handleImage(this, userAccessToken, pageAccessToken, params, caption);
				} else if (params.mediaType === 'video') {
					result = await handleVideo(this, userAccessToken, pageAccessToken, params, caption);
				} else {
					result = await handleCarousel(this, userAccessToken, pageAccessToken, params, caption);
				}

				returnData.push({
					json: result as unknown as IDataObject,
					pairedItem: i,
				});
			} catch (error) {
				const err = error as any;
				const detail =
					err.description ||
					err.cause?.body?.error?.message ||
					err.message ||
					'Unknown error';
				if (this.continueOnFail()) {
					returnData.push({
						json: { error: detail },
						pairedItem: i,
					});
				} else {
					throw new NodeOperationError(this.getNode(), detail, { itemIndex: i });
				}
			}
		}

		return [returnData];
	}
}
