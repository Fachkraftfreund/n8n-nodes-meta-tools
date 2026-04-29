# MetaInsights Node Redesign

**Date:** 2026-04-29  
**Goal:** Restructure MetaInsights to deliver accurate, platform-separated brand metrics for weekly reporting.

## Problem

The current `fbAdsAccount` operation returns **combined data across all placements** (Facebook + Instagram + Audience Network). This causes Facebook and Instagram paid metrics to show identical numbers — the root cause of the reporting problem.

## Solution

Replace the 3 brand-metric operations with 4 semantically clear ones, using `breakdowns=publisher_platform` in the Ads API to properly separate Facebook and Instagram paid data.

---

## Operations

### Unchanged
- `fbAdsCampaign` — Facebook Ads Campaign Insights (client campaigns)
- `igProfile` — Instagram Profile Info

### Replaced / New

#### 1. `facebookPaid` — Facebook Paid
- **API:** `GET /{version}/{adAccountId}/insights`
- **Key params:** `level=account`, `breakdowns=publisher_platform`, `date_preset`
- **Filter:** Keep only the result row where `publisher_platform === 'facebook'`
- **Fields requested:** `spend,impressions,reach,clicks,ctr,cpc,cpm,frequency,video_play_actions,actions`

#### 2. `facebookOrganic` — Facebook Organic (replaces `fbPageInsights`)
- **API:** `GET /{version}/{pageId}/insights`
- **Key params:** `metric`, `period`, optional `since`/`until`
- **Metrics:** `page_impressions_unique,page_posts_impressions,page_post_engagements,page_video_views`
- **Auth:** Exchanges user token for Page Access Token (same as current implementation)

#### 3. `instagramPaid` — Instagram Paid
- **API:** `GET /{version}/{adAccountId}/insights`
- **Key params:** `level=account`, `breakdowns=publisher_platform`, `date_preset`
- **Filter:** Keep only the result row where `publisher_platform === 'instagram'`
- **Fields requested:** same as `facebookPaid`

#### 4. `instagramOrganic` — Instagram Organic (replaces `igInsights`)
- **API:** `GET /{version}/{igId}/insights`
- **Key params:** `metric`, always `period=day` internally, `since`/`until` for date range
- **Metrics:** `reach,accounts_engaged,total_interactions,website_clicks,views,follows_and_unfollows`
- **Note:** IG Insights API does not support `date_preset` or `period=week` for all metrics. The API always uses `period=day`; time-series metrics (e.g. `reach`) are summed over the since/until range; `total_value` metrics return an aggregate directly.

---

## Parameters Per Operation

### facebookPaid / instagramPaid
| Parameter | Type | Default |
|---|---|---|
| Ad Account ID | string (required) | — |
| Date Preset | options | `last_week_mon_sun` |
| Graph API Version | string | `v25.0` |

Date Preset options: today, yesterday, last_3d, last_7d, last_14d, last_28d, last_30d, last_90d, last_week_mon_sun, last_week_sun_sat, this_week_mon_today, this_week_sun_today, this_month, last_month, this_quarter, last_quarter, this_year, last_year, maximum

### facebookOrganic
| Parameter | Type | Default |
|---|---|---|
| Facebook Page ID | string (required) | — |
| Period | options | `week` |
| Since | string (optional) | — |
| Until | string (optional) | — |
| Graph API Version | string | `v25.0` |

### instagramOrganic
| Parameter | Type | Default |
|---|---|---|
| Instagram Account ID | string (required) | — |
| Since | string (optional) | — |
| Until | string (optional) | — |
| Graph API Version | string | `v25.0` |

> For weekly reports: set Since to last Monday (`YYYY-MM-DD`) and Until to last Sunday. Without since/until the IG API defaults to the last ~2 days. In n8n, use date expressions to calculate these dynamically.

---

## Output Format

Each operation returns a **single flat JSON object** ready for table insertion.

### facebookPaid / instagramPaid
```json
{
  "platform": "facebook",
  "spend": "123.45",
  "impressions": "45678",
  "reach": "34567",
  "clicks": "1234",
  "video_views": "5678",
  "leads": "45",
  "ctr": "2.70",
  "cpc": "0.10",
  "cpm": "2.70",
  "cpf": "0.0036",
  "frequency": "1.32",
  "date_start": "2026-04-20",
  "date_stop": "2026-04-26"
}
```

- `video_views` extracted from `video_play_actions[0].value`
- `leads` summed from `actions` array where `action_type` is `lead`, `onsite_conversion.lead_grouped`, or `offsite_conversion.fb_pixel_lead`
- `cpf` calculated as `spend / reach` (Meta does not return this directly)
- If no data row exists for the platform (e.g. no Instagram spend), returns zeros

### facebookOrganic
```json
{
  "platform": "facebook_organic",
  "reach": "12345",
  "impressions": "18765",
  "engagement": "567",
  "video_views": "234",
  "period": "week"
}
```

- `reach` from `page_impressions_unique` (unique users who saw any content)
- `impressions` from `page_posts_impressions` (total impressions including repeat views)
- `engagement` from `page_post_engagements`
- `video_views` from `page_video_views`
- Ad Spend, Leads, CTR, CPC, CPM, CPF, Frequency not available for organic data

### instagramOrganic
```json
{
  "platform": "instagram_organic",
  "reach": "23456",
  "impressions": "34567",
  "engagement": "1234",
  "clicks": "89",
  "video_views": "2345",
  "follows_net": "45",
  "date_start": "2026-04-20",
  "date_end": "2026-04-26"
}
```

- `impressions` and `video_views` both from `views` metric (IG uses one metric for both)
- `engagement` from `total_interactions`
- `clicks` from `website_clicks`
- `follows_net` from `follows_and_unfollows`
- `date_start`/`date_end` reflect the since/until values passed in
- Leads, CTR, CPC, CPM, CPF, Frequency not available for organic data

---

## Technical Notes

### publisher_platform Breakdown
The Ads API returns one row per platform when `breakdowns=publisher_platform` is set. The node filters `response.data` to find the matching row. If no row matches (e.g. zero spend on that platform), the node returns a zero-valued object rather than throwing an error.

### Leads Extraction
The `actions` field in Ads API is an array: `[{action_type: "lead", value: "12"}, ...]`. The node sums values for relevant lead action types.

### CPF Calculation
`cpf = parseFloat(spend) / parseInt(reach)`. Returns `0` if reach is 0 to avoid division by zero.

### IG Insights Split (retained from current implementation)
Some IG metrics are time-series (`reach`, `follower_count`) and use `period=day` without `metric_type`. All other metrics require `metric_type=total_value`. The node makes two separate API calls and merges the results.

### FB Page Token Exchange (retained from current implementation)
Page Insights requires a Page Access Token. The node fetches it via `GET /{pageId}?fields=access_token` and falls back to the user token if unavailable.

---

## Use Case

Every Monday, an n8n workflow runs 4 nodes (one per operation), merges the outputs, and writes a new row to a tracking table. Week-over-week changes become visible at a glance.
