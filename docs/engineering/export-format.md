# Export format

An authenticated owner can download their retained workspace data from the hosted dashboard. The file is newline-delimited JSON (`.ndjson`): one JSON object per line. The current format version is `sequence-export-1`.

## Lines

| Line | Shape | Notes |
| --- | --- | --- |
| First | `{"type":"manifest","formatVersion":"sequence-export-1","workspaceId":…,"generatedAt":…,"pageSize":500,"sendingEnabled":false,"counts":{…}}` | Counts per section at generation time |
| Middle | `{"type":"<section>","page":n,"rows":[…]}` | One line per page of at most 500 rows; sections appear in a fixed order and every section has at least one line, possibly with empty rows |
| Last | `{"type":"end","pages":n}` | Present only when every page was written; a file without it is incomplete and must be downloaded again |

Sections in order: `accounts`, `prospects`, `lists`, `memberships`, `campaigns`, `revisions`, `approvals`, `approvalRecipients`, `enrollments`, `actions`, `attempts`, `results`, `observations`, `reservations`. Rows use the database column names of the owner's own tenant rows. Identifiers are opaque UUIDs that link rows across sections, for example `memberships.prospect_id` to `prospects.id`.

## What is included and excluded

Included: the synthetic account binding, saved prospects with their selected fields, lists and memberships, campaign drafts and every content revision, approvals with the exact rendered text per recipient, enrollment states and stop reasons, logical actions, attempt facts and outcomes, minimal observation metadata, and possible-send reservations.

Excluded: sessions, tokens, cookies, denial audit records, request idempotency records, other tenants' rows, provider configuration, and any incoming message bodies, which the product never stores.

## How it is produced

The dashboard sends a same-origin `POST /api/v1/export` with the session cookie and CSRF token. The Worker reads the manifest, then streams each section page from the database through the response without parsing it and without storing a file. The browser checks the `end` line before offering the download. The export is the owner's record copy, not an operator restore format; backups are a separate operator process.
