/**
 * Integration test: calls each Graph API step individually to find which one fails.
 * Cleans up (deletes) all created posts when done.
 *
 * Usage:  node test/test-api.mjs
 * Requires: .env in project root (see template)
 */

import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const envPath = resolve(__dirname, '..', '.env');

// ── Load .env manually (no extra dependency) ──────────────────────
const envContent = readFileSync(envPath, 'utf-8');
for (const line of envContent.split('\n')) {
	const trimmed = line.trim();
	if (!trimmed || trimmed.startsWith('#')) continue;
	const idx = trimmed.indexOf('=');
	if (idx === -1) continue;
	const key = trimmed.slice(0, idx).trim();
	const val = trimmed.slice(idx + 1).trim();
	if (!process.env[key]) process.env[key] = val;
}

// ── Config ────────────────────────────────────────────────────────
const USER_TOKEN = process.env.USER_ACCESS_TOKEN;
const IG_ACCOUNT = process.env.INSTAGRAM_ACCOUNT_ID;
const FB_PAGE = process.env.FACEBOOK_PAGE_ID;
const IMAGE_URL = process.env.IMAGE_URL;
const CAPTION = process.env.CAPTION || 'Automated test – will be deleted';
const API = process.env.GRAPH_API_VERSION || 'v23.0';
const BASE = 'https://graph.facebook.com';

if (!USER_TOKEN || !IG_ACCOUNT || !FB_PAGE || !IMAGE_URL) {
	console.error('❌  Missing required .env values. Please fill in .env first.');
	process.exit(1);
}

// IDs of things we created, so we can clean up
const cleanup = { igPostId: null, fbPhotoId: null, fbFeedPostId: null };

// ── Helpers ───────────────────────────────────────────────────────
async function graphGet(path, params) {
	const url = new URL(`${BASE}/${API}/${path}`);
	for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
	const res = await fetch(url);
	const body = await res.json();
	return { status: res.status, headers: Object.fromEntries(res.headers), body };
}

async function graphPost(path, params) {
	const url = new URL(`${BASE}/${API}/${path}`);
	for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
	const res = await fetch(url, { method: 'POST' });
	const body = await res.json();
	return { status: res.status, headers: Object.fromEntries(res.headers), body };
}

async function graphPostForm(path, formFields) {
	const url = new URL(`${BASE}/${API}/${path}`);
	const fd = new FormData();
	for (const [k, v] of Object.entries(formFields)) fd.append(k, v);
	const res = await fetch(url, { method: 'POST', body: fd });
	const body = await res.json();
	return { status: res.status, headers: Object.fromEntries(res.headers), body };
}

async function graphDelete(path, token) {
	const url = new URL(`${BASE}/${API}/${path}`);
	url.searchParams.set('access_token', token);
	const res = await fetch(url, { method: 'DELETE' });
	const body = await res.json();
	return { status: res.status, body };
}

function step(name) {
	console.log(`\n${'─'.repeat(60)}\n🔹 ${name}\n${'─'.repeat(60)}`);
}

function ok(label, data) {
	console.log(`   ✅ ${label}:`, JSON.stringify(data, null, 2));
}

function fail(label, data) {
	console.log(`   ❌ ${label}:`, JSON.stringify(data, null, 2));
}

// ── Steps (matching the node code flow) ───────────────────────────

async function run() {
	let pageAccessToken;

	// ── 1. Get Page Access Token ──────────────────────────────────
	step('1. Get Page Access Token');
	{
		const r = await graphGet(FB_PAGE, { fields: 'access_token', access_token: USER_TOKEN });
		if (r.status === 200 && r.body.access_token) {
			pageAccessToken = r.body.access_token;
			ok('Page token obtained', { id: r.body.id, token: pageAccessToken.slice(0, 20) + '…' });
		} else {
			fail('Get page token', r);
			return;
		}
	}

	// ── 2. Create Instagram Container ─────────────────────────────
	step('2. Create Instagram Image Container');
	let igContainerId;
	{
		const r = await graphPost(`${IG_ACCOUNT}/media`, {
			image_url: IMAGE_URL,
			caption: CAPTION,
			access_token: USER_TOKEN,
		});
		console.log('   Full response status:', r.status);
		console.log('   Response headers (www-authenticate):', r.headers['www-authenticate'] || '(none)');
		console.log('   Response body:', JSON.stringify(r.body, null, 2));

		if (r.status >= 200 && r.status < 300 && r.body.id) {
			igContainerId = r.body.id;
			ok('Container created', { id: igContainerId });
		} else {
			fail('Container creation failed', { status: r.status, body: r.body });
			console.log('\n   ⚠️  This is likely the step that causes the 400 in the node.');
			console.log('   The node would normally fall through to image conversion here.');
			console.log('   Stopping test – remaining steps require a valid container.');
			return;
		}
	}

	// ── 3. Publish Instagram Post (with retry – container may still be processing)
	step('3. Publish Instagram Container (with retry, up to 5 attempts)');
	let igPostId;
	{
		for (let attempt = 1; attempt <= 5; attempt++) {
			console.log(`   Attempt ${attempt}/5…`);
			const r = await graphPost(`${IG_ACCOUNT}/media_publish`, {
				creation_id: igContainerId,
				access_token: USER_TOKEN,
			});
			if (r.status >= 200 && r.status < 300 && r.body.id) {
				igPostId = r.body.id;
				cleanup.igPostId = igPostId;
				ok('Published', { id: igPostId });
				break;
			} else {
				console.log(`   ⏳ Attempt ${attempt} failed (${r.status}): ${r.body?.error?.message || JSON.stringify(r.body)}`);
				if (attempt < 5) {
					console.log('   Waiting 5s before retry…');
					await new Promise(resolve => setTimeout(resolve, 5000));
				} else {
					fail('Publish failed after 5 attempts', r);
					return;
				}
			}
		}
	}

	// ── 4. Get Instagram Permalink ────────────────────────────────
	step('4. Get Instagram Permalink');
	{
		const r = await graphGet(igPostId, { fields: 'permalink', access_token: USER_TOKEN });
		if (r.status === 200) {
			ok('Permalink', r.body);
		} else {
			fail('Get permalink', r);
		}
	}

	// ── 5. Upload Facebook Photo (unpublished) ────────────────────
	step('5. Upload Facebook Photo (unpublished)');
	let fbPhotoId;
	{
		// Method A: query-string params (how the node originally did it)
		console.log('   Trying with query string params…');
		const rQs = await graphPost(`${FB_PAGE}/photos`, {
			url: IMAGE_URL,
			published: 'false',
			access_token: pageAccessToken,
		});
		console.log('   QS result:', rQs.status, JSON.stringify(rQs.body));

		// Method B: multipart form data (how the workflow does it)
		console.log('   Trying with FormData…');
		const rFd = await graphPostForm(`${FB_PAGE}/photos`, {
			url: IMAGE_URL,
			published: 'false',
			access_token: pageAccessToken,
		});
		console.log('   FormData result:', rFd.status, JSON.stringify(rFd.body));

		// Use whichever worked
		const r = (rFd.status === 200 && rFd.body.id) ? rFd : rQs;
		if (r.status === 200 && r.body.id) {
			fbPhotoId = r.body.id;
			cleanup.fbPhotoId = fbPhotoId;
			ok('Photo uploaded', { id: fbPhotoId });
		} else {
			fail('Photo upload failed with both methods', {});
			return;
		}
	}

	// ── 6. Create Facebook Feed Post ──────────────────────────────
	step('6. Create Facebook Feed Post');
	{
		// Method A: FormData (current node code)
		console.log('   Trying with FormData…');
		const rFd = await graphPostForm(`${FB_PAGE}/feed`, {
			message: CAPTION,
			'attached_media[0]': JSON.stringify({ media_fbid: fbPhotoId }),
			access_token: pageAccessToken,
		});
		console.log('   FormData result:', rFd.status, JSON.stringify(rFd.body));

		if (rFd.status >= 200 && rFd.status < 300 && rFd.body.id) {
			cleanup.fbFeedPostId = rFd.body.id;
			ok('Feed post created', { id: rFd.body.id });
		} else {
			fail('Feed post failed', rFd);
		}
	}

	console.log('\n' + '═'.repeat(60));
	console.log('✅ All steps completed. Created IDs:', cleanup);
}

async function deleteCreated() {
	console.log('\n' + '═'.repeat(60));
	console.log('🧹 Cleaning up test posts…\n');

	// Get page token again for deletion
	const ptr = await graphGet(FB_PAGE, { fields: 'access_token', access_token: USER_TOKEN });
	const pageToken = ptr.body.access_token || USER_TOKEN;

	if (cleanup.fbFeedPostId) {
		const r = await graphDelete(cleanup.fbFeedPostId, pageToken);
		console.log(`   FB feed post ${cleanup.fbFeedPostId}: ${r.body.success ? 'deleted ✅' : 'failed ❌ ' + JSON.stringify(r.body)}`);
	}

	if (cleanup.fbPhotoId) {
		const r = await graphDelete(cleanup.fbPhotoId, pageToken);
		console.log(`   FB photo ${cleanup.fbPhotoId}: ${r.body.success ? 'deleted ✅' : 'failed ❌ ' + JSON.stringify(r.body)}`);
	}

	if (cleanup.igPostId) {
		// Instagram posts are deleted via the IG Content Publishing API
		const r = await graphDelete(cleanup.igPostId, USER_TOKEN);
		console.log(`   IG post ${cleanup.igPostId}: ${r.body.success ? 'deleted ✅' : 'failed ❌ ' + JSON.stringify(r.body)}`);
	}

	console.log('\n🧹 Cleanup done.');
}

// ── Main ──────────────────────────────────────────────────────────
try {
	await run();
} finally {
	await deleteCreated();
}
