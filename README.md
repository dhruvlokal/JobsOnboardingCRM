# Lokal onboarding CRM

Internal CRM for post-payment advertiser onboarding: calling, package explanation, document verification, classified check, and TAT tracking.

## Run it

```bash
cp .env.example .env        # set JWT_SECRET and admin password
npm install
npm start                   # http://<server-ip>:8080
```

Or with Docker:

```bash
docker build -t lokal-crm .
docker run -d -p 8080:8080 -v /srv/lokal-crm:/data --env-file .env --restart unless-stopped lokal-crm
```

First login: `ADMIN_EMAIL` / `ADMIN_PASSWORD` from `.env` (defaults `admin@lokal.local` / `admin123`). Change it from the sidebar.

Everything lives in one SQLite file plus uploaded docs, inside `data/` (or `DATA_DIR`). Back up that folder daily. Put it behind nginx with HTTPS if it's reachable outside the office network.

## How a lead flows

1. Payment lands (curl push, sheet sync, or CSV) → dedup on `payment_id`, else phone + classified ID.
2. Routed: assignment rules first, then team by language, then an agent inside the team (least open leads, or round robin). Only agents who are active, "taking leads", and under their daily cap get leads, and ones who speak the language are preferred. No one free → it waits in the team queue and gets picked up every minute.
3. Agent calls and logs a disposition. Not-connected dispositions auto-schedule the retry. After max attempts it stops and flags for manager review.
4. Stage moves on its own: New → Contacted → Docs pending → Classified check → Ready → Onboarded. "Mark onboarded" only unlocks when package explained + required docs verified + classified approved. Managers can override.
5. TAT clock starts at payment time, not at assignment.

## Roles

- **Admin**: everything, including users, teams, rules, dispositions, integrations, settings.
- **Manager**: their team's leads (all leads if no team set), reassigning, agent availability, reports.
- **Agent**: only their own leads and own numbers.

## Getting data in

**curl / webhook push.** Create a key under Data sources & API:

```bash
curl -X POST http://crm.internal:8080/api/v1/leads \
  -H "Content-Type: application/json" -H "X-API-Key: lk_..." \
  -d '[{"payment_id":"pay_1","phone":"9876543210","company":"Balaji Traders","language":"te","package":"Premium","amount":1499,"paid_at":"2026-09-26 10:15","classified_id":"J-88213"}]'
```

Accepts one object, an array, or `{ "leads": [...] }`. Safe to retry.

**Sheet / readsheet link with auto-refresh.** Add a source with any of:
- a Google Sheet link (shared as "anyone with link can view"); the `gid` in the URL picks the tab
- a published-to-web CSV link
- an Apps Script web app returning JSON, e.g.

```javascript
function doGet() {
  const v = SpreadsheetApp.openById('SHEET_ID').getSheetByName('Paid').getDataRange().getValues();
  return ContentService.createTextOutput(JSON.stringify(v)).setMimeType(ContentService.MimeType.JSON);
}
```

Headers are matched automatically (phone / mobile / adv_mobile_no, payment_id / order_id, company_name, locale, job_title, sub_id…). Locale codes like `te`, `ta`, `kn` become Telugu / Tamil / Kannada. If headers are odd, set a mapping like `{"phone":"Advertiser Mobile","payment_id":"Order ID"}`. Existing leads only get blank fields filled; CRM work is never overwritten.

**CSV upload.** Leads → Import CSV.

## Reports

Any date range, daily / weekly / monthly buckets, IST:
- Agent scorecard: assigned, calls, connect %, leads called, docs verified, onboarded, dropped, avg first-call TAT, avg onboarding TAT, first-call SLA misses, onboarded within SLA, open now, overdue follow-ups
- Trend of new vs onboarded with TAT per bucket
- Disposition matrix per agent
- CSV exports: scorecard, onboarding tracker (every lead with milestone timestamps and TATs), full call log, any filtered lead list

## Set these on day one

First-call SLA, onboarding SLA, required documents, max attempts, and auto-reassign (moves a lead to another agent if it isn't called within N minutes of assignment).

## Not built yet

- TAT is calendar time. If an 11pm payment shouldn't count overnight, add business-hours TAT.
- No dialer integration; `tel:` links work on agent phones. Neodove / Airtel IQ click-to-call would be one extra endpoint.
- No WhatsApp template sending for doc requests.
