# Greenlight

**Get the green light, faster.** Multi-tenant approval and purchasing workflows for organizations.

Live: https://approval-workflows.up.railway.app

Employees submit requests (purchases, expenses, time off). Each request moves through a configurable approval chain, for example **Manager → Finance → VP**, with email notifications at every step and a complete audit trail. An AI layer classifies incoming requests and flags anomalies such as unusual amounts or first-time vendors.

---

## The problem

Large organizations keep hitting the same issues:

- **Scattered processes.** Requests live in email threads, spreadsheets and chat messages.
- **Unclear ownership.** Nobody knows who has to approve what, or where a request is stuck.
- **Weak controls.** Permissions are informal and there is no reliable record of who approved what.
- **Manual review.** Finance teams check every request by hand to spot the risky ones.

Greenlight puts every request in one place, routes it to the right people, records every decision, and highlights the requests that need a closer look.

## Features

| Area | What it does | Status |
|---|---|---|
| **Authentication** | Sign in with Google (OAuth 2.0 / OpenID Connect) | ✅ Done |
| **Workspaces** | Every company is an isolated workspace; users can belong to several | ✅ Done |
| **Invitations** | Admins invite teammates by email with a role; invitees accept with one click | ✅ Done |
| **Notifications** | Email alerts when a request needs approval or changes status | ✅ Done |
| **Roles** | Admin, Manager and Employee permissions, plus reporting lines (who reports to whom) | ✅ Done |
| **Requests** | Purchases, expenses and time off, with amounts, vendors or dates | ✅ Done |
| **Approval chains** | Configurable multi-step approvals (e.g. Manager → Finance → VP), with amount thresholds | ✅ Done |
| **Audit log** | Append-only record of every action, readable by Admins | ✅ Done |
| **Anomaly checks** | Rule-based flags: unusual amounts, new vendors, duplicates, amounts just under a limit, split purchases, overlapping time off | ✅ Done |
| **AI classification** | Claude categorizes each request, rates its risk and explains concerns (optional) | ✅ Done |
| **Live demo** | One click on the landing page opens a private sample company; view it as any person; deleted after 24 hours | ✅ Done |
| **Needs changes** | Approvers can send a request back; the requester edits and resubmits it for a new round | ✅ Done |
| **Receipts** | Attach photos or PDFs (up to 5 per request, 5 MB each), checked by file signature | ✅ Done |
| **Dashboard** | Approved spending by month, top vendors and people, approval rate, time to decide, CSV export | ✅ Done |
| **Notification bell** | In-app notifications for approvals, decisions, escalations and budget alerts | ✅ Done |
| **Reminders and escalation** | Remind slow approvers, then move the step to their manager or an Admin | ✅ Done |
| **Out of office** | Pick a delegate who approves for you while you're away | ✅ Done |
| **Departments and budgets** | Monthly, quarterly or yearly budgets; flags at 80% and 100%; Admin alerts | ✅ Done |
| **Currencies** | A base currency, with exchange rates set by hand or from the European Central Bank | ✅ Done |
| **Time off** | Vacation balances in business days, per-person allowances, and a team calendar | ✅ Done |
| **Slack** | Approvals, decisions and budget alerts posted to a channel through an incoming webhook | ✅ Done |

## Roadmap

### Milestone 1: Authentication and workspaces ✅
- [x] Google sign-in with secure, server-side sessions
- [x] Create a workspace; the creator becomes its Admin
- [x] Workspace isolation: users only see workspaces they belong to
- [x] Switch between workspaces
- [x] Automated tests

### Milestone 2: Email ✅
- [x] Pluggable email sending: Brevo, Resend, or a local console outbox for development
- [x] Admins invite people by email with a role (Admin, Manager, Employee)
- [x] Invite links: single use, expire after 7 days, stored hashed, revocable, re-sendable
- [x] Invitees open the link, sign in (and come back to the invite automatically) and accept
- [x] Notification email templates: "approval needed" and "request approved / rejected"
- [x] Automated tests

### Milestone 3: Permissions and approvals ✅
- [x] Role-based access control (Admin, Manager, Employee) and reporting lines
- [x] Admins change roles, set who reports to whom, and remove members (never the last Admin)
- [x] Request submission: purchase, expense, time off
- [x] Configurable approval chains per request type (up to 5 steps, optional minimum amount per step)
- [x] Approve or reject (a reason is required to reject); the requester can cancel while pending
- [x] Approval and status emails at every step
- [x] Audit log of every action
- [x] Automated tests

### Milestone 4: AI ✅
- [x] Rule-based anomaly checks on every request (no AI needed)
- [x] AI classification with Claude: category, risk level, one-line summary, judgment flags
- [x] Risk and flags shown to approvers (request page, approval email, list badges)
- [x] AI runs in the background and can never lower a risk the rules found
- [x] Admins can re-run the AI for a request
- [x] Automated tests (with a fake Claude client)

### Milestone 5: Everyday workflow ✅
- [x] Live demo company (private per visitor, persona switcher, auto-cleanup)
- [x] "Needs changes" with edit and resubmit; approval rounds in the timeline
- [x] Receipt and invoice attachments
- [x] Spending dashboard and CSV export
- [x] Notification bell, reminders, escalation and out-of-office delegation
- [x] Departments, budgets and multi-currency reporting
- [x] Vacation balances and team calendar
- [x] Slack notifications

## How approvals work

1. An **Admin** sets up an approval chain for each request type on the **Approval chains** tab. A step's approver is either *the requester's manager* or a specific person (for example the Finance lead), and a step can apply only above an amount (for example *VP only for $5,000 or more*). Without a configured chain, requests go to the requester's manager.
2. Any member submits a **request**. The approvers are fixed at that moment, and steps below their minimum amount are skipped.
3. The current approver gets an **email** and sees the request under **To approve**. They approve or reject (with a reason).
4. Approving moves the request to the next step and emails the next approver; the last approval completes it. Rejecting stops the chain. The requester is emailed at every step.

Rules:
- Nobody approves their own request; such steps go to another Admin.
- If the requester has no manager, the "manager" step goes to an Admin.
- Only the current approver can decide, and only once.
- The requester can cancel while the request is pending.

### Who can do what

| | Employee | Manager | Admin |
|---|:-:|:-:|:-:|
| Submit requests, see their own, cancel while pending | ✅ | ✅ | ✅ |
| Approve requests assigned to them | ✅ | ✅ | ✅ |
| See their direct reports' requests | | ✅ | ✅ |
| See all requests | | | ✅ |
| Invite people, change roles and reporting lines, remove members | | | ✅ |
| Configure approval chains | | | ✅ |
| Read the audit log | | | ✅ |

Other companies' workspaces always return 404.

## Risk checks and AI

Every request gets a **risk level** (low, medium, high) and a list of **flags** that approvers see on the request page, in the approval email ("Worth a look") and as a badge in their list. Requesters don't see the risk on their own requests.

**Rule checks** (always on, instant, no AI):

| Flag | When |
|---|---|
| `amount_unusual_for_requester` | More than 3× the person's median for that request type (needs 3+ past requests) |
| `amount_unusual_for_company` | More than 1.5× the company's 95th percentile for that type (needs 10+ past requests) |
| `new_vendor` | First request with this vendor in the workspace |
| `possible_duplicate` | Same person, same amount and same title or vendor within 30 days |
| `just_below_threshold` | Within 5% below an approval step's minimum amount |
| `possible_split` | Same person and vendor within 7 days, each under a limit, together over it |
| `overlapping_time_off` / `long_time_off` | Overlaps another pending/approved time off, or longer than 21 days |
| `over_balance` | Time off takes more business days than the person has left this year |
| `budget_80` / `over_budget` | With this request, the department reaches 80% / goes over its budget (approved plus waiting) |

**AI classification** (optional, Claude): after a request is submitted, Claude reads it in the background and returns a category (Software & subscriptions, Travel, Hardware & equipment, …), a risk level, a one-line summary for the approver, and judgment flags such as *vague justification* or *possible personal use*. It uses structured JSON output (`output_config.format`), so the answer always matches a fixed schema, at low effort to keep cost and latency down.

Safeguards:
- **Turned on by** setting `ANTHROPIC_API_KEY`. Without it, only the rule checks run.
- **AI can raise the risk, never lower it.** The final risk is the highest of the rule flags and the AI's view.
- **Request text is treated as data.** It's sent inside a `<request>` block, and the system prompt tells the model to ignore instructions in it and flag attempts to influence the review.
- **Failures never block a request.** If the AI is unavailable, declines, or returns something invalid, the request goes through with its rule checks, and the panel says "AI review unavailable". Admins can **Re-run AI** later.
- **Refusal fallback** (`fallbacks: "default"`) is on: if the model declines, the API retries on another model in the same call.
- **What's sent to Anthropic:** type, title, description, amount, currency, vendor, dates, the requester's role and number of past requests, and the rule flags. No names or emails.

## Tech stack

- **Backend:** Node.js 20+, Express
- **Database:** PostgreSQL (migrations in `migrations/`)
- **Auth:** Google OAuth 2.0 / OpenID Connect, HTTP-only session cookies stored server-side
- **Email:** Brevo or Resend HTTP APIs (console outbox in development)
- **AI:** Claude via the official `@anthropic-ai/sdk` (model `claude-opus-5-5`, structured outputs)
- **Frontend:** Plain HTML, CSS and JavaScript served by Express
- **Tests:** Node's built-in test runner (`node --test`) against an in-memory Postgres (`pg-mem`)

## Getting started

### Prerequisites

- Node.js 20 or newer
- PostgreSQL 14+ (optional for local development; without it, the app uses an in-memory database)
- A Google OAuth client (optional for local development; see below)

### Install and run

```bash
git clone https://github.com/avitalde13/greenlight.git
cd greenlight
npm install
cp .env.example .env
npm run dev
```

Open http://localhost:3000.

**Local development without Google:** when `GOOGLE_CLIENT_ID` is not set and `NODE_ENV` is not `production`, the sign-in page offers a **developer login** that lets you sign in with any email. It is disabled in production.

**Emails in local development:** with the default `EMAIL_PROVIDER=console`, nothing is really sent. Emails are printed in the terminal and listed at http://localhost:3000/dev/outbox, so you can click invite links while testing.

**Without an email provider:** in production with `EMAIL_PROVIDER` unset (or `none`), no emails are sent. After inviting someone, the Admin sees the invite link with a Copy button and shares it any way they like.

**Privacy and Terms:** public pages at `/privacy` and `/terms` (needed to publish the Google OAuth app). Edit `public/legal/` to match your organization.

### Google OAuth setup

1. In [Google Cloud Console](https://console.cloud.google.com/), create a project (for example *Approval Workflows*).
2. Open **Google Auth Platform → Branding** (the OAuth consent screen) and fill in the app name and support email. Under **Audience**, choose **External** and add your Google account as a **test user**. While the app is in *Testing*, only test users can sign in.
3. Open **Clients → Create client**, choose **Web application**, and add:
   - Authorized JavaScript origin: `http://localhost:3000`
   - Authorized redirect URI: `http://localhost:3000/auth/google/callback`

   For production, add your public URL and its `/auth/google/callback` too, and set `APP_URL` to match.
4. Run `./scripts/setup-google.sh` and paste the Client ID and Client secret. It writes them to `.env` (ignored by git), hiding the secret, and adds `APP_URL` and a random `SESSION_SECRET`.
5. Run `npm run dev` and click **Continue with Google**. The developer login turns off automatically once Google is configured.

The app reads `.env` on startup by itself, so this works on any Node version (variables already set in your shell win).

### Environment variables

| Variable | Required | Description |
|---|---|---|
| `DATABASE_URL` | In production | PostgreSQL connection string. Without it, an in-memory database is used. |
| `SESSION_SECRET` | In production | Long random string used to sign session cookies. |
| `GOOGLE_CLIENT_ID` | In production | Google OAuth client ID. |
| `GOOGLE_CLIENT_SECRET` | In production | Google OAuth client secret. |
| `APP_URL` | In production | Public base URL, used to build the OAuth redirect URI. Defaults to `http://localhost:3000`. |
| `PORT` | No | Port to listen on. Defaults to `3000`. |
| `EMAIL_PROVIDER` | No | `brevo`, `resend` or `none`. Defaults to `console` in development (printed, listed at /dev/outbox) and `none` in production (no emails; Admins copy the invite link and send it themselves). |
| `EMAIL_FROM` | With brevo or resend | Sender address (a verified sender in Brevo, or an address on a verified domain in Resend). |
| `EMAIL_FROM_NAME` | No | Sender name. Defaults to `Greenlight`. |
| `BREVO_API_KEY` | With Brevo | Brevo API key. |
| `RESEND_API_KEY` | With Resend | Resend API key. |
| `ANTHROPIC_API_KEY` | For AI | Turns on AI classification. Without it, only the rule checks run. |
| `AI_ENABLED` | No | `false` turns AI off even with a key; `true` turns it on with other Anthropic credentials. |
| `AI_MODEL` | No | Claude model for classification. Defaults to `claude-opus-5-5`. |

### Tests

```bash
npm test
```

## Project structure

```
greenlight/
├── migrations/          SQL schema, applied in order on startup
├── public/              Landing page, sign-in, app shell (HTML, CSS, JS), images and legal pages
├── src/
│   ├── app.js           Express app (routes and middleware)
│   ├── server.js        Starts the HTTP server
│   ├── config.js        Environment configuration
│   ├── db.js            Database pool and migrations
│   ├── auth/            Google OAuth and sessions
│   ├── email/           Email sending (Brevo, Resend, console) and templates
│   ├── routes/          API routes (workspaces, invitations, members, chains, requests, reports, time off, settings, notifications)
│   ├── permissions.js   Role checks and who may see a request
│   ├── insights/        Rule-based anomaly checks and AI classification
│   ├── chains.js        Approval chains and approver resolution
│   ├── routing.js       Out-of-office delegation when a step becomes active
│   ├── reminders.js     Reminders and escalation (runs every 15 minutes)
│   ├── notifier.js      In-app notifications, email and Slack
│   ├── budgets.js       Department budget usage and alerts
│   ├── currency.js      Base currency and exchange rates
│   ├── timeoff.js       Business days, balances and the calendar
│   ├── demo.js          The live demo company
│   └── audit.js         Append-only audit log
└── test/                Automated tests
```

## API

| Method | Path | Description |
|---|---|---|
| GET | `/auth/google` | Start Google sign-in |
| GET | `/auth/google/callback` | Google redirects here after sign-in |
| POST | `/auth/dev-login` | Developer login (local development only) |
| POST | `/auth/logout` | Sign out |
| GET | `/api/me` | Current user and their workspaces |
| POST | `/api/workspaces` | Create a workspace (`{ name }`); the creator becomes Admin |
| GET | `/api/workspaces/:id` | Workspace details and members (members only) |
| GET | `/api/workspaces/:id/invitations` | Pending invitations (Admins only) |
| POST | `/api/workspaces/:id/invitations` | Invite by email (`{ email, role }`); re-inviting sends a fresh link (Admins only) |
| DELETE | `/api/workspaces/:id/invitations/:inviteId` | Revoke an invitation (Admins only) |
| GET | `/auth/invitations/:token` | What an invite link is for (workspace, inviter, role, status) |
| POST | `/api/invitations/:token/accept` | Join the workspace (signed in with the invited email) |
| PATCH | `/api/workspaces/:id/members/:userId` | Change `role` and/or `manager_id` (Admins only) |
| DELETE | `/api/workspaces/:id/members/:userId` | Remove a member (Admins only) |
| GET | `/api/workspaces/:id/approval-chains` | Approval chains for all request types |
| PUT | `/api/workspaces/:id/approval-chains/:type` | Replace a chain (`{ steps: [{ name, approver_type, approver_user_id?, min_amount? }] }`, Admins only) |
| POST | `/api/workspaces/:id/requests` | Submit a request (`type`, `title`, `description?`, `amount`, `currency`, `vendor` or `start_date`/`end_date`) |
| GET | `/api/workspaces/:id/requests?scope=` | `mine`, `to_approve`, `team` (Managers) or `all` (Admins) |
| GET | `/api/workspaces/:id/requests/:requestId` | Request details and approval timeline |
| POST | `/api/workspaces/:id/requests/:requestId/decision` | `{ decision: "approve" \| "reject" \| "request_changes", comment }` (current approver) |
| POST | `/api/workspaces/:id/requests/:requestId/resubmit` | Edit and resubmit a request that was sent back (requester) |
| POST | `/api/workspaces/:id/requests/:requestId/cancel` | Cancel (requester, while pending or sent back) |
| POST | `/api/workspaces/:id/requests/:requestId/files` | Attach a receipt (`{ filename, content_type, data }`, base64; requester) |
| GET / DELETE | `/api/workspaces/:id/requests/:requestId/files/:fileId` | Open or remove a file |
| GET | `/api/workspaces/:id/reports?range=` | Dashboard numbers (`30d`, `90d`, `12m`, `all`; Managers and Admins) |
| GET | `/api/workspaces/:id/reports/export.csv?range=` | CSV export |
| GET | `/api/workspaces/:id/time-off/balance` · `/balances` · `/calendar?month=` | Your balance, team balances, who's out |
| PATCH | `/api/workspaces/:id/time-off/allowance/:userId` | Per-person vacation days (Admins) |
| GET / PATCH | `/api/workspaces/:id/settings` | Reminders, escalation, vacation days, base currency (Admins change) |
| PUT · POST | `/api/workspaces/:id/rates` · `/rates/refresh` | Exchange rates by hand, or today's ECB rates (Admins) |
| GET · POST · PATCH · DELETE | `/api/workspaces/:id/departments` | Departments and budgets (Admins change) |
| PUT · DELETE | `/api/workspaces/:id/slack` | Connect or disconnect Slack (Admins) |
| PUT · DELETE | `/api/workspaces/:id/away` | Your out-of-office dates and delegate |
| GET · POST | `/api/notifications` · `/api/notifications/read` | The bell |
| POST | `/auth/demo` · `/auth/demo/switch` | Start the live demo; view it as another person |
| POST | `/api/workspaces/:id/requests/:requestId/reanalyze` | Re-run the AI for a request (Admins only) |
| GET | `/api/workspaces/:id/audit-log?limit=&before=` | Audit log, newest first (Admins only) |

## License

[MIT](LICENSE)
