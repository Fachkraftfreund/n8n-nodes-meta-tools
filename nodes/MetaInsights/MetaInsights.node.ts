import type {
	IDataObject,
	IExecuteFunctions,
	INodeExecutionData,
	INodeType,
	INodeTypeDescription,
} from 'n8n-workflow';

const GRAPH_BASE = 'https://graph.facebook.com';

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

export class MetaInsights implements INodeType {
	description: INodeTypeDescription = {
		displayName: 'Meta Insights',
		name: 'metaInsights',
		icon: 'file:metaInsights.svg',
		group: ['input'],
		version: 1,
		subtitle: '={{ $parameter["operation"] }}',
		description:
			'Get insights from Facebook Ads, Facebook Pages, and Instagram',
		defaults: { name: 'Meta Insights' },
		inputs: ['main'],
		outputs: ['main'],
		credentials: [{ name: 'facebookGraphApi', required: true }],
		properties: [
			// ── Operation ─────────────────────────────────────────
			{
				displayName: 'Operation',
				name: 'operation',
				type: 'options',
				noDataExpression: true,
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
			},

			// ── Entity IDs ────────────────────────────────────────
			{
				displayName: 'Ad Account ID',
				name: 'adAccountId',
				type: 'string',
				required: true,
				displayOptions: {
					show: { operation: ['facebookPaid', 'instagramPaid', 'fbAdsCampaign'] },
				},
				default: '',
				placeholder: 'act_123456789',
				description: 'Facebook Ad Account ID (including the act_ prefix)',
			},
			{
				displayName: 'Facebook Page ID',
				name: 'facebookPageId',
				type: 'string',
				required: true,
				displayOptions: { show: { operation: ['facebookOrganic'] } },
				default: '',
			},
			{
				displayName: 'Instagram Account ID',
				name: 'instagramAccountId',
				type: 'string',
				required: true,
				displayOptions: {
					show: { operation: ['instagramOrganic', 'igProfile'] },
				},
				default: '',
				description: 'Instagram Business Account ID',
			},

			// ── Fields / Metrics ──────────────────────────────────
			{
				displayName: 'Fields',
				name: 'fields',
				type: 'string',
				displayOptions: {
					show: {
						operation: ['fbAdsCampaign', 'igProfile'],
					},
				},
				default: '',
				description:
					'Comma-separated fields to return. Leave empty for defaults.',
			},

			// ── Date / Period ─────────────────────────────────────
			{
				displayName: 'Date Preset',
				name: 'datePreset',
				type: 'options',
				displayOptions: {
					show: { operation: ['facebookPaid', 'instagramPaid', 'fbAdsCampaign'] },
				},
				options: [
					{ name: 'Today', value: 'today' },
					{ name: 'Yesterday', value: 'yesterday' },
					{ name: 'Last 3 Days', value: 'last_3d' },
					{ name: 'Last 7 Days', value: 'last_7d' },
					{ name: 'Last 14 Days', value: 'last_14d' },
					{ name: 'Last 28 Days', value: 'last_28d' },
					{ name: 'Last 30 Days', value: 'last_30d' },
					{ name: 'Last 90 Days', value: 'last_90d' },
					{ name: 'Last Week (Mon\u2013Sun)', value: 'last_week_mon_sun' },
					{ name: 'Last Week (Sun\u2013Sat)', value: 'last_week_sun_sat' },
					{
						name: 'This Week (Mon\u2013Today)',
						value: 'this_week_mon_today',
					},
					{
						name: 'This Week (Sun\u2013Today)',
						value: 'this_week_sun_today',
					},
					{ name: 'This Month', value: 'this_month' },
					{ name: 'Last Month', value: 'last_month' },
					{ name: 'This Quarter', value: 'this_quarter' },
					{ name: 'Last Quarter', value: 'last_quarter' },
					{ name: 'This Year', value: 'this_year' },
					{ name: 'Last Year', value: 'last_year' },
					{ name: 'Maximum', value: 'maximum' },
				],
				default: 'last_week_mon_sun',
			},
			{
				displayName: 'Period',
				name: 'period',
				type: 'options',
				displayOptions: {
					show: { operation: ['facebookOrganic'] },
				},
				options: [
					{ name: 'Day', value: 'day' },
					{ name: 'Week', value: 'week' },
					{ name: '28 Days', value: 'days_28' },
					{ name: 'Lifetime', value: 'lifetime' },
					{ name: 'Total Over Range', value: 'total_over_range' },
				],
				default: 'week',
			},

			// ── Campaign-specific ─────────────────────────────────
			{
				displayName: 'Level',
				name: 'level',
				type: 'options',
				displayOptions: { show: { operation: ['fbAdsCampaign'] } },
				options: [
					{ name: 'Campaign', value: 'campaign' },
					{ name: 'Ad Set', value: 'adset' },
					{ name: 'Ad', value: 'ad' },
				],
				default: 'campaign',
			},
			{
				displayName: 'Filtering',
				name: 'filtering',
				type: 'string',
				displayOptions: { show: { operation: ['fbAdsCampaign'] } },
				default: '',
				placeholder:
					'[{"field":"campaign.name","operator":"CONTAIN","value":"Pool"}]',
				description: 'JSON array of filter objects',
			},

			// ── Additional Options ────────────────────────────────
			{
				displayName: 'Additional Options',
				name: 'additionalOptions',
				type: 'collection',
				placeholder: 'Add Option',
				default: {},
				displayOptions: {
					show: { operation: ['facebookOrganic', 'instagramOrganic', 'fbAdsCampaign'] },
				},
				options: [
					{
						displayName: 'Since',
						name: 'since',
						type: 'string',
						default: '',
						description:
							'Start date (Unix timestamp or YYYY-MM-DD depending on endpoint)',
					},
					{
						displayName: 'Until',
						name: 'until',
						type: 'string',
						default: '',
						description:
							'End date (Unix timestamp or YYYY-MM-DD depending on endpoint)',
					},
					{
						displayName: 'Limit',
						name: 'limit',
						type: 'number',
						default: 25,
						description: 'Maximum number of results per page',
					},
				],
			},

			// ── API Version ───────────────────────────────────────
			{
				displayName: 'Graph API Version',
				name: 'graphApiVersion',
				type: 'string',
				default: 'v25.0',
			},
		],
	};

	async execute(this: IExecuteFunctions): Promise<INodeExecutionData[][]> {
		const items = this.getInputData();
		const returnData: INodeExecutionData[] = [];

		const credentials = await this.getCredentials('facebookGraphApi');
		const accessToken = credentials.accessToken as string;

		for (let i = 0; i < items.length; i++) {
			try {
				const operation = this.getNodeParameter('operation', i) as string;
				const apiVersion = this.getNodeParameter(
					'graphApiVersion',
					i,
				) as string;

				let url: string;
				const qs: Record<string, string> = { access_token: accessToken };

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
					case 'fbAdsCampaign': {
						const adAccountId = this.getNodeParameter(
							'adAccountId',
							i,
						) as string;
						const fields =
							(this.getNodeParameter('fields', i) as string) ||
							DEFAULT_FIELDS.fbAdsCampaign;
						const datePreset = this.getNodeParameter(
							'datePreset',
							i,
						) as string;
						const level = this.getNodeParameter('level', i) as string;
						const filtering = this.getNodeParameter(
							'filtering',
							i,
							'',
						) as string;
						url = `${GRAPH_BASE}/${apiVersion}/${adAccountId}/insights`;
						qs.fields = fields;
						qs.date_preset = datePreset;
						qs.level = level;
						if (filtering) qs.filtering = filtering;
						break;
					}
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
					case 'igInsights': {
						// IG Insights needs two calls: time-series vs total_value metrics
						const igId = this.getNodeParameter(
							'instagramAccountId',
							i,
						) as string;
						const allMetrics = (
							(this.getNodeParameter('igMetric', i) as string) ||
							DEFAULT_METRICS.igInsights
						).split(',').map((m) => m.trim());

						const tsMetrics = allMetrics.filter((m) =>
							IG_TIME_SERIES_METRICS.has(m),
						);
						const tvMetrics = allMetrics.filter(
							(m) => !IG_TIME_SERIES_METRICS.has(m),
						);

						const opts = this.getNodeParameter(
							'additionalOptions',
							i,
							{},
						) as IDataObject;
						const extraQs: Record<string, string> = {};
						if (opts.since) extraQs.since = opts.since as string;
						if (opts.until) extraQs.until = opts.until as string;

						const makeIgCall = async (
							metrics: string[],
							metricType?: string,
						) => {
							const callQs: Record<string, string> = {
								access_token: accessToken,
								metric: metrics.join(','),
								period: 'day',
								...extraQs,
							};
							if (metricType)
								callQs.metric_type = metricType;
							const resp = (await this.helpers.httpRequest({
								method: 'GET',
								url: `${GRAPH_BASE}/${apiVersion}/${igId}/insights`,
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

						if (tsMetrics.length > 0) {
							const resp = await makeIgCall(tsMetrics);
							if (Array.isArray(resp.data)) {
								for (const entry of resp.data) {
									returnData.push({ json: entry });
								}
							}
						}
						if (tvMetrics.length > 0) {
							const resp = await makeIgCall(
								tvMetrics,
								'total_value',
							);
							if (Array.isArray(resp.data)) {
								for (const entry of resp.data) {
									returnData.push({ json: entry });
								}
							}
						}
						if (tsMetrics.length === 0 && tvMetrics.length === 0) {
							returnData.push({ json: { data: [] } });
						}
						continue; // skip shared request logic below
					}
					case 'igProfile': {
						const igId = this.getNodeParameter(
							'instagramAccountId',
							i,
						) as string;
						const fields =
							(this.getNodeParameter('fields', i) as string) ||
							DEFAULT_FIELDS.igProfile;
						url = `${GRAPH_BASE}/${apiVersion}/${igId}`;
						qs.fields = fields;
						break;
					}
					default:
						throw new Error(`Unknown operation: ${operation}`);
				}

				// Additional options (since, until, limit)
				if (operation !== 'igProfile') {
					const opts = this.getNodeParameter(
						'additionalOptions',
						i,
						{},
					) as IDataObject;
					if (opts.since) qs.since = opts.since as string;
					if (opts.until) qs.until = opts.until as string;
					if (opts.limit) qs.limit = (opts.limit as number).toString();
				}

				const fullResp = (await this.helpers.httpRequest({
					method: 'GET',
					url,
					qs,
					ignoreHttpStatusErrors: true,
					returnFullResponse: true,
				})) as { body: any; statusCode: number };

				if (fullResp.statusCode >= 400) {
					const apiError = fullResp.body?.error;
					const msg = apiError
						? `Graph API error ${apiError.code || fullResp.statusCode}: ${apiError.message}`
						: `HTTP ${fullResp.statusCode}: ${JSON.stringify(fullResp.body)}`;
					throw new Error(msg);
				}

				const response = fullResp.body;

				// Unwrap data arrays for insights endpoints
				if (Array.isArray(response.data)) {
					for (const entry of response.data) {
						returnData.push({ json: entry });
					}
					if (response.data.length === 0) {
						returnData.push({ json: response });
					}
				} else {
					returnData.push({ json: response });
				}
			} catch (error) {
				if (this.continueOnFail()) {
					returnData.push({ json: { error: (error as Error).message } });
					continue;
				}
				throw error;
			}
		}

		return [returnData];
	}
}
