# MetaInsights Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the 3 brand-metric operations in MetaInsights with 4 platform-separated operations that correctly split Facebook and Instagram paid data using the `publisher_platform` breakdown.

**Architecture:** All changes are in one file — `nodes/MetaInsights/MetaInsights.node.ts`. The file has two sections: (1) the `description` object that defines the n8n UI, and (2) the `execute()` method that calls the Graph API. Each task touches one of these sections. New operations (`facebookPaid`, `instagramPaid`, `facebookOrganic`, `instagramOrganic`) replace the old ones (`fbAdsAccount`, `fbPageInsights`, `igInsights`). `fbAdsCampaign` and `igProfile` are untouched.

**Tech Stack:** TypeScript, n8n-workflow types, Facebook Graph API v25.0. No test runner — use `npm run lint` (tsc --noEmit) as type-check gate after each task, `npm run build` at the end.

---

## File Map

| File | Action |
|---|---|
| `nodes/MetaInsights/MetaInsights.node.ts` | Modify — all changes in this plan |

---

### Task 1: Update constants at top of file

**Files:**
- Modify: `nodes/MetaInsights/MetaInsights.node.ts:11-28`

- [ ] **Step 1: Replace the constants block**

Find this exact block at the top of the file (lines 11–28):

```typescript
const DEFAULT_FIELDS: Record<string, string> = {
	fbAdsAccount:
		'spend,impressions,reach,clicks,video_play_actions,actions,cpm,cpc,ctr,frequency,conversions,cost_per_action_type,cost_per_conversion,purchase_roas,website_ctr,unique_clicks,unique_ctr,cost_per_unique_click,outbound_clicks,outbound_clicks_ctr,video_30_sec_watched_actions,video_avg_time_watched_actions',
	fbAdsCampaign:
		'campaign_name,spend,impressions,reach,clicks,video_play_actions,actions,cpm,cpc,ctr,frequency,conversions,cost_per_action_type,cost_per_conversion,purchase_roas,website_ctr,unique_clicks,unique_ctr,cost_per_unique_click,outbound_clicks,outbound_clicks_ctr,video_30_sec_watched_actions,video_avg_time_watched_actions',
	igProfile:
		'followers_count,username,name,biography,website,media_count,profile_picture_url,ig_id',
};

const DEFAULT_METRICS: Record<string, string> = {
	fbPageInsights:
		'page_impressions_unique,page_post_engagements,page_follows,page_daily_follows,page_daily_follows_unique,page_daily_unfollows_unique,page_views_total,page_video_views,page_video_views_unique,page_actions_post_reactions_total,page_total_actions,page_posts_impressions,page_posts_impressions_unique',
	igInsights:
		'reach,follower_count,website_clicks,profile_views,accounts_engaged,total_interactions,likes,comments,shares,saves,replies,follows_and_unfollows,profile_links_taps,views',
};

// IG metrics that use period=day without metric_type (time-series)
const IG_TIME_SERIES_METRICS = new Set(['reach', 'follower_count']);
// All other IG metrics require metric_type=total_value
```

Replace with:

```typescript
const DEFAULT_FIELDS: Record<string, string> = {
	fbAdsCampaign:
		'campaign_name,spend,impressions,reach,clicks,video_play_actions,actions,cpm,cpc,ctr,frequency,conversions,cost_per_action_type,cost_per_conversion,purchase_roas,website_ctr,unique_clicks,unique_ctr,cost_per_unique_click,outbound_clicks,outbound_clicks_ctr,video_30_sec_watched_actions,video_avg_time_watched_actions',
	igProfile:
		'followers_count,username,name,biography,website,media_count,profile_picture_url,ig_id',
};

const PAID_BRAND_FIELDS =
	'spend,impressions,reach,clicks,ctr,cpc,cpm,frequency,video_play_actions,actions';

const DEFAULT_METRICS: Record<string, string> = {
	facebookOrganic:
		'page_impressions_unique,page_posts_impressions,page_post_engagements,page_video_views',
	instagramOrganic:
		'reach,total_interactions,website_clicks,views,follows_and_unfollows',
};

// IG metrics that use period=day without metric_type (time-series, summed over range)
const IG_TIME_SERIES_METRICS = new Set(['reach']);
// All other IG metrics require metric_type=total_value
```

- [ ] **Step 2: Type-check**

```bash
npm run lint
```

Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add nodes/MetaInsights/MetaInsights.node.ts
git commit -m "refactor(MetaInsights): update constants for new operations"
```

---

### Task 2: Replace operations dropdown

**Files:**
- Modify: `nodes/MetaInsights/MetaInsights.node.ts` — the `options` array inside the `operation` property

- [ ] **Step 1: Replace the options array in the operation property**

Find this block inside `properties`:

```typescript
				options: [
					{
						name: 'Facebook Ads Insights (Account)',
						value: 'fbAdsAccount',
						description: 'Account-level ad spend, impressions, reach, etc.',
					},
					{
						name: 'Facebook Ads Insights (Campaign)',
						value: 'fbAdsCampaign',
						description:
							'Campaign/ad-set/ad level insights with optional filtering',
					},
					{
						name: 'Facebook Page Insights',
						value: 'fbPageInsights',
						description: 'Page impressions, engagement, follows, etc.',
					},
					{
						name: 'Instagram Insights',
						value: 'igInsights',
						description: 'Instagram account impressions and reach',
					},
					{
						name: 'Instagram Profile Info',
						value: 'igProfile',
						description: 'Follower count, username, and other profile fields',
					},
				],
				default: 'fbAdsAccount',
```

Replace with:

```typescript
				options: [
					{
						name: 'Facebook Paid',
						value: 'facebookPaid',
						description: 'Brand ad spend, impressions, reach, etc. (Facebook placement only)',
					},
					{
						name: 'Facebook Organic',
						value: 'facebookOrganic',
						description: 'Page impressions, reach, engagement, video views',
					},
					{
						name: 'Instagram Paid',
						value: 'instagramPaid',
						description: 'Brand ad spend, impressions, reach, etc. (Instagram placement only)',
					},
					{
						name: 'Instagram Organic',
						value: 'instagramOrganic',
						description: 'Reach, engagement, video views, website clicks',
					},
					{
						name: 'Facebook Ads (Campaign)',
						value: 'fbAdsCampaign',
						description: 'Campaign/ad-set/ad level insights with optional filtering',
					},
					{
						name: 'Instagram Profile Info',
						value: 'igProfile',
						description: 'Follower count, username, and other profile fields',
					},
				],
				default: 'facebookPaid',
```

- [ ] **Step 2: Type-check**

```bash
npm run lint
```

Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add nodes/MetaInsights/MetaInsights.node.ts
git commit -m "refactor(MetaInsights): replace operations dropdown with new brand operations"
```

---

### Task 3: Update all parameter displayOptions

**Files:**
- Modify: `nodes/MetaInsights/MetaInsights.node.ts` — all `displayOptions` blocks in `properties`

The following changes must be applied one by one. After all changes, do one type-check and commit.

- [ ] **Step 1: Update `adAccountId` displayOptions**

Find:
```typescript
				displayOptions: {
					show: { operation: ['fbAdsAccount', 'fbAdsCampaign'] },
				},
```

Replace with:
```typescript
				displayOptions: {
					show: { operation: ['facebookPaid', 'instagramPaid', 'fbAdsCampaign'] },
				},
```

- [ ] **Step 2: Update `facebookPageId` displayOptions**

Find:
```typescript
				displayOptions: { show: { operation: ['fbPageInsights'] } },
```

Replace with:
```typescript
				displayOptions: { show: { operation: ['facebookOrganic'] } },
```

- [ ] **Step 3: Update `instagramAccountId` displayOptions**

Find:
```typescript
				displayOptions: {
					show: { operation: ['igInsights', 'igProfile'] },
				},
```

Replace with:
```typescript
				displayOptions: {
					show: { operation: ['instagramOrganic', 'igProfile'] },
				},
```

- [ ] **Step 4: Update `fields` displayOptions**

The `fields` parameter is no longer needed for paid brand operations (fields are hardcoded). It stays only for `fbAdsCampaign` and `igProfile`.

Find:
```typescript
				displayOptions: {
					show: {
						operation: ['fbAdsAccount', 'fbAdsCampaign', 'igProfile'],
					},
				},
```

Replace with:
```typescript
				displayOptions: {
					show: {
						operation: ['fbAdsCampaign', 'igProfile'],
					},
				},
```

- [ ] **Step 5: Remove the `metric` parameter entirely**

Remove this entire block (the first `metric` parameter, which was for `fbPageInsights`):

```typescript
				{
					displayName: 'Metric',
					name: 'metric',
					type: 'string',
					displayOptions: {
						show: { operation: ['fbPageInsights'] },
					},
					default: '',
					description:
						'Comma-separated metrics. Leave empty for defaults. Valid metrics: page_impressions_unique, page_post_engagements, page_follows, page_daily_follows, page_daily_follows_unique, page_daily_unfollows_unique, page_views_total, page_video_views, page_video_views_unique, page_actions_post_reactions_total, page_total_actions, page_posts_impressions, page_posts_impressions_unique',
				},
```

- [ ] **Step 6: Remove the `igMetric` parameter entirely**

Remove this entire block:

```typescript
				{
					displayName: 'Metric',
					name: 'igMetric',
					type: 'string',
					displayOptions: {
						show: { operation: ['igInsights'] },
					},
					default: '',
					description:
						'Comma-separated metrics. Leave empty for defaults. Valid metrics: reach, follower_count, website_clicks, profile_views, online_followers, accounts_engaged, total_interactions, likes, comments, shares, saves, replies, follows_and_unfollows, profile_links_taps, views',
				},
```

- [ ] **Step 7: Update `datePreset` displayOptions**

Find (inside the `datePreset` property block, which has `name: 'datePreset'` above it):
```typescript
			{
				displayName: 'Date Preset',
				name: 'datePreset',
				type: 'options',
				displayOptions: {
					show: { operation: ['fbAdsAccount', 'fbAdsCampaign'] },
				},
```

Replace only the `displayOptions` line inside that block with:
```typescript
			{
				displayName: 'Date Preset',
				name: 'datePreset',
				type: 'options',
				displayOptions: {
					show: { operation: ['facebookPaid', 'instagramPaid', 'fbAdsCampaign'] },
				},
```

- [ ] **Step 8: Update `period` displayOptions**

The `period` parameter now only applies to `facebookOrganic` (IG Organic uses since/until instead).

Find:
```typescript
				displayOptions: {
					show: { operation: ['fbPageInsights', 'igInsights'] },
				},
```
(the one inside the `period` property)

Replace with:
```typescript
				displayOptions: {
					show: { operation: ['facebookOrganic'] },
				},
```

- [ ] **Step 9: Update `additionalOptions` displayOptions**

The additional options (since/until/limit) apply only to `facebookOrganic`, `instagramOrganic`, and `fbAdsCampaign`. Paid operations use `datePreset` instead.

Find:
```typescript
				displayOptions: { hide: { operation: ['igProfile'] } },
```
(inside the `additionalOptions` property)

Replace with:
```typescript
				displayOptions: {
					show: { operation: ['facebookOrganic', 'instagramOrganic', 'fbAdsCampaign'] },
				},
```

- [ ] **Step 10: Type-check**

```bash
npm run lint
```

Expected: no errors.

- [ ] **Step 11: Commit**

```bash
git add nodes/MetaInsights/MetaInsights.node.ts
git commit -m "refactor(MetaInsights): update parameter displayOptions for new operations"
```

---

### Task 4: Implement `facebookPaid` and `instagramPaid` cases

**Files:**
- Modify: `nodes/MetaInsights/MetaInsights.node.ts` — `execute()` method, inside the `switch` block

Both operations share the same logic: call the Ads API with `breakdowns=publisher_platform`, filter the result to the correct platform row, and return a single flat JSON object.

- [ ] **Step 1: Add the cases to the switch block**

In the `execute()` method, find the start of the switch block:

```typescript
				switch (operation) {
					case 'fbAdsAccount': {
```

Insert the following two new cases **before** the `case 'fbAdsAccount'` line:

```typescript
				switch (operation) {
					case 'facebookPaid':
					case 'instagramPaid': {
						const adAccountId = this.getNodeParameter('adAccountId', i) as string;
						const datePreset = this.getNodeParameter('datePreset', i) as string;
						const targetPlatform = operation === 'facebookPaid' ? 'facebook' : 'instagram';

						const paidResp = (await this.helpers.httpRequest({
							method: 'GET',
							url: `${GRAPH_BASE}/${apiVersion}/${adAccountId}/insights`,
							qs: {
								access_token: accessToken,
								fields: PAID_BRAND_FIELDS,
								date_preset: datePreset,
								level: 'account',
								breakdowns: 'publisher_platform',
							},
							ignoreHttpStatusErrors: true,
							returnFullResponse: true,
						})) as { body: any; statusCode: number };

						if (paidResp.statusCode >= 400) {
							const apiErr = paidResp.body?.error;
							const msg = apiErr
								? `Graph API error ${apiErr.code || paidResp.statusCode}: ${apiErr.message}`
								: `HTTP ${paidResp.statusCode}: ${JSON.stringify(paidResp.body)}`;
							throw new Error(msg);
						}

						const rows = (paidResp.body?.data ?? []) as Array<Record<string, any>>;
						const row = rows.find((r) => r.publisher_platform === targetPlatform) ?? null;

						const spend = row?.spend ?? '0';
						const reach = parseInt(row?.reach ?? '0', 10);
						const videoViews =
							(row?.video_play_actions as Array<{ action_type: string; value: string }> ?? [])
								[0]?.value ?? '0';
						const leadActionTypes = new Set([
							'lead',
							'onsite_conversion.lead_grouped',
							'offsite_conversion.fb_pixel_lead',
						]);
						const leads = (row?.actions as Array<{ action_type: string; value: string }> ?? [])
							.filter((a) => leadActionTypes.has(a.action_type))
							.reduce((sum, a) => sum + parseInt(a.value ?? '0', 10), 0);
						const cpf = reach > 0 ? (parseFloat(spend) / reach).toFixed(6) : '0';

						returnData.push({
							json: {
								platform: targetPlatform,
								spend,
								impressions: row?.impressions ?? '0',
								reach: row?.reach ?? '0',
								clicks: row?.clicks ?? '0',
								video_views: videoViews,
								leads: String(leads),
								ctr: row?.ctr ?? '0',
								cpc: row?.cpc ?? '0',
								cpm: row?.cpm ?? '0',
								cpf,
								frequency: row?.frequency ?? '0',
								date_start: row?.date_start ?? '',
								date_stop: row?.date_stop ?? '',
							},
						});
						continue;
					}
					case 'fbAdsAccount': {
```

- [ ] **Step 2: Type-check**

```bash
npm run lint
```

Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add nodes/MetaInsights/MetaInsights.node.ts
git commit -m "feat(MetaInsights): add facebookPaid and instagramPaid operations with publisher_platform breakdown"
```

---

### Task 5: Implement `facebookOrganic` case

**Files:**
- Modify: `nodes/MetaInsights/MetaInsights.node.ts` — `execute()` method, inside the `switch` block

The FB Page Insights API returns an array of metric objects, each with a `values` time-series array. The node takes the most recent value from each metric and returns one flat object.

- [ ] **Step 1: Add the case to the switch block**

Find:
```typescript
					case 'fbPageInsights': {
```

Replace the entire `case 'fbPageInsights'` block (from `case 'fbPageInsights': {` through the matching `}`) with:

```typescript
					case 'facebookOrganic': {
						const pageId = this.getNodeParameter('facebookPageId', i) as string;
						const period = this.getNodeParameter('period', i) as string;
						const orgOpts = this.getNodeParameter('additionalOptions', i, {}) as IDataObject;

						// Page Insights requires a Page Access Token
						let pageAccessToken = accessToken;
						try {
							const pageTokenResp = (await this.helpers.httpRequest({
								method: 'GET',
								url: `${GRAPH_BASE}/${apiVersion}/${pageId}`,
								qs: { fields: 'access_token', access_token: accessToken },
							})) as { access_token?: string };
							if (pageTokenResp.access_token) pageAccessToken = pageTokenResp.access_token;
						} catch {
							// Falls back to user access token if page token exchange fails
						}

						const orgQs: Record<string, string> = {
							access_token: pageAccessToken,
							metric: DEFAULT_METRICS.facebookOrganic,
							period,
						};
						if (orgOpts.since) orgQs.since = orgOpts.since as string;
						if (orgOpts.until) orgQs.until = orgOpts.until as string;

						const orgResp = (await this.helpers.httpRequest({
							method: 'GET',
							url: `${GRAPH_BASE}/${apiVersion}/${pageId}/insights`,
							qs: orgQs,
							ignoreHttpStatusErrors: true,
							returnFullResponse: true,
						})) as { body: any; statusCode: number };

						if (orgResp.statusCode >= 400) {
							const apiErr = orgResp.body?.error;
							const msg = apiErr
								? `Graph API error ${apiErr.code || orgResp.statusCode}: ${apiErr.message}`
								: `HTTP ${orgResp.statusCode}: ${JSON.stringify(orgResp.body)}`;
							throw new Error(msg);
						}

						// Each entry has a values[] time-series; take the last (most recent) value
						const metricMap: Record<string, number> = {};
						for (const entry of (orgResp.body?.data ?? []) as Array<{
							name: string;
							values: Array<{ value: number | Record<string, number> }>;
						}>) {
							const lastVal = entry.values?.[entry.values.length - 1]?.value;
							metricMap[entry.name] = typeof lastVal === 'number' ? lastVal : 0;
						}

						returnData.push({
							json: {
								platform: 'facebook_organic',
								reach: metricMap['page_impressions_unique'] ?? 0,
								impressions: metricMap['page_posts_impressions'] ?? 0,
								engagement: metricMap['page_post_engagements'] ?? 0,
								video_views: metricMap['page_video_views'] ?? 0,
								period,
							},
						});
						continue;
					}
```

- [ ] **Step 2: Type-check**

```bash
npm run lint
```

Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add nodes/MetaInsights/MetaInsights.node.ts
git commit -m "feat(MetaInsights): add facebookOrganic operation"
```

---

### Task 6: Implement `instagramOrganic` case

**Files:**
- Modify: `nodes/MetaInsights/MetaInsights.node.ts` — `execute()` method, inside the `switch` block

The IG Insights API has two call modes: time-series (`reach`, no `metric_type`) and total-value (all other metrics, `metric_type=total_value`). The node makes two calls, sums time-series daily values, and returns one flat object.

- [ ] **Step 1: Replace the existing `igInsights` case**

Find:
```typescript
					case 'igInsights': {
```

Replace the entire `case 'igInsights'` block (from `case 'igInsights': {` through the matching `}` and `continue;`) with:

```typescript
					case 'instagramOrganic': {
						const igOrgId = this.getNodeParameter('instagramAccountId', i) as string;
						const igOrgOpts = this.getNodeParameter('additionalOptions', i, {}) as IDataObject;

						const igExtraQs: Record<string, string> = {};
						if (igOrgOpts.since) igExtraQs.since = igOrgOpts.since as string;
						if (igOrgOpts.until) igExtraQs.until = igOrgOpts.until as string;

						const allIgMetrics = DEFAULT_METRICS.instagramOrganic.split(',').map((m) => m.trim());
						const tsMetrics = allIgMetrics.filter((m) => IG_TIME_SERIES_METRICS.has(m));
						const tvMetrics = allIgMetrics.filter((m) => !IG_TIME_SERIES_METRICS.has(m));

						const makeIgOrgCall = async (metrics: string[], metricType?: string) => {
							const callQs: Record<string, string> = {
								access_token: accessToken,
								metric: metrics.join(','),
								period: 'day',
								...igExtraQs,
							};
							if (metricType) callQs.metric_type = metricType;
							const resp = (await this.helpers.httpRequest({
								method: 'GET',
								url: `${GRAPH_BASE}/${apiVersion}/${igOrgId}/insights`,
								qs: callQs,
								ignoreHttpStatusErrors: true,
								returnFullResponse: true,
							})) as { body: any; statusCode: number };
							if (resp.statusCode >= 400) {
								const apiErr = resp.body?.error;
								const msg = apiErr
									? `Graph API error ${apiErr.code || resp.statusCode}: ${apiErr.message}`
									: `HTTP ${resp.statusCode}: ${JSON.stringify(resp.body)}`;
								throw new Error(msg);
							}
							return resp.body;
						};

						const igResult: Record<string, string | number> = {
							platform: 'instagram_organic',
							reach: 0,
							impressions: 0,
							engagement: 0,
							clicks: 0,
							video_views: 0,
							follows_net: 0,
							date_start: (igOrgOpts.since as string) ?? '',
							date_end: (igOrgOpts.until as string) ?? '',
						};

						// Time-series: sum daily values over the date range
						if (tsMetrics.length > 0) {
							const tsResp = await makeIgOrgCall(tsMetrics);
							for (const entry of (tsResp?.data ?? []) as Array<{
								name: string;
								values: Array<{ value: number }>;
							}>) {
								const total = (entry.values ?? []).reduce(
									(sum, v) => sum + (typeof v.value === 'number' ? v.value : 0),
									0,
								);
								if (entry.name === 'reach') igResult.reach = total;
							}
						}

						// Total-value: aggregate over date range
						if (tvMetrics.length > 0) {
							const tvResp = await makeIgOrgCall(tvMetrics, 'total_value');
							for (const entry of (tvResp?.data ?? []) as Array<{
								name: string;
								total_value?: { value: number };
								values?: Array<{ value: number }>;
							}>) {
								const value = entry.total_value?.value ?? entry.values?.[0]?.value ?? 0;
								switch (entry.name) {
									case 'total_interactions':
										igResult.engagement = value;
										break;
									case 'website_clicks':
										igResult.clicks = value;
										break;
									case 'views':
										igResult.impressions = value;
										igResult.video_views = value;
										break;
									case 'follows_and_unfollows':
										igResult.follows_net = value;
										break;
								}
							}
						}

						returnData.push({ json: igResult });
						continue;
					}
```

- [ ] **Step 2: Type-check**

```bash
npm run lint
```

Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add nodes/MetaInsights/MetaInsights.node.ts
git commit -m "feat(MetaInsights): add instagramOrganic operation"
```

---

### Task 7: Remove old `fbAdsAccount` case and clean up shared logic

**Files:**
- Modify: `nodes/MetaInsights/MetaInsights.node.ts` — `execute()` method

After the new cases are added, the old `fbAdsAccount` case is dead code and must be removed. The shared HTTP request logic at the bottom of the loop now only serves `fbAdsCampaign` and `igProfile` — verify it still works for those.

- [ ] **Step 1: Remove the `fbAdsAccount` case**

Find and delete this entire block:

```typescript
					case 'fbAdsAccount': {
						const adAccountId = this.getNodeParameter(
							'adAccountId',
							i,
						) as string;
						const fields =
							(this.getNodeParameter('fields', i) as string) ||
							DEFAULT_FIELDS.fbAdsAccount;
						const datePreset = this.getNodeParameter(
							'datePreset',
							i,
						) as string;
						url = `${GRAPH_BASE}/${apiVersion}/${adAccountId}/insights`;
						qs.fields = fields;
						qs.date_preset = datePreset;
						qs.level = 'account';
						break;
					}
```

- [ ] **Step 2: Update the shared additionalOptions block**

The shared logic after the switch reads `additionalOptions` for all operations except `igProfile`. Since `facebookPaid` and `instagramPaid` both use `continue` and never reach this code, no changes are strictly required here. However, update the comment for clarity.

Find:

```typescript
				// Additional options (since, until, limit)
				if (operation !== 'igProfile') {
```

Replace with:

```typescript
				// Additional options (since, until, limit) — applies to fbAdsCampaign only
				// (facebookPaid, instagramPaid, facebookOrganic, instagramOrganic use continue above)
				if (operation !== 'igProfile') {
```

- [ ] **Step 3: Type-check**

```bash
npm run lint
```

Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add nodes/MetaInsights/MetaInsights.node.ts
git commit -m "refactor(MetaInsights): remove obsolete fbAdsAccount case"
```

---

### Task 8: Build and verify

**Files:**
- No code changes — build and check output

- [ ] **Step 1: Run full build**

```bash
npm run build
```

Expected: exits with code 0, no TypeScript errors, `dist/nodes/MetaInsights/MetaInsights.node.js` is updated.

- [ ] **Step 2: Verify the dist file contains the new operation names**

```bash
grep -c "facebookPaid\|instagramPaid\|facebookOrganic\|instagramOrganic" dist/nodes/MetaInsights/MetaInsights.node.js
```

Expected: at least 8 matches (each operation name appears in both the description and execute sections).

- [ ] **Step 3: Verify the old operation names are gone**

```bash
grep "fbAdsAccount\|fbPageInsights\|igInsights" dist/nodes/MetaInsights/MetaInsights.node.js
```

Expected: no output (none of the old brand-metric operation names remain).

- [ ] **Step 4: Commit**

```bash
git add dist/
git commit -m "build: compile MetaInsights redesign"
```

---

## Manual Testing Checklist

After installing the node in n8n (`npm link` or copy to custom nodes folder):

1. **Facebook Paid**: Set Ad Account ID + Date Preset = Last Week Mon–Sun. Confirm output has `platform: "facebook"` and `spend`, `impressions`, `reach`, `clicks`, `ctr`, `cpc`, `cpm`, `cpf`, `frequency`, `video_views`, `leads` fields. Confirm the numbers differ from the Instagram Paid run.

2. **Instagram Paid**: Same Ad Account ID + same preset. Confirm `platform: "instagram"` and different numbers than Facebook Paid.

3. **Facebook Organic**: Set Page ID + Period = Week. Confirm output has `platform: "facebook_organic"` with `reach`, `impressions`, `engagement`, `video_views`.

4. **Instagram Organic**: Set IG Account ID + Since/Until for last Mon–Sun (e.g. `since: 2026-04-20`, `until: 2026-04-26`). Confirm output has `platform: "instagram_organic"` with `reach`, `impressions`, `engagement`, `clicks`, `video_views`, `follows_net`.

5. **Facebook Ads (Campaign)**: Confirm it still works exactly as before (untouched).

6. **Instagram Profile Info**: Confirm it still works exactly as before (untouched).
