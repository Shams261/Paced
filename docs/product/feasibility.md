# Feasibility findings

Research baseline: 22 September 2026. The original finding labels below are preserved. These are documentation findings, not results from a working integration. The [hosted architecture design](../architecture/README.md) was approved on 30 September 2026; that acceptance does not verify LinkedIn capabilities. Recheck upstream documentation and observed account behavior before implementing an adapter.

## Verified documentation findings

| Capability | Evidence | Consequence |
| --- | --- | --- |
| Ordinary sign-in | [LinkedIn API access](https://learn.microsoft.com/en-us/linkedin/shared/authentication/getting-access) lists limited self-service permissions. | Sign-in does not provide the complete search, invitation, and messaging workflow. |
| Invitations and acceptance | The [Invitations API](https://learn.microsoft.com/en-us/linkedin/shared/integrations/communications/invitations) documents sending and status retrieval, restricted to approved partners. | Do not assume this project has access. |
| Scheduled messaging | The [Messages API](https://learn.microsoft.com/en-us/linkedin/shared/integrations/communications/messages) requires a specific member action at send time and excludes scheduled events. | Partner access alone does not support our proposed automatic follow-ups under these published requirements. |
| Browser observation | [Chrome content scripts](https://developer.chrome.com/docs/extensions/develop/concepts/content-scripts) can read page content. | A browser adapter is technically plausible, but LinkedIn extraction and interaction reliability are unverified. |
| Durable scheduling | [Chrome's worker lifecycle](https://developer.chrome.com/docs/extensions/develop/concepts/service-workers/lifecycle) permits worker termination; [alarms](https://developer.chrome.com/docs/extensions/reference/api/alarms) can be delayed across sleep and restart. | Campaign progress must survive independently of in-memory timers. |
| Free-account notes | [Personalized invitations](https://www.linkedin.com/help/linkedin/answer/a563153/personalizing-invitations-to-connect?lang=en) and [invitation limits](https://www.linkedin.com/help/linkedin/answer/a550555) have listed different Free-account allowances. | Use account-observed availability instead of hard-coding a universal monthly allowance. |
| Platform policy | [LinkedIn's automation policy](https://www.linkedin.com/help/linkedin/answer/a1340567/automated-activity-on-linkedin?lang=en) prohibits unauthorized website automation. | A prototype does not establish platform approval or freedom from account restrictions. |

Waalaxy documents a similar [search-to-import workflow](https://blog.waalaxy.com/en/expand-your-linkedin-network-with-waalaxy/) and [condition-based sequences](https://intercom.help/waalaxy/en/articles/5634090-how-does-a-campaign-work-conditions-delays-prospect-reply). Those sources describe Waalaxy, not an integration contract available to this project.

The simulator tests the confirmed-rejection stop rule. No live rejection signal has been observed or verified; missing invitations must not be treated as rejection.

## Not yet verified

- Correct extraction of selected profiles and fields from current LinkedIn search pages.
- Reliable recognition of the signed-in account and changes between accounts.
- Reliable distinction between pending invitations, accepted connections, and unknown states.
- Confirmation that an invitation or message was actually sent.
- Reply detection fresh enough to stop pending follow-ups.
- Recovery after a browser restart without blindly repeating an uncertain send.
- Free/Premium account behavior in a controlled end-to-end test.

An earlier read-only UI inspection did not finish because the browser session changed. No import or live send was completed. It must not be recorded as a successful integration test.

## Current decision and next investigation

The hosted hybrid design is now accepted; the earlier local-only product direction and proposed 30-day deadline are superseded by the [current brief](brief.md). The next capability step is read-only feasibility, followed by controlled execution gates. Live validation needs explicitly scoped recipients and content. Do not claim production automation is ready.

Hosting primary sources were checked on 30 September 2026; [operations](../architecture/nfr-operations.md) records those limits and citations. Free-tier quotas, Frankfurt availability and selected frameworks are design inputs, not measured 100-user capacity or India/North America latency.

Read-only feasibility must define evidence for stable account/recipient identity, baseline conversation coverage, historical versus new outgoing messages, before-acceptance replies, existing connections/pending invitations and ambiguous withdrawal. Send confirmation and crash reconciliation cannot be proven by read-only inspection alone; keep those as later controlled capability gates.

If reply freshness or send reconciliation cannot be demonstrated, keep automatic follow-ups disabled and report the capability gap. Do not quietly substitute manual behavior while claiming the original product promise has been achieved.
