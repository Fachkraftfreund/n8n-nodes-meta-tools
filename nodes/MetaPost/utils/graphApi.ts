import type { IExecuteFunctions } from 'n8n-workflow';
import type {
	PageTokenResponse,
	IgContainerResponse,
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

export async function createIgReelContainer(
	ctx: IExecuteFunctions,
	userAccessToken: string,
	igAccountId: string,
	videoUrl: string,
	caption: string,
	apiVersion: string,
	coverUrl?: string,
	locationId?: string,
): Promise<IgContainerResponse> {
	const qs: Record<string, string> = {
		video_url: videoUrl,
		media_type: 'REELS',
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
	}) as Promise<IgContainerResponse>;
}

// ── Instagram: Carousel ─────────────────────────────────────────────

export async function createIgCarouselItemContainer(
	ctx: IExecuteFunctions,
	userAccessToken: string,
	igAccountId: string,
	mediaUrl: string,
	mediaType: 'image' | 'video',
	apiVersion: string,
): Promise<IgContainerResponse> {
	const qs: Record<string, string> = {
		is_carousel_item: 'true',
		access_token: userAccessToken,
	};
	if (mediaType === 'image') {
		qs.image_url = mediaUrl;
	} else {
		qs.video_url = mediaUrl;
	}
	return ctx.helpers.httpRequest({
		method: 'POST',
		url: `${GRAPH_BASE}/${apiVersion}/${igAccountId}/media`,
		qs,
	}) as Promise<IgContainerResponse>;
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
): Promise<FbVideoResponse> {
	const formData = new FormData();
	formData.append('source', new Blob([buffer], { type: 'video/mp4' }), filename);
	formData.append('description', description);
	formData.append('published', published.toString());
	if (placeId) formData.append('place', placeId);
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
	mediaFbId: string,
	apiVersion: string,
	placeId?: string,
): Promise<FbFeedPostResponse> {
	const formData = new FormData();
	formData.append('message', message);
	formData.append('attached_media[0]', JSON.stringify({ media_fbid: mediaFbId }));
	if (placeId) formData.append('place', placeId);
	formData.append('access_token', pageAccessToken);

	return ctx.helpers.httpRequest({
		method: 'POST',
		url: `${GRAPH_BASE}/${apiVersion}/${pageId}/feed`,
		body: formData,
	}) as Promise<FbFeedPostResponse>;
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
