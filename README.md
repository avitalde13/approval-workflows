# Approval Workflows

**Multi-tenant approval and purchasing workflows for organizations.**

Employees submit requests (purchases, expenses, time off). Each request moves through a configurable approval chain, for example **Manager → Finance → VP**, with email notifications at every step and a complete audit trail. An AI layer classifies incoming requests and flags anomalies such as unusual amounts or first-time vendors.

---

## The problem

Large organizations keep hitting the same issues:

- **Scattered processes.** Requests live in email threads, spreadsheets and chat messages.
- **Unclear ownership.** Nobody knows who has to approve what, or where a request is stuck.
- **Weak controls.** Permissions are informal and there is no reliable record of who approved what.
- **Manual review.** Finance teams check every request by hand to spot the risky ones.

Approval Workflows puts every request in one place, routes it to the right people, records every decision, and highlights the requests that need a closer look.

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
| **AI classification** | Auto-categorize requests and flag anomalies (amount, new vendor) | 🔜 Milestone 4 |

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

### Milestone 4: AI
- [ ] Automatic request classification
- [ ] Anomaly detection (unusual amount, new vendor, duplicate request)

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

## Tech stack

- **Backend:** Node.js 20+, Express
- **Database:** PostgreSQL (migrations in `migrations/`)
- **Auth:** Google OAuth 2.0 / OpenID Connect, HTTP-only session cookies stored server-side
- **Email:** Brevo or Resend HTTP APIs (console outbox in development)
- **Frontend:** Plain HTML, CSS and JavaScript served by Express
- **Tests:** Node's built-in test runner (`node --test`) against an in-memory Postgres (`pg-mem`)

## Getting started

### Prerequisites

- Node.js 20 or newer
- PostgreSQL 14+ (optional for local development; without it, the app uses an in-memory database)
- A Google OAuth client (optional for local development; see below)

### Install and run

```bash
git clone https://github.com/avitalde13/approval-workflows.git
cd approval-workflows
npm install
cp .env.example .env
npm run dev
```

Open http://localhost:3000.

**Local development without Google:** when `GOOGLE_CLIENT_ID` is not set and `NODE_ENV` is not `production`, the sign-in page offers a **developer login** that lets you sign in with any email. It is disabled in production.

**Emails in local development:** with the default `EMAIL_PROVIDER=console`, nothing is really sent. Emails are printed in the terminal and listed at http://localhost:3000/dev/outbox, so you can click invite links while testing.

### Google OAuth setup

1. Open [Google Cloud Console → APIs & Services → Credentials](https://console.cloud.google.com/apis/credentials).
2. Create an **OAuth client ID** of type **Web application**.
3. Add the authorized redirect URI: `http://localhost:3000/auth/google/callback` (and your production URL's `/auth/google/callback`).
4. Copy the client ID and secret into `.env`.

### Environment variables

| Variable | Required | Description |
|---|---|---|
| `DATABASE_URL` | In production | PostgreSQL connection string. Without it, an in-memory database is used. |
| `SESSION_SECRET` | In production | Long random string used to sign session cookies. |
| `GOOGLE_CLIENT_ID` | In production | Google OAuth client ID. |
| `GOOGLE_CLIENT_SECRET` | In production | Google OAuth client secret. |
| `APP_URL` | In production | Public base URL, used to build the OAuth redirect URI. Defaults to `http://localhost:3000`. |
| `PORT` | No | Port to listen on. Defaults to `3000`. |
| `EMAIL_PROVIDER` | In production | `brevo` or `resend`. Defaults to `console` (development only). |
| `EMAIL_FROM` | In production | Sender address (a verified sender in Brevo, or an address on a verified domain in Resend). |
| `EMAIL_FROM_NAME` | No | Sender name. Defaults to `Approval Workflows`. |
| `BREVO_API_KEY` | With Brevo | Brevo API key. |
| `RESEND_API_KEY` | With Resend | Resend API key. |

### Tests

```bash
npm test
```

## Project structure

```
approval-workflows/
├── migrations/          SQL schema, applied in order on startup
├── public/              Sign-in page and app shell (HTML, CSS, JS)
├── src/
│   ├── app.js           Express app (routes and middleware)
│   ├── server.js        Starts the HTTP server
│   ├── config.js        Environment configuration
│   ├── db.js            Database pool and migrations
│   ├── auth/            Google OAuth and sessions
│   ├── email/           Email sending (Brevo, Resend, console) and templates
│   ├── routes/          API routes (workspaces, invitations, members, chains, requests, audit log)
│   ├── permissions.js   Role checks and who may see a request
│   ├── chains.js        Approval chains and approver resolution
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
| POST | `/api/workspaces/:id/requests/:requestId/decision` | `{ decision: "approve" \| "reject", comment }` (current approver) |
| POST | `/api/workspaces/:id/requests/:requestId/cancel` | Cancel (requester, while pending) |
| GET | `/api/workspaces/:id/audit-log?limit=&before=` | Audit log, newest first (Admins only) |

## License

[MIT](LICENSE)
