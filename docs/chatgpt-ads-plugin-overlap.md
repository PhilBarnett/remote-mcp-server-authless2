# ChatGPT Ads plugin overlap audit — 7 October 2026

Read access through the official plugin was verified against Blindmotion Online
and its existing active Outdoor DIY campaign, with shared A$30/day budget.
This cleanup changes MCP code only, not campaigns, spending or tracking.

| Function | Owner after cleanup | Reason |
| --- | --- | --- |
| Account/entity reads, campaign/ad-group/ad creation and updates | Official plugin | Native list/get/create/update tools |
| Budgets, bidding, targeting, schedules and activate/pause/archive | Official plugin | Native entity updates include status and configuration |
| Image uploads and ad previews | Official plugin | Native upload/preview tools |
| Delivery, conversions, conversion inventory and audit logs | Official plugin | Native insights/diagnostics/list tools |
| Geographic lookup and feed listing | Official plugin | Native lookup/list tools |
| Account spending limits and account activate/pause | Advanced MCP | Not exposed by installed plugin |
| Conversion source/event-setting creation | Advanced MCP | Plugin lists but does not create |
| Landing-page crawler evidence | Advanced MCP | No matching native tool |
| Feed maintenance and SSH SFTP setup | Advanced MCP | Plugin discovers feeds but does not maintain them |
| Audience membership/uploads and operation jobs | Removed | Unused; official plugin routes customer-file changes to Ads Manager web |
| Hotel insights | Removed | Unrelated to Blindmotion |

73 catalog operations become 22. Legacy report/location actions and unused schemas
are removed. The tool is renamed to make its advanced-only scope explicit.
Signed preview/apply, account pinning, currency/state checks, credential redaction,
redirect blocking and post-write verification remain. The encrypted Worker API key
is still needed; no secret removal or key revocation is required.

## Removed operations

- `list_campaigns`
- `create_campaign`
- `get_campaign`
- `update_campaign`
- `activate_campaign`
- `pause_campaign`
- `archive_campaign`
- `list_custom_audiences`
- `create_custom_audience`
- `get_custom_audience`
- `archive_custom_audience`
- `add_custom_audience_members`
- `remove_custom_audience_members`
- `replace_custom_audience_members`
- `merge_custom_audiences`
- `get_custom_audience_operation`
- `list_custom_audience_operations`
- `cancel_custom_audience_operation`
- `resume_custom_audience_operation`
- `update_ad_account`
- `list_audit_logs`
- `get_ad_account`
- `get_ad_account_insights`
- `get_hotel_insights`
- `get_hotel_insights_timeseries`
- `get_campaign_insights`
- `get_ad_group_insights`
- `get_ad_insights`
- `get_geo_lookup`
- `list_conversion_event_settings`
- `list_conversion_sources`
- `list_conversion_events`
- `post_conversion_insights`
- `list_ad_groups`
- `create_ad_group`
- `get_ad_group`
- `update_ad_group`
- `activate_ad_group`
- `pause_ad_group`
- `archive_ad_group`
- `list_ads`
- `create_ad`
- `get_ad`
- `update_ad`
- `create_ad_preview`
- `activate_ad`
- `pause_ad`
- `archive_ad`
- `upload_blob`
- `upload_image`
- `list_product_feeds`

## Retained operations

- `activate_ad_account`
- `pause_ad_account`
- `get_ad_account_spend_limit_windows`
- `create_ad_account_spend_limit_window`
- `update_ad_account_spend_limit_window`
- `delete_ad_account_spend_limit_window`
- `set_ad_account_daily_spend_limit`
- `delete_ad_account_daily_spend_limit`
- `create_conversion_event_setting`
- `create_conversion_source`
- `get_landing_page_crawler_evidence`
- `get_product_feed_settings`
- `patch_product_feed_settings`
- `archive_product_feed`
- `create_product_feed`
- `list_product_feed_uploads`
- `query_product_feed_products`
- `patch_product_feed_products`
- `get_product_feed_sftp_access`
- `post_product_feed_sftp_access`
- `post_product_feed_sftp_access_activate`
- `post_product_feed_sftp_access_pause`
