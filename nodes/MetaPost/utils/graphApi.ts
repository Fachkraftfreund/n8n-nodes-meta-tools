import type { IExecuteFunctions } from 'n8n-workflow';
import type {
	PageTokenResponse,
	IgContainerResponse,
	IgResumableContainerResponse,
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
	const resp = (await ctx.helpers.httpRequest({
		method: 'GET',
		url: `${GRAPH_BASE}/${apiVersion}/${facebookPageId}`,
		qs: { fields: 'access_token', access_token: userAccessToken },
		ignoreHttpStatusErrors: true,
		returnFullResponse: true,
	})) as FullResponse;
	if (resp.statusCode >= 400) {
		const apiErr = resp.body?.error;
		const msg = apiErr
			? `Graph API error ${apiErr.code || resp.statusCode}: ${apiErr.message}`
			: `HTTP ${resp.statusCode}: ${JSON.stringify(resp.body)}`;
		throw new Error(`Failed to get page access token for ${facebookPageId}: ${msg}`);
	}
	if (!resp.body?.access_token) {
		throw new Error(
			`No page access token returned for ${facebookPageId}. ` +
			'Ensure the token has pages_show_list and pages_read_engagement permissions, ' +
			'and that the user manages this page.',
		);
	}
	return resp.body as PageTokenResponse;
}

// ── Instagram: Container Creation ──────────────────────────────────

export interface FullResponse {
	body: any;
	headers: Record<string, string>;
	statusCode: number;
}

export async function tryCreateIgImageContainer(
	ctx: IExecuteFunctions,
	userAccessToken: string,
	igAccountId: string,
	imageUrl: string,
	caption: string,
	apiVersion: string,
	locationId?: string,
): Promise<FullResponse> {
	const qs: Record<string, string> = { image_url: imageUrl, caption, access_token: userAccessToken };
	if (locationId) qs.location_id = locationId;
	return ctx.helpers.httpRequest({
		method: 'POST',
		url: `${GRAPH_BASE}/${apiVersion}/${igAccountId}/media`,
		qs,
		ignoreHttpStatusErrors: true,
		returnFullResponse: true,
	}) as Promise<FullResponse>;
}

export async function createIgImageContainer(
	ctx: IExecuteFunctions,
	userAccessToken: string,
	igAccountId: string,
	imageUrl: string,
	caption: string,
	apiVersion: string,
	locationId?: string,
): Promise<IgContainerResponse> {
	const qs: Record<string, string> = { image_url: imageUrl, caption, access_token: userAccessToken };
	if (locationId) qs.location_id = locationId;
	return ctx.helpers.httpRequest({
		method: 'POST',
		url: `${GRAPH_BASE}/${apiVersion}/${igAccountId}/media`,
		qs,
	}) as Promise<IgContainerResponse>;
}

/**
 * Create an IG Reel container using the resumable upload flow.
 * Returns { id, uri } — POST the video bytes to `uri` via uploadIgReelBytes().
 *
 * This avoids needing a public video URL, which is required when n8n runs in
 * task-runner mode (workflow runs in a separate process from the public HTTP server).
 */
export async function createIgReelContainerResumable(
	ctx: IExecuteFunctions,
	userAccessToken: string,
	igAccountId: string,
	caption: string,
	apiVersion: string,
	coverUrl?: string,
	locationId?: string,
): Promise<IgResumableContainerResponse> {
	const qs: Record<string, string> = {
		media_type: 'REELS',
		upload_type: 'resumable',
		share_to_feed: 'true',
		caption,
		access_token: userAccessToken,
	};
	if (coverUrl) {
		qs.cover_url = coverUrl;
	}
	if (locationId) {
		qs.location_id = locationId;
	}
	return ctx.helpers.httpRequest({
		method: 'POST',
		url: `${GRAPH_BASE}/${apiVersion}/${igAccountId}/media`,
		qs,
	}) as Promise<IgResumableContainerResponse>;
}

/**
 * Upload video bytes to the resumable upload URI returned by
 * createIgReelContainerResumable() / createIgCarouselVideoItemContainerResumable().
 */
export async function uploadIgVideoBytes(
	ctx: IExecuteFunctions,
	userAccessToken: string,
	uploadUri: string,
	buffer: Buffer,
): Promise<void> {
	await ctx.helpers.httpRequest({
		method: 'POST',
		url: uploadUri,
		headers: {
			Authorization: `OAuth ${userAccessToken}`,
			offset: '0',
			file_size: buffer.length.toString(),
			'Content-Type': 'application/octet-stream',
		},
		body: buffer,
	});
}

// ── Instagram: Carousel ─────────────────────────────────────────────

export async function createIgCarouselImageItemContainer(
	ctx: IExecuteFunctions,
	userAccessToken: string,
	igAccountId: string,
	imageUrl: string,
	apiVersion: string,
): Promise<IgContainerResponse> {
	return ctx.helpers.httpRequest({
		method: 'POST',
		url: `${GRAPH_BASE}/${apiVersion}/${igAccountId}/media`,
		qs: {
			is_carousel_item: 'true',
			image_url: imageUrl,
			access_token: userAccessToken,
		},
	}) as Promise<IgContainerResponse>;
}

/**
 * Create a resumable upload container for a carousel video item.
 * Returns { id, uri } — POST the video bytes to `uri` via uploadIgVideoBytes().
 */
export async function createIgCarouselVideoItemContainerResumable(
	ctx: IExecuteFunctions,
	userAccessToken: string,
	igAccountId: string,
	apiVersion: string,
): Promise<IgResumableContainerResponse> {
	return ctx.helpers.httpRequest({
		method: 'POST',
		url: `${GRAPH_BASE}/${apiVersion}/${igAccountId}/media`,
		qs: {
			is_carousel_item: 'true',
			media_type: 'VIDEO',
			upload_type: 'resumable',
			access_token: userAccessToken,
		},
	}) as Promise<IgResumableContainerResponse>;
}

export async function createIgCarouselContainer(
	ctx: IExecuteFunctions,
	userAccessToken: string,
	igAccountId: string,
	childIds: string[],
	caption: string,
	apiVersion: string,
	locationId?: string,
): Promise<IgContainerResponse> {
	const qs: Record<string, string> = {
		media_type: 'CAROUSEL',
		children: childIds.join(','),
		caption,
		access_token: userAccessToken,
	};
	if (locationId) qs.location_id = locationId;
	return ctx.helpers.httpRequest({
		method: 'POST',
		url: `${GRAPH_BASE}/${apiVersion}/${igAccountId}/media`,
		qs,
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
		qs: { fields: 'status_code,status', access_token: userAccessToken },
	}) as Promise<IgStatusResponse>;
}

// ── Instagram: Publish ─────────────────────────────────────────────

export async function publishIgContainer(
	ctx: IExecuteFunctions,
	userAccessToken: string,
	igAccountId: string,
	creationId: string,
	apiVersion: string,
): Promise<FullResponse> {
	return ctx.helpers.httpRequest({
		method: 'POST',
		url: `${GRAPH_BASE}/${apiVersion}/${igAccountId}/media_publish`,
		qs: { creation_id: creationId, access_token: userAccessToken },
		ignoreHttpStatusErrors: true,
		returnFullResponse: true,
	}) as Promise<FullResponse>;
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
	const formData = new FormData();
	formData.append('published', published.toString());
	formData.append('url', imageUrl);
	formData.append('access_token', pageAccessToken);

	return ctx.helpers.httpRequest({
		method: 'POST',
		url: `${GRAPH_BASE}/${apiVersion}/${pageId}/photos`,
		body: formData,
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
	placeId?: string,
	thumbnail?: { buffer: Buffer; mimeType: string; filename: string },
): Promise<FbVideoResponse> {
	const formData = new FormData();
	formData.append('source', new Blob([buffer], { type: 'video/mp4' }), filename);
	formData.append('description', description);
	formData.append('published', published.toString());
	if (placeId) formData.append('place', placeId);
	if (thumbnail) {
		formData.append(
			'thumb',
			new Blob([thumbnail.buffer], { type: thumbnail.mimeType }),
			thumbnail.filename,
		);
	}
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

// ── Facebook: Delete Video ─────────────────────────────────────────

export async function deleteFbVideo(
	ctx: IExecuteFunctions,
	pageAccessToken: string,
	videoId: string,
	apiVersion: string,
): Promise<void> {
	await ctx.helpers.httpRequest({
		method: 'DELETE',
		url: `${GRAPH_BASE}/${apiVersion}/${videoId}`,
		qs: { access_token: pageAccessToken },
	});
}

// ── Facebook: Feed Post ────────────────────────────────────────────

export async function createFbFeedPost(
	ctx: IExecuteFunctions,
	pageAccessToken: string,
	pageId: string,
	message: string,
	mediaFbIds: string | string[],
	apiVersion: string,
	placeId?: string,
): Promise<FbFeedPostResponse> {
	const ids = Array.isArray(mediaFbIds) ? mediaFbIds : [mediaFbIds];

	// Retry on transient Graph API errors (codes 1, 2 — "Please reduce the amount
	// of data" / "Service temporarily unavailable"). Photo upload often races feed
	// post creation; the second attempt almost always succeeds.
	let lastErr: unknown;
	for (let attempt = 1; attempt <= 4; attempt++) {
		const formData = new FormData();
		formData.append('message', message);
		ids.forEach((id, idx) => {
			formData.append(`attached_media[${idx}]`, JSON.stringify({ media_fbid: id }));
		});
		if (placeId) formData.append('place', placeId);
		formData.append('access_token', pageAccessToken);

		const resp = (await ctx.helpers.httpRequest({
			method: 'POST',
			url: `${GRAPH_BASE}/${apiVersion}/${pageId}/feed`,
			body: formData,
			ignoreHttpStatusErrors: true,
			returnFullResponse: true,
		})) as FullResponse;

		if (resp.statusCode >= 200 && resp.statusCode < 300 && resp.body?.id) {
			return resp.body as FbFeedPostResponse;
		}

		const code = resp.body?.error?.code;
		const msg = resp.body?.error?.message || JSON.stringify(resp.body);
		lastErr = new Error(`Facebook feed post failed (HTTP ${resp.statusCode}, code ${code}): ${msg}`);

		// Retry only on transient codes (1 = API_UNKNOWN, 2 = API_SERVICE, 4 = rate limit)
		const retryable = code === 1 || code === 2 || code === 4 || resp.statusCode >= 500;
		if (!retryable || attempt === 4) break;
		await new Promise((r) => setTimeout(r, attempt * 2000));
	}
	throw lastErr;
}

// ── Location Search ─────────────────────────────────────────────────

export async function searchPlaceId(
	ctx: IExecuteFunctions,
	userAccessToken: string,
	query: string,
	apiVersion: string,
): Promise<string> {
	const trimmed = query.trim();
	if (!trimmed) {
		throw new Error('Location query is empty');
	}

	// If the input looks like a Facebook Page ID (long numeric), use it directly.
	// Short numeric strings like German PLZ (5 digits) fall through to search.
	if (/^\d{10,}$/.test(trimmed)) return trimmed;

	const resp = (await ctx.helpers.httpRequest({
		method: 'GET',
		url: `${GRAPH_BASE}/${apiVersion}/pages/search`,
		qs: { q: trimmed, fields: 'id,name,location', access_token: userAccessToken },
		ignoreHttpStatusErrors: true,
		returnFullResponse: true,
	})) as FullResponse;

	if (resp.statusCode >= 400) {
		const apiErr = resp.body?.error;
		const msg = apiErr
			? `Graph API error ${apiErr.code || resp.statusCode}: ${apiErr.message}`
			: `HTTP ${resp.statusCode}: ${JSON.stringify(resp.body)}`;
		throw new Error(`Failed to search for location "${trimmed}": ${msg}`);
	}

	const results: Array<{ id: string; name?: string; location?: unknown }> = resp.body?.data ?? [];
	const withLocation = results.find((r) => r.location);
	if (!withLocation) {
		throw new Error(
			`No location found for "${trimmed}". Try a more specific query (e.g. a city name, landmark, ` +
			'or a combination like "10115 Berlin"). You can also supply a Facebook Place Page ID directly.',
		);
	}
	return withLocation.id;
}
