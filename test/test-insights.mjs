/**
 * Integration test: calls each Meta Insights endpoint to verify they work.
 *
 * Usage:  node test/test-insights.mjs
 * Requires: .env in project root (USER_ACCESS_TOKEN, FACEBOOK_PAGE_ID, INSTAGRAM_ACCOUNT_ID, GRAPH_API_VERSION)
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
const ACCESS_TOKEN = process.env.USER_ACCESS_TOKEN;
const PAGE_ID      = process.env.FACEBOOK_PAGE_ID;
const IG_ACCOUNT   = process.env.INSTAGRAM_ACCOUNT_ID;
const API_VERSION  = process.env.GRAPH_API_VERSION || 'v25.0';
const GRAPH        = 'https://graph.facebook.com';

if (!ACCESS_TOKEN) {
	console.error('Missing USER_ACCESS_TOKEN in .env');
	process.exit(1);
}

// ── Helper ────────────────────────────────────────────────────────

async function api(label, path, params = {}) {
	const qs = new URLSearchParams({ access_token: ACCESS_TOKEN, ...params });
	const url = `${GRAPH}/${API_VERSION}${path}?${qs}`;
	console.log(`\n── ${label} ──`);
	console.log(`→ GET ${GRAPH}/${API_VERSION}${path}`);
	console.log('  params:', JSON.stringify(params));

	const res = await fetch(url);
	const json = await res.json();

	if (!res.ok) {
		console.error(`  ✗ HTTP ${res.status}:`, JSON.stringify(json, null, 2));
		return null;
	}

	const preview = JSON.stringify(json, null, 2);
	console.log(`  ✓ Response (${preview.length > 800 ? 'truncated' : 'full'}):`);
	console.log(preview.slice(0, 800));
	return json;
}

// ── Main ──────────────────────────────────────────────────────────

async function main() {
	console.log('=== Meta Insights Integration Test ===');
	console.log(`API Version: ${API_VERSION}`);
	console.log(`Page ID:     ${PAGE_ID}`);
	console.log(`IG Account:  ${IG_ACCOUNT}`);

	// 1. Discover ad account ID
	const adAccounts = await api(
		'Discover Ad Accounts',
		'/me/adaccounts',
		{ fields: 'id,name,account_status' },
	);
	let adAccountId = null;
	if (adAccounts?.data?.length > 0) {
		adAccountId = adAccounts.data[0].id;
		console.log(`  → Using: ${adAccountId} (${adAccounts.data[0].name})`);
	} else {
		console.log('  ⚠ No ad accounts found – skipping ads tests');
	}

	// 2. Facebook Ads Insights – Account Level
	if (adAccountId) {
		await api('FB Ads Insights (Account)', `/${adAccountId}/insights`, {
			fields: 'spend,impressions,reach,clicks,video_play_actions,actions,cpm,cpc,ctr,frequency',
			date_preset: 'last_week_mon_sun',
			level: 'account',
		});
	}

	// 3. Facebook Ads Insights – Campaign Level
	if (adAccountId) {
		await api('FB Ads Insights (Campaign)', `/${adAccountId}/insights`, {
			fields: 'campaign_name,spend,impressions,reach,clicks,video_play_actions,actions,cpm,cpc,ctr,frequency',
			date_preset: 'last_week_mon_sun',
			level: 'campaign',
		});
	}

	// 4. Facebook Page Insights
	if (PAGE_ID) {
		await api('FB Page Insights', `/${PAGE_ID}/insights`, {
			metric: 'page_impressions,page_impressions_unique,page_post_engagements,page_follows',
			period: 'week',
		});
	} else {
		console.log('\n  ⚠ No FACEBOOK_PAGE_ID – skipping');
	}

	// 5. Instagram Insights
	if (IG_ACCOUNT) {
		await api('Instagram Insights', `/${IG_ACCOUNT}/insights`, {
			metric: 'impressions,reach',
			period: 'week',
		});
	} else {
		console.log('\n  ⚠ No INSTAGRAM_ACCOUNT_ID – skipping');
	}

	// 6. Instagram Profile Info
	if (IG_ACCOUNT) {
		await api('Instagram Profile Info', `/${IG_ACCOUNT}`, {
			fields: 'followers_count,username',
		});
	} else {
		console.log('\n  ⚠ No INSTAGRAM_ACCOUNT_ID – skipping');
	}

	console.log('\n\n=== Done ===');
}

main().catch((err) => {
	console.error('Fatal:', err);
	process.exit(1);
});
