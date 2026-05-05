/**
 * Debug the IG account / token state to understand why 2207076 happens
 * for any video URL.
 */
import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const envContent = readFileSync(resolve(__dirname, '..', '.env'), 'utf-8');
for (const line of envContent.split('\n')) {
	const t = line.trim();
	if (!t || t.startsWith('#')) continue;
	const i = t.indexOf('='); if (i === -1) continue;
	process.env[t.slice(0, i).trim()] = t.slice(i + 1).trim();
}

const USER_TOKEN = process.env.USER_ACCESS_TOKEN;
const IG_ACCOUNT = process.env.INSTAGRAM_ACCOUNT_ID;
const FB_PAGE = process.env.FACEBOOK_PAGE_ID;
const API = process.env.GRAPH_API_VERSION || 'v25.0';
const BASE = 'https://graph.facebook.com';

async function gp(path, params, method = 'GET') {
	const url = new URL(`${BASE}/${API}/${path}`);
	for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
	const r = await fetch(url, { method });
	return { status: r.status, body: await r.json() };
}

function show(label, obj) {
	console.log(`\n=== ${label} ===`);
	console.log(JSON.stringify(obj, null, 2));
}

// 1. Inspect the user access token
const tokInfo = await gp('debug_token', { input_token: USER_TOKEN, access_token: USER_TOKEN });
show('Token debug', tokInfo);

// 2. Check user identity
const me = await gp('me', { fields: 'id,name', access_token: USER_TOKEN });
show('Me', me);

// 3. List pages this user manages
const pages = await gp('me/accounts', { fields: 'id,name,access_token,instagram_business_account,tasks', access_token: USER_TOKEN });
show('My pages', pages);

// 4. Get IG account details
const ig = await gp(IG_ACCOUNT, {
	fields: 'id,username,name,profile_picture_url,biography,followers_count,follows_count,media_count',
	access_token: USER_TOKEN,
});
show('IG account', ig);

// 5. Get content publishing limit (this is the key check)
const limit = await gp(`${IG_ACCOUNT}/content_publishing_limit`, { access_token: USER_TOKEN });
show('Content publishing limit (Reels quota)', limit);

// 6. Check FB page state and IG link
const page = await gp(FB_PAGE, {
	fields: 'id,name,instagram_business_account,access_token,verification_status',
	access_token: USER_TOKEN,
});
show('FB Page', page);
