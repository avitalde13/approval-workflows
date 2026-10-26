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
| **Invitations** | Invite teammates by email | 🔜 Milestone 2 |
| **Notifications** | Email alerts when a request needs approval or changes status | 🔜 Milestone 2 |
| **Roles** | Admin, Manager and Employee permissions | 🟡 Roles stored, enforcement in Milestone 3 |
| **Approval chains** | Multi-step approvals (Manager → Finance → VP) | 🔜 Milestone 3 |
| **Audit log** | Immutable record of every action | 🔜 Milestone 3 |
| **AI classification** | Auto-categorize requests and flag anomalies (amount, new vendor) | 🔜 Milestone 4 |

## Roadmap

### Milestone 1: Authentication and workspaces ✅
- [x] Google sign-in with secure, server-side sessions
- [x] Create a workspace; the creator becomes its Admin
- [x] Workspace isolation: users only see workspaces they belong to
- [x] Switch between workspaces
- [x] Automated tests

### Milestone 2: Email
- [ ] Invite users to a workspace by email
- [ ] Notification emails for pending approvals and status changes

### Milestone 3: Permissions and approvals
- [ ] Role-based access control (Admin, Manager, Employee)
- [ ] Request submission (purchase, expense, time off)
- [ ] Configurable approval chains
- [ ] Audit log of every action

### Milestone 4: AI
- [ ] Automatic request classification
- [ ] Anomaly detection (unusual amount, new vendor, duplicate request)

## Tech stack

- **Backend:** Node.js 20+, Express
- **Database:** PostgreSQL (migrations in `migrations/`)
- **Auth:** Google OAuth 2.0 / OpenID Connect, HTTP-only session cookies stored server-side
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
│   └── routes/          API routes (workspaces, current user)
└── test/                Automated tests
```

## API (Milestone 1)

| Method | Path | Description |
|---|---|---|
| GET | `/auth/google` | Start Google sign-in |
| GET | `/auth/google/callback` | Google redirects here after sign-in |
| POST | `/auth/dev-login` | Developer login (local development only) |
| POST | `/auth/logout` | Sign out |
| GET | `/api/me` | Current user and their workspaces |
| POST | `/api/workspaces` | Create a workspace (`{ name }`); the creator becomes Admin |
| GET | `/api/workspaces/:id` | Workspace details and members (members only) |

## License

[MIT](LICENSE)
