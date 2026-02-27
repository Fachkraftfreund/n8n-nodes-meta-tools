import type {
	IDataObject,
	IExecuteFunctions,
	INodeExecutionData,
	INodeType,
	INodeTypeDescription,
} from 'n8n-workflow';
import { NodeOperationError } from 'n8n-workflow';

import type { MetaPostParams, MetaPostResult } from './types';
import * as graphApi from './utils/graphApi';
import { convertImage, convertVideo, downloadMedia } from './utils/ffmpeg';
import { startTempVideoServer } from './utils/tempServer';

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
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

		// Don't retry permanent client errors (4xx) — only retry server errors (5xx)
		if (resp.statusCode >= 400 && resp.statusCode < 500) {
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

function readParams(ctx: IExecuteFunctions, i: number): MetaPostParams {
	const mediaType = ctx.getNodeParameter('mediaType', i) as string;
	const imageSettings = ctx.getNodeParameter('imageSettings', i, {}) as IDataObject;
	const videoSettings = ctx.getNodeParameter('videoSettings', i, {}) as IDataObject;

	return {
		mediaType: mediaType as 'image' | 'video',
		mediaUrl: ctx.getNodeParameter('mediaUrl', i) as string,
		caption: ctx.getNodeParameter('caption', i, '') as string,
		hashSuffix: ctx.getNodeParameter('hashSuffix', i, '') as string,
		instagramAccountId: ctx.getNodeParameter('instagramAccountId', i) as string,
		facebookPageId: ctx.getNodeParameter('facebookPageId', i) as string,
		graphApiVersion: ctx.getNodeParameter('graphApiVersion', i, 'v23.0') as string,
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
	const { instagramAccountId, facebookPageId, graphApiVersion, mediaUrl } = params;

	let fbPhotoId: string | undefined;
	let igContainerId: string;

	// Step 1: Try creating IG container with original URL
	// Use ignoreHttpStatusErrors + returnFullResponse so we can inspect the response
	// for format errors (Instagram rejects certain image formats like WebP)
	const containerResp = await graphApi.tryCreateIgImageContainer(
		ctx, userAccessToken, instagramAccountId, mediaUrl, caption, graphApiVersion,
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
			ctx, userAccessToken, instagramAccountId, cdnUrl, caption, graphApiVersion,
		);
		igContainerId = retryContainer.id;
	}

	// Step 3: Publish IG post (retry – container may still be processing)
	const igPost = await publishIgContainerWithRetry(
		ctx, userAccessToken, instagramAccountId, igContainerId, graphApiVersion,
	);

	// Step 4: Upload photo to Facebook (if not already done during conversion)
	if (!fbPhotoId) {
		const fbPhoto = await graphApi.uploadFbPhotoFromUrl(
			ctx, pageAccessToken, facebookPageId, mediaUrl, false, graphApiVersion,
		);
		fbPhotoId = fbPhoto.id;
	}

	// Step 5: Create Facebook feed post with attached photo
	const fbFeedPost = await graphApi.createFbFeedPost(
		ctx, pageAccessToken, facebookPageId, caption, fbPhotoId, graphApiVersion,
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
	};
}

// ── Video Flow ─────────────────────────────────────────────────────

async function pollIgContainer(
	ctx: IExecuteFunctions,
	userAccessToken: string,
	containerId: string,
	apiVersion: string,
): Promise<void> {
	const maxPolls = 30;
	const pollInterval = 10000;

	for (let attempt = 0; attempt < maxPolls; attempt++) {
		await sleep(pollInterval);
		const status = await graphApi.getIgContainerStatus(
			ctx, userAccessToken, containerId, apiVersion,
		);

		if (status.status_code === 'FINISHED') return;

		if (status.status_code === 'ERROR' || status.status_code === 'EXPIRED') {
			throw new Error(
				`Instagram Reel processing failed: ${status.status || status.status_code}. ` +
				'Ensure the video URL is publicly accessible and the video meets Instagram Reels ' +
				'requirements (MP4 H.264, max 5 Mbps bitrate, max 90s, 9:16 aspect ratio recommended).',
			);
		}
	}

	throw new Error('Instagram Reel processing timed out after 5 minutes of polling');
}

async function handleVideo(
	ctx: IExecuteFunctions,
	userAccessToken: string,
	pageAccessToken: string,
	params: MetaPostParams,
	caption: string,
): Promise<MetaPostResult> {
	const { instagramAccountId, facebookPageId, graphApiVersion, mediaUrl } = params;

	// Step 1: Download and convert video
	const videoBuffer = await downloadMedia(ctx, mediaUrl);
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

	// Step 2: Serve the re-encoded video through n8n's own HTTP server.
	// This piggybacks on n8n's existing public URL so no extra port is needed.
	const instanceBaseUrl = ctx.getInstanceBaseUrl();
	const tempServer = await startTempVideoServer(convertedBuffer, instanceBaseUrl);
	const igVideoUrl = tempServer.url;

	// Step 3: Upload converted video to Facebook (published) — runs in parallel with IG flow
	const fbVideoPromise = graphApi.uploadFbVideoFromBuffer(
		ctx, pageAccessToken, facebookPageId,
		convertedBuffer, 'video.mp4', caption, true, graphApiVersion,
	);

	// Step 4-6: IG flow — wrapped in try-catch to clean up FB video on failure
	let igPost: { id: string };
	try {
		// Step 4: Create IG Reel container
		const igContainer = await graphApi.createIgReelContainer(
			ctx, userAccessToken, instagramAccountId,
			igVideoUrl, caption, graphApiVersion,
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
	} finally {
		// Always shut down the temp server
		await tempServer.close();
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
		subtitle: '={{$parameter["mediaType"] === "image" ? "Post Image" : "Post Video"}}',
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
				description: 'Publicly accessible URL of the image or video',
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
				default: 'v23.0',
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
				displayOptions: { show: { mediaType: ['video'] } },
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

				const params = readParams(this, i);
				const caption = prepareCaption(params.caption, params.hashSuffix);

				// Get page access token
				const pageTokenResp = await graphApi.getPageAccessToken(
					this, userAccessToken, params.facebookPageId, params.graphApiVersion,
				);
				const pageAccessToken = pageTokenResp.access_token;

				let result: MetaPostResult;
				if (params.mediaType === 'image') {
					result = await handleImage(this, userAccessToken, pageAccessToken, params, caption);
				} else {
					result = await handleVideo(this, userAccessToken, pageAccessToken, params, caption);
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
