import type {
	IDataObject,
	IExecuteFunctions,
	INodeExecutionData,
	INodeType,
	INodeTypeDescription,
} from 'n8n-workflow';

const GRAPH_BASE = 'https://graph.facebook.com';

const DEFAULT_FIELDS: Record<string, string> = {
	fbAdsAccount:
		'spend,impressions,reach,clicks,video_play_actions,actions,cpm,cpc,ctr,frequency',
	fbAdsCampaign:
		'campaign_name,spend,impressions,reach,clicks,video_play_actions,actions,cpm,cpc,ctr,frequency',
	igProfile: 'followers_count,username',
};

const DEFAULT_METRICS: Record<string, string> = {
	fbPageInsights:
		'page_impressions,page_impressions_unique,page_post_engagements,page_follows',
	igInsights: 'impressions,reach',
};

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
			},

			// ── Entity IDs ────────────────────────────────────────
			{
				displayName: 'Ad Account ID',
				name: 'adAccountId',
				type: 'string',
				required: true,
				displayOptions: {
					show: { operation: ['fbAdsAccount', 'fbAdsCampaign'] },
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
				displayOptions: { show: { operation: ['fbPageInsights'] } },
				default: '',
			},
			{
				displayName: 'Instagram Account ID',
				name: 'instagramAccountId',
				type: 'string',
				required: true,
				displayOptions: {
					show: { operation: ['igInsights', 'igProfile'] },
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
						operation: ['fbAdsAccount', 'fbAdsCampaign', 'igProfile'],
					},
				},
				default: '',
				description:
					'Comma-separated fields to return. Leave empty for defaults.',
			},
			{
				displayName: 'Metric',
				name: 'metric',
				type: 'string',
				displayOptions: {
					show: { operation: ['fbPageInsights'] },
				},
				default: '',
				description:
					'Comma-separated metrics. Leave empty for defaults. Common metrics: page_impressions, page_impressions_unique, page_impressions_paid, page_impressions_viral, page_post_engagements, page_follows, page_daily_follows, page_daily_unfollows_unique, page_fans, page_fan_adds, page_fan_removes, page_views_total, page_video_views, page_video_views_unique, page_actions_post_reactions_total, page_total_actions',
			},
			{
				displayName: 'Metric',
				name: 'igMetric',
				type: 'string',
				displayOptions: {
					show: { operation: ['igInsights'] },
				},
				default: '',
				description:
					'Comma-separated metrics. Leave empty for defaults. Common metrics: impressions, reach, profile_views, accounts_engaged, total_interactions, likes, comments, shares, saves, replies, follows_and_unfollows',
			},

			// ── Date / Period ─────────────────────────────────────
			{
				displayName: 'Date Preset',
				name: 'datePreset',
				type: 'options',
				displayOptions: {
					show: { operation: ['fbAdsAccount', 'fbAdsCampaign'] },
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
					show: { operation: ['fbPageInsights', 'igInsights'] },
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
				displayOptions: { hide: { operation: ['igProfile'] } },
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
					case 'fbPageInsights': {
						const pageId = this.getNodeParameter(
							'facebookPageId',
							i,
						) as string;
						const metric =
							(this.getNodeParameter('metric', i) as string) ||
							DEFAULT_METRICS.fbPageInsights;
						const period = this.getNodeParameter('period', i) as string;
						url = `${GRAPH_BASE}/${apiVersion}/${pageId}/insights`;
						qs.metric = metric;
						qs.period = period;

						// Page insights require a Page Access Token
						try {
							const pageTokenResp = await this.helpers.httpRequest({
								method: 'GET',
								url: `${GRAPH_BASE}/${apiVersion}/${pageId}`,
								qs: {
									fields: 'access_token',
									access_token: accessToken,
								},
							}) as { access_token?: string };
							if (pageTokenResp.access_token) {
								qs.access_token = pageTokenResp.access_token;
							}
						} catch {
							// Falls back to user access token if page token exchange fails
						}
						break;
					}
					case 'igInsights': {
						const igId = this.getNodeParameter(
							'instagramAccountId',
							i,
						) as string;
						const metric =
							(this.getNodeParameter('igMetric', i) as string) ||
							DEFAULT_METRICS.igInsights;
						const period = this.getNodeParameter('period', i) as string;
						url = `${GRAPH_BASE}/${apiVersion}/${igId}/insights`;
						qs.metric = metric;
						qs.period = period;
						break;
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

				const response = await this.helpers.httpRequest({
					method: 'GET',
					url,
					qs,
				});

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
