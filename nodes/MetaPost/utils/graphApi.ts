import type { IExecuteFunctions } from 'n8n-workflow';
import type {
	PageTokenResponse,
	IgContainerResponse,
	IgPublishResponse,
	IgPermalinkResponse,
	IgStatusResponse,
	FbPhotoResponse,
	FbPhotoImagesResponse,
	FbVideoResponse,
	FbVideoSourceResponse,
	FbFeedPostResponse,
} from '../types';

const GRAPH_BASE = 'https://graph.facebook.com';

// ── Page Access Token ──────────────────────────────────────────────

export async function getPageAccessToken(
	ctx: IExecuteFunctions,
	userAccessToken: string,
	facebookPageId: string,
	apiVersion: string,
): Promise<PageTokenResponse> {
	return ctx.helpers.httpRequest({
		method: 'GET',
		url: `${GRAPH_BASE}/${apiVersion}/${facebookPageId}`,
		qs: { fields: 'access_token', access_token: userAccessToken },
	}) as Promise<PageTokenResponse>;
}

// ── Instagram: Container Creation ──────────────────────────────────

export async function createIgImageContainer(
	ctx: IExecuteFunctions,
	userAccessToken: string,
	igAccountId: string,
	imageUrl: string,
	caption: string,
	apiVersion: string,
): Promise<IgContainerResponse> {
	return ctx.helpers.httpRequest({
		method: 'POST',
		url: `${GRAPH_BASE}/${apiVersion}/${igAccountId}/media`,
		qs: { image_url: imageUrl, caption, access_token: userAccessToken },
	}) as Promise<IgContainerResponse>;
}

export async function createIgReelContainer(
	ctx: IExecuteFunctions,
	userAccessToken: string,
	igAccountId: string,
	videoUrl: string,
	caption: string,
	apiVersion: string,
): Promise<IgContainerResponse> {
	return ctx.helpers.httpRequest({
		method: 'POST',
		url: `${GRAPH_BASE}/${apiVersion}/${igAccountId}/media`,
		qs: {
			video_url: videoUrl,
			media_type: 'REELS',
			share_to_feed: 'true',
			caption,
			access_token: userAccessToken,
		},
	}) as Promise<IgContainerResponse>;
}

// ── Instagram: Status Polling ──────────────────────────────────────

export async function getIgContainerStatus(
	ctx: IExecuteFunctions,
	userAccessToken: string,
	containerId: string,
	apiVersion: string,
): Promise<IgStatusResponse> {
	return ctx.helpers.httpRequest({
		method: 'GET',
		url: `${GRAPH_BASE}/${apiVersion}/${containerId}`,
		qs: { fields: 'status_code', access_token: userAccessToken },
	}) as Promise<IgStatusResponse>;
}

// ── Instagram: Publish ─────────────────────────────────────────────

export async function publishIgContainer(
	ctx: IExecuteFunctions,
	userAccessToken: string,
	igAccountId: string,
	creationId: string,
	apiVersion: string,
): Promise<IgPublishResponse> {
	return ctx.helpers.httpRequest({
		method: 'POST',
		url: `${GRAPH_BASE}/${apiVersion}/${igAccountId}/media_publish`,
		qs: { creation_id: creationId, access_token: userAccessToken },
	}) as Promise<IgPublishResponse>;
}

// ── Instagram: Permalink ───────────────────────────────────────────

export async function getIgPermalink(
	ctx: IExecuteFunctions,
	userAccessToken: string,
	igPostId: string,
	apiVersion: string,
): Promise<IgPermalinkResponse> {
	return ctx.helpers.httpRequest({
		method: 'GET',
		url: `${GRAPH_BASE}/${apiVersion}/${igPostId}`,
		qs: { fields: 'permalink', access_token: userAccessToken },
	}) as Promise<IgPermalinkResponse>;
}

// ── Facebook: Photo Upload ─────────────────────────────────────────

export async function uploadFbPhotoFromUrl(
	ctx: IExecuteFunctions,
	pageAccessToken: string,
	pageId: string,
	imageUrl: string,
	published: boolean,
	apiVersion: string,
): Promise<FbPhotoResponse> {
	return ctx.helpers.httpRequest({
		method: 'POST',
		url: `${GRAPH_BASE}/${apiVersion}/${pageId}/photos`,
		qs: {
			url: imageUrl,
			published: published.toString(),
			access_token: pageAccessToken,
		},
	}) as Promise<FbPhotoResponse>;
}

export async function uploadFbPhotoFromBuffer(
	ctx: IExecuteFunctions,
	pageAccessToken: string,
	pageId: string,
	buffer: Buffer,
	filename: string,
	mimeType: string,
	published: boolean,
	apiVersion: string,
): Promise<FbPhotoResponse> {
	const formData = new FormData();
	formData.append('source', new Blob([buffer], { type: mimeType }), filename);
	formData.append('published', published.toString());
	formData.append('access_token', pageAccessToken);

	return ctx.helpers.httpRequest({
		method: 'POST',
		url: `${GRAPH_BASE}/${apiVersion}/${pageId}/photos`,
		body: formData,
	}) as Promise<FbPhotoResponse>;
}

export async function getFbPhotoImages(
	ctx: IExecuteFunctions,
	pageAccessToken: string,
	photoId: string,
	apiVersion: string,
): Promise<FbPhotoImagesResponse> {
	return ctx.helpers.httpRequest({
		method: 'GET',
		url: `${GRAPH_BASE}/${apiVersion}/${photoId}`,
		qs: { fields: 'images', access_token: pageAccessToken },
	}) as Promise<FbPhotoImagesResponse>;
}

// ── Facebook: Video Upload ─────────────────────────────────────────

export async function uploadFbVideoFromBuffer(
	ctx: IExecuteFunctions,
	pageAccessToken: string,
	pageId: string,
	buffer: Buffer,
	filename: string,
	description: string,
	published: boolean,
	apiVersion: string,
): Promise<FbVideoResponse> {
	const formData = new FormData();
	formData.append('source', new Blob([buffer], { type: 'video/mp4' }), filename);
	formData.append('description', description);
	formData.append('published', published.toString());
	formData.append('access_token', pageAccessToken);

	return ctx.helpers.httpRequest({
		method: 'POST',
		url: `${GRAPH_BASE}/${apiVersion}/${pageId}/videos`,
		body: formData,
	}) as Promise<FbVideoResponse>;
}

export async function getFbVideoSource(
	ctx: IExecuteFunctions,
	pageAccessToken: string,
	videoId: string,
	apiVersion: string,
): Promise<FbVideoSourceResponse> {
	return ctx.helpers.httpRequest({
		method: 'GET',
		url: `${GRAPH_BASE}/${apiVersion}/${videoId}`,
		qs: { fields: 'source', access_token: pageAccessToken },
	}) as Promise<FbVideoSourceResponse>;
}

// ── Facebook: Feed Post ────────────────────────────────────────────

export async function createFbFeedPost(
	ctx: IExecuteFunctions,
	pageAccessToken: string,
	pageId: string,
	message: string,
	mediaFbId: string,
	apiVersion: string,
): Promise<FbFeedPostResponse> {
	return ctx.helpers.httpRequest({
		method: 'POST',
		url: `${GRAPH_BASE}/${apiVersion}/${pageId}/feed`,
		headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
		body: new URLSearchParams({
			message,
			'attached_media[0]': JSON.stringify({ media_fbid: mediaFbId }),
			access_token: pageAccessToken,
		}).toString(),
	}) as Promise<FbFeedPostResponse>;
}
