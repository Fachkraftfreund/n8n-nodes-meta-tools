export interface MetaPostParams {
	mediaType: 'image' | 'video';
	mediaUrl: string;
	caption: string;
	hashSuffix: string;
	instagramAccountId: string;
	facebookPageId: string;
	graphApiVersion: string;
	// Image conversion settings
	imageMaxWidth: number;
	imageMaxHeight: number;
	imageOutputFormat: 'jpeg' | 'png';
	// Video conversion settings
	videoCodec: string;
	videoCrf: number;
	videoPreset: string;
	videoFps: number;
	audioCodec: string;
	audioBitrate: string;
	audioChannels: number;
	audioSampleRate: number;
	videoMaxWidth: number;
	videoMaxHeight: number;
	videoMaxBitrate: string;
	// Temporary video serving (for Instagram re-encoded uploads)
	videoServeUrl: string;
	videoServePort: number;
}

export interface MetaPostResult {
	instagram_post_id: string;
	instagram_permalink: string;
	facebook_post_id: string;
	facebook_photo_id?: string;
	facebook_video_id?: string;
}

export interface PageTokenResponse {
	id: string;
	access_token: string;
}

export interface IgContainerResponse {
	id: string;
}

export interface IgPublishResponse {
	id: string;
}

export interface IgPermalinkResponse {
	id: string;
	permalink: string;
}

export interface IgStatusResponse {
	id: string;
	status_code: 'EXPIRED' | 'ERROR' | 'FINISHED' | 'IN_PROGRESS' | 'PUBLISHED';
	status?: string;
}

export interface FbPhotoResponse {
	id: string;
	post_id?: string;
}

export interface FbPhotoImagesResponse {
	id: string;
	images: Array<{ source: string; width: number; height: number }>;
}

export interface FbVideoResponse {
	id: string;
}

export interface FbVideoSourceResponse {
	id: string;
	source: string;
}

export interface FbFeedPostResponse {
	id: string;
}
