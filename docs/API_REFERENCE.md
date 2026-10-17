# TenderIQ API Reference

> **Frontend status:** this repository contains **no frontend**. There is no `frontend/`,
> `client/` or `web/` directory, no `.jsx`/`.tsx`/`.vue`/`.html` files, and no browser HTTP
> client code. The only `axios` usages are server-side (`src/utils/http.js` for scraping and
> `src/libs/adapters/channel/telegram.js` for outbound bot calls), which are not
> frontend-to-server requests.
>
> Consequently **every endpoint below is currently uncalled by any frontend in this repo**.
> Rather than repeat that on all 45 entries, the endpoints are documented normally by
> feature, and [Backend endpoints not currently used by frontend](#backend-endpoints-not-currently-used-by-frontend)
> records the situation once. No "Backend endpoint not found" entries exist, because there
> are no frontend requests to cross-check.

All paths are relative to the base path **`/api/v1`**.

---

## Table of contents

### Conventions
- [Response envelope](#response-envelope)
- [Authentication](#authentication)
- [Authorization gates](#authorization-gates)
- [Pagination](#pagination)
- [Global error codes](#global-error-codes)

### System
- [Health check](#health-check) — `GET /health`

### Authentication
- [Register](#register) — `POST /auth/register`
- [Log in](#log-in) — `POST /auth/login`
- [Refresh session](#refresh-session) — `POST /auth/refresh`
- [Log out](#log-out) — `POST /auth/logout`
- [Verify email](#verify-email) — `POST /auth/verify-email`
- [Resend verification email](#resend-verification-email) — `POST /auth/verify-email/resend`
- [Request password reset](#request-password-reset) — `POST /auth/forgot-password`
- [Check reset code](#check-reset-code) — `POST /auth/verify-reset-code`
- [Reset password](#reset-password) — `POST /auth/reset-password`
- [Switch organization](#switch-organization) — `POST /auth/switch-org`
- [Current user](#current-user) — `GET /auth/me`

### Tenders (discovery)
- [List tenders](#list-tenders) — `GET /tenders`
- [Tender detail](#tender-detail) — `GET /tenders/:id`

### Saved searches
- [List saved searches](#list-saved-searches) — `GET /saved-searches`
- [Create saved search](#create-saved-search) — `POST /saved-searches`
- [Update saved search](#update-saved-search) — `PATCH /saved-searches/:id`
- [Delete saved search](#delete-saved-search) — `DELETE /saved-searches/:id`

### Tracked tenders (bid pipeline)
- [List tracked tenders](#list-tracked-tenders) — `GET /tracked-tenders`
- [Pipeline board counts](#pipeline-board-counts) — `GET /tracked-tenders/board`
- [Bid performance](#bid-performance) — `GET /tracked-tenders/performance`
- [Track a tender](#track-a-tender) — `POST /tracked-tenders`
- [Tracked tender detail](#tracked-tender-detail) — `GET /tracked-tenders/:id`
- [Update tracked tender](#update-tracked-tender) — `PATCH /tracked-tenders/:id`
- [Untrack a tender](#untrack-a-tender) — `DELETE /tracked-tenders/:id`
- [Save draft bid](#save-draft-bid) — `PUT /tracked-tenders/:id/bid`
- [Submit bid](#submit-bid) — `POST /tracked-tenders/:id/bid/submit`
- [Delete draft bid](#delete-draft-bid) — `DELETE /tracked-tenders/:id/bid`

### Bid checklist (AI)
- [Get checklist](#get-checklist) — `GET /tracked-tenders/:id/checklist`
- [Generate checklist](#generate-checklist) — `POST /tracked-tenders/:id/checklist/generate`
- [Add checklist item](#add-checklist-item) — `POST /tracked-tenders/:id/checklist/items`
- [Update checklist item](#update-checklist-item) — `PATCH /tracked-tenders/checklist/items/:itemId`
- [Attach document to checklist item](#attach-document-to-checklist-item) — `PATCH /tracked-tenders/checklist/items/:itemId/document`
- [Delete checklist item](#delete-checklist-item) — `DELETE /tracked-tenders/checklist/items/:itemId`

### Organization
- [List fields](#list-fields) — `GET /fields`
- [Create organization](#create-organization) — `POST /organizations`
- [Get organization](#get-organization) — `GET /organization`
- [Update organization](#update-organization) — `PATCH /organization`
- [List members](#list-members) — `GET /organization/members`
- [Change a member's role](#change-a-members-role) — `PATCH /organization/members/:userId`
- [Remove a member](#remove-a-member) — `DELETE /organization/members/:userId`
- [Leave the organization](#leave-the-organization) — `POST /organization/leave`
- [Transfer ownership](#transfer-ownership) — `POST /organization/transfer-ownership`
- [Delete the organization](#delete-the-organization) — `DELETE /organization`
- [Invite a member](#invite-a-member) — `POST /organization/invitations`
- [List sent invitations](#list-sent-invitations) — `GET /organization/invitations`
- [Cancel an invitation](#cancel-an-invitation) — `DELETE /organization/invitations/:id`
- [Get supplier identity](#get-supplier-identity) — `GET /organization/supplier-identity`
- [Set supplier identity](#set-supplier-identity) — `PUT /organization/supplier-identity`
- [Search supplier candidates](#search-supplier-candidates) — `GET /organization/supplier-identity/candidates`

### Invitations (addressed to me)
- [List my invitations](#list-my-invitations) — `GET /invitations`
- [Accept an invitation](#accept-an-invitation) — `POST /invitations/:id/accept`
- [Decline an invitation](#decline-an-invitation) — `POST /invitations/:id/decline`

### Document vault
- [List vault documents](#list-vault-documents) — `GET /vault-documents`
- [Vault summary](#vault-summary) — `GET /vault-documents/summary`
- [Vault upload options](#vault-upload-options) — `GET /vault-documents/options`
- [Register document (get upload URL)](#register-document-get-upload-url) — `POST /vault-documents`
- [Confirm upload](#confirm-upload) — `POST /vault-documents/:id/confirm`
- [Vault document detail](#vault-document-detail) — `GET /vault-documents/:id`
- [Download link](#download-link) — `GET /vault-documents/:id/download`
- [Update vault document](#update-vault-document) — `PATCH /vault-documents/:id`
- [Delete vault document](#delete-vault-document) — `DELETE /vault-documents/:id`

### Notifications
- [List notifications](#list-notifications) — `GET /notifications`
- [Mark notification read](#mark-notification-read) — `PATCH /notifications/:id/read`

### Intelligence (Pro+)
- [Tender benchmark](#tender-benchmark) — `GET /tenders/:id/benchmark`
- [Competitor prices](#competitor-prices) — `GET /tenders/:id/competitor-prices`
- [AI price recommendation](#ai-price-recommendation) — `GET /tenders/:id/price-recommendation`
- [Category benchmark](#category-benchmark) — `GET /benchmarks/:cpv`
- [Expected competition](#expected-competition) — `GET /competition`
- [Supplier profile](#supplier-profile) — `GET /suppliers/:id/profile`
- [Buyer profile](#buyer-profile) — `GET /buyers/:id/profile`

### Integrations
- [List Telegram links](#list-telegram-links) — `GET /integrations/telegram`
- [Create Telegram link](#create-telegram-link) — `POST /integrations/telegram/link`
- [List email alert subscriptions](#list-email-alert-subscriptions) — `GET /integrations/email`
- [Switch email alerts on](#switch-email-alerts-on) — `POST /integrations/email`
- [Switch email alerts off](#switch-email-alerts-off) — `DELETE /integrations/email/:id`
- [Unlink Telegram chat](#unlink-telegram-chat) — `DELETE /integrations/telegram/:id`
- [Switch a destination back on](#switch-a-destination-back-on) — `POST /integrations/{telegram,email}/:id/enable`
- [Telegram webhook](#telegram-webhook) — `POST /integrations/telegram/webhook`

### Unsubscribe (no login)
- [Preview an unsubscribe link](#preview-an-unsubscribe-link) — `GET /unsubscribe`
- [Confirm unsubscribe](#confirm-unsubscribe) — `POST /unsubscribe`

### Appendix
- [Backend endpoints not currently used by frontend](#backend-endpoints-not-currently-used-by-frontend)
- [Summary table](#summary-table)

---

## Conventions

### Response envelope

Defined in [src/utils/respond.js](src/utils/respond.js). Every success body is
`{ "data": ... }`, with `meta` added on paginated collections. Every failure body is
`{ "error": { "code", "message", "details?" } }` — see [src/middlewares/error.js](src/middlewares/error.js).

Success (single resource):

```json
{
  "data": { }
}
```

Success (paginated collection):

```json
{
  "data": [],
  "meta": {
    "cursor": "MjAyNi0wOC0xNFQwOTozMDowMC4wMDBafGNtOXo...",
    "hasMore": true
  }
}
```

Failure:

```json
{
  "error": {
    "code": "VALIDATION_FAILED",
    "message": "The request failed validation.",
    "details": [
      { "field": "email", "message": "\"email\" must be a valid email" }
    ]
  }
}
```

### Authentication

Mechanism: **JWT Bearer access token** in the `Authorization` header
([src/middlewares/auth.js](src/middlewares/auth.js)).

**Headers:**

- `Authorization`: `Bearer <accessToken>` — required on every endpoint except `GET /health`,
  the nine `POST /auth/*` endpoints, and `POST /integrations/telegram/webhook`.
- `Content-Type`: `application/json` — required on requests carrying a body. JSON bodies are
  capped at 1 MB.

Access-token claims (`sub`, `org`, `role`, `plan`, `jti`) become `req.user`. Default lifetime
is 15 minutes (`ACCESS_TOKEN_ACTIVE_TIME`); refresh tokens last 20 days
(`REFRESH_TOKEN_ACTIVE_TIME`) and are single-use — reusing one revokes the whole family.

### Authorization gates

Four gates run in order ([src/middlewares/authorize.js](src/middlewares/authorize.js),
[src/libs/permissions.js](src/libs/permissions.js)):

1. valid token → else `401 UNAUTHENTICATED` / `401 TOKEN_EXPIRED`
2. the session is in an organization → else `403 NO_ORGANIZATION`; then the role holds the
   permission → else `403 ROLE_FORBIDDEN`
3. resource `organization_id` matches the token's org → enforced in repositories; a
   cross-tenant id answers `404 NOT_FOUND` rather than confirming the row exists
4. plan entitles the feature → else `402 PLAN_UPGRADE_REQUIRED`

| Role | Permissions |
|---|---|
| `owner` | `org:manage`, `user:manage`, `billing:manage`, `tender:read`, `intelligence:read`, `savedsearch:write`, `trackedtender:write`, `bid:write`, `vault:write`, `vault:read`, `report:export` |
| `admin` | same as owner minus `billing:manage` |
| `coordinator` | `tender:read`, `intelligence:read`, `savedsearch:write`, `trackedtender:write`, `bid:write`, `vault:write`, `vault:read`, `report:export` |
| `viewer` | `tender:read`, `intelligence:read`, `vault:read` (read-only) |
| `consultant` | identical to `coordinator` — a label recording that the member is external, not a distinct permission set |

**Rank rule.** `user:manage` actions on a member (role change, removal) also require the caller to
outrank the target: the `owner` acts on anyone; an `admin` acts only on `coordinator`, `viewer` and
`consultant` — never on another admin or the owner. The same rule covers the role being **granted**:
an admin may not promote anyone to `admin` or invite at `admin`; only the owner may. A refusal is
`403 ROLE_FORBIDDEN` (not `404`),
and the caller's role is re-read from the database for these actions rather than trusted from the
token.

`intelligence:read` is additionally plan-gated to `pro`, `business`, `enterprise`. Sending an
invitation is plan-gated the same way (feature key `invitations`), but only sending: every other
`user:manage` action stays role-gated, so a downgraded organization can always shrink.

#### The orgless state

A verified user with no membership — someone who has just registered, or who has just been
removed from their last organization; the API does not distinguish them — holds a real session
whose claims carry `org`, `role` and `plan` as `null`. Every endpoint behind a permission answers
`403 NO_ORGANIZATION`, refused at token verification itself. The allowlist is explicit —
the routes mounted on `authenticateOrgless` ([src/middlewares/auth.js](src/middlewares/auth.js)):
[Create organization](#create-organization), [List fields](#list-fields) (the picker on that
screen), [the invitations addressed to the caller](#list-my-invitations),
[Switch organization](#switch-organization) (the way out for a second device still holding an
orgless session), and [Current user](#current-user). [Refresh](#refresh-session) and
[Log out](#log-out) take no bearer token. The client's locked screen
is presentation; the null claims are the enforcement.

### Pagination

Cursor-based, using bracket syntax: `?page[size]=20&page[cursor]=<opaque>`. `page[size]` is
1–100, default 20. The cursor is an opaque base64url string; treat it as unparseable and pass
back `meta.cursor` verbatim. `meta.hasMore` says whether another page exists.

### Global error codes

From [src/utils/errors.js](src/utils/errors.js). Any of these may surface on any endpoint.

| Code | Status | Meaning |
|---|---|---|
| `VALIDATION_FAILED` | 422 | Request failed Joi validation. `details` is an array of `{ field, message }`. |
| `UNAUTHENTICATED` | 401 | Missing, malformed or invalid Bearer token. |
| `TOKEN_EXPIRED` | 401 | Access token expired — refresh rather than re-login. |
| `PLAN_UPGRADE_REQUIRED` | 402 | Role allows it, plan does not. |
| `ROLE_FORBIDDEN` | 403 | Role lacks the permission. |
| `EMAIL_UNVERIFIED` | 403 | Address not confirmed. |
| `NO_ORGANIZATION` | 403 | The session is in no organization (see [the orgless state](#the-orgless-state)). `details.permission`. |
| `TENANT_FORBIDDEN` | 403 | Resource belongs to another organization. |
| `NOT_FOUND` | 404 | No such resource (also returned for cross-tenant ids). |
| `CONFLICT` | 409 | Conflicts with current state. |
| `RATE_LIMITED` | 429 | Request budget exhausted. `details.retryAfterSeconds`. |
| `QUOTA_EXCEEDED` | 429 | A counted cap was reached — today only the three-organizations-per-account cap on `POST /organizations`. `details.limit`. |
| `INTERNAL_ERROR` | 500 | Unexpected error. `details.ref` is a correlation id for support. |
| `DEPENDENCY_UNAVAILABLE` | 503 | Storage, Telegram or the AI layer is unavailable/unconfigured. |

Rate limiting ([src/middlewares/rateLimit.js](src/middlewares/rateLimit.js)) keys on user id
when authenticated, IP otherwise, and sets `X-RateLimit-Limit`, `X-RateLimit-Remaining`, and
`Retry-After` on a 429. Budgets: global 300/min; `/auth/*` 10/min; `/auth/forgot-password`
and `/auth/verify-email/resend` 5/hour; `/auth/verify-reset-code` and `/auth/reset-password`
10/10min; `POST /organizations` 10/hour per user; `POST /organization/invitations` 60/hour per user; accepting or declining 30/min per user; `POST /auth/switch-org` 30/min per user; the
Telegram webhook 120/min.

---

## System

## Health check

Liveness plus ingestion-pipeline health — data freshness per source, dead-letter counts, and
queue backlog. Unauthenticated so an uptime probe can reach it. A degraded pipeline still
answers `200`; the `severity` field carries the verdict.

**API:**
`GET /api/v1/health`

**Authentication:** not required.

**Request data:**

No request body

**Response data:**

```json
{
  "data": {
    "severity": "ok",
    "at": "2026-09-05T10:14:22.019Z",
    "checks": [
      {
        "check": "freshness",
        "source": "armeps",
        "severity": "ok",
        "ageMinutes": 7,
        "slaMinutes": 15,
        "detail": "ARMEPS e-auction: 7m since last sweep"
      },
      {
        "check": "dead_letters",
        "queue": "ingest",
        "severity": "ok",
        "failed": 0,
        "threshold": 5,
        "detail": "ingest: 0 dead-lettered job(s)"
      },
      {
        "check": "dead_letters_total",
        "severity": "ok",
        "failed": 0,
        "threshold": 5,
        "detail": "0 dead-lettered job(s) across all queues (alert above 5)"
      },
      {
        "check": "backlog",
        "queue": "ingest",
        "severity": "ok",
        "pending": 3,
        "active": 1,
        "threshold": 500,
        "detail": "ingest: 3 pending, 1 active"
      }
    ]
  }
}
```

`severity` is `ok`, `warn` or `alert` — the worst of the individual checks. The number of
`checks` entries varies with the number of enabled sources and queues. The internal
`sample` field (a verbatim worker exception) is stripped by `publicReport` and never
crosses this boundary.

---

## Authentication

## Register

Creates a user — **and only a user** — then emails a verification link. No organization is
created: after confirming and signing in, the user is in the [orgless state](#the-orgless-state)
and either [creates an organization](#create-organization) or accepts an invitation. Returns
**no tokens** — login refuses an unconfirmed address, so a session minted here would be rejected
by the very next request.

**API:**
`POST /api/v1/auth/register`

**Authentication:** not required.

**Request data:**

```json
{
  "email": "procurement@shinarar.am",
  "password": "correct horse battery staple",
  "displayName": "Gevorg Sargsyan",
  "locale": "hy"
}
```

- `email` (**required**): valid email, lowercased, max 255 chars.
- `password` (**required**): 12–200 chars. Length only — no composition rules.
- `displayName` (**required**): trimmed, 1–120 chars. What this person is called on the member
  roster; without it a team's member list is a list of email addresses.
- `locale` (optional): `hy` | `ru` | `en`. Default `hy`.

**Response data:**

`201 Created`

```json
{
  "data": {
    "user": {
      "id": "cm9zx4k1p0000qw8f3h2l7d5t",
      "email": "procurement@shinarar.am",
      "displayName": "Gevorg Sargsyan",
      "locale": "hy",
      "emailVerified": false
    },
    "verificationRequired": true,
    "verificationSent": true,
    "message": "Check your email to confirm your address, then sign in."
  }
}
```

`verificationSent` is `false` when the mail send failed — the account still exists, and
`/auth/verify-email/resend` is the recovery path.

**Errors:**

- `409 CONFLICT`: "That email is already registered."
- `422 VALIDATION_FAILED`: bad email, short password, missing display name.
- `429 RATE_LIMITED`: more than 10 requests/minute from this IP.

Unknown fields — including the old `organizationName` — are stripped, not stored.

---

## Log in

Verifies a password and mints a session. Unknown email and wrong password return the identical
error, so the endpoint cannot be used to discover who holds an account.

**API:**
`POST /api/v1/auth/login`

**Authentication:** not required.

**Request data:**

```json
{
  "email": "procurement@shinarar.am",
  "password": "correct horse battery staple"
}
```

- `email` (**required**): valid email, lowercased.
- `password` (**required**): max 200 chars.

**Response data:**

```json
{
  "data": {
    "accessToken": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...",
    "refreshToken": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...",
    "expiresIn": 900,
    "user": {
      "id": "cm9zx4k1p0000qw8f3h2l7d5t",
      "email": "procurement@shinarar.am",
      "displayName": "Gevorg Sargsyan",
      "locale": "hy",
      "emailVerified": true
    },
    "organization": {
      "id": "cm9zx4k1p0001qw8f6b3n2v8y",
      "name": "Shinarar LLC"
    },
    "role": "owner",
    "plan": "free",
    "organizations": [
      { "id": "cm9zx4k1p0001qw8f6b3n2v8y", "name": "Shinarar LLC", "role": "owner" }
    ]
  }
}
```

`expiresIn` is the access token's lifetime in seconds. `organizations` is every membership the
user holds, in the order they were joined (oldest first); the session is minted for the first
one, and the ids are what [Switch organization](#switch-organization) takes.

A user with **no membership** still signs in successfully, into the
[orgless state](#the-orgless-state):

```json
{
  "data": {
    "accessToken": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...",
    "refreshToken": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...",
    "expiresIn": 900,
    "user": {
      "id": "cm9zx4k1p0000qw8f3h2l7d5t",
      "email": "procurement@shinarar.am",
      "displayName": "Gevorg Sargsyan",
      "locale": "hy",
      "emailVerified": true
    },
    "organization": null,
    "role": null,
    "plan": null,
    "organizations": []
  }
}
```

**Errors:**

- `401 UNAUTHENTICATED`: "Email or password is incorrect."
- `403 EMAIL_UNVERIFIED`: address not confirmed; `details.email` carries the address.
- `422 VALIDATION_FAILED`: malformed body.
- `429 RATE_LIMITED`: more than 10 requests/minute from this IP.

---

## Refresh session

Exchanges a refresh token for a new pair. Each refresh token is single-use; presenting one that
verifies but is no longer tracked revokes the entire token family, because a replay and a stolen
copy are indistinguishable. Role and plan are re-read from the database rather than copied from
the old token, so a downgrade takes effect within one access-token lifetime.

**API:**
`POST /api/v1/auth/refresh`

**Authentication:** not required (the refresh token in the body is the credential).

**Request data:**

```json
{
  "refreshToken": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9..."
}
```

- `refreshToken` (**required**): min 20 chars.

**Response data:**

```json
{
  "data": {
    "accessToken": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...",
    "refreshToken": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...",
    "expiresIn": 900,
    "role": "owner",
    "plan": "free"
  }
}
```

Note this response carries **no** `user` or `organization` block, unlike login.

An orgless refresh token refreshes into another orgless pair (`role` and `plan` both `null`).
It stays orgless even if the user has gained a membership since — moving into a tenant is
[Switch organization](#switch-organization), never a side effect of a refresh.

**Errors:**

- `401 UNAUTHENTICATED`: token invalid or expired; token reuse detected (family revoked, sign
  in again); user no longer exists; the token names an organization the user is no longer a
  member of.
- `422 VALIDATION_FAILED`: missing or short `refreshToken`.
- `429 RATE_LIMITED`: more than 10 requests/minute from this IP.

---

## Log out

Revokes the refresh token's whole family. Idempotent: an unparseable token is already useless,
so it answers `200` with `revoked: false` rather than an error.

**API:**
`POST /api/v1/auth/logout`

**Authentication:** not required (no rate limit on this route).

**Request data:**

```json
{
  "refreshToken": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9..."
}
```

- `refreshToken` (**required**): min 20 chars.

**Response data:**

```json
{
  "data": {
    "revoked": true
  }
}
```

**Errors:**

- `422 VALIDATION_FAILED`: missing or short `refreshToken`.

---

## Verify email

Confirms an address from the emailed token. The token travels in the body, not a query string —
a URL would leak it to the referrer, browser history and proxy logs — so the emailed link lands
on a client page that POSTs it here.

**API:**
`POST /api/v1/auth/verify-email`

**Authentication:** not required.

**Request data:**

```json
{
  "token": "hK3nQ7vZ2mR8sT1xW5yB9cE4gJ6lN0pA2dF8hK3nQ7v"
}
```

- `token` (**required**): trimmed, 20–200 chars (32 random bytes base64url = 43 chars).

**Response data:**

```json
{
  "data": {
    "verified": true,
    "alreadyVerified": false,
    "email": "procurement@shinarar.am",
    "message": "Your email address is confirmed. You can sign in now."
  }
}
```

`alreadyVerified: true` means a double-click, not a failure.

**Errors:**

- `404 NOT_FOUND`: "Account not found."
- `422 VALIDATION_FAILED`: `details[0].field` is `token` — "That confirmation link is invalid
  or has expired."
- `429 RATE_LIMITED`: more than 10 requests/minute from this IP.

---

## Resend verification email

Sends a fresh confirmation link. Answers identically for an unknown address, an already-verified
one, and a successful send — otherwise it would report which addresses are registered.

**API:**
`POST /api/v1/auth/verify-email/resend`

**Authentication:** not required.

**Request data:**

```json
{
  "email": "procurement@shinarar.am"
}
```

- `email` (**required**): valid email, lowercased.

**Response data:**

```json
{
  "data": {
    "sent": true,
    "message": "If that address needs confirming, a new link is on its way."
  }
}
```

Always this exact object, regardless of input.

**Errors:**

- `422 VALIDATION_FAILED`: malformed email.
- `429 RATE_LIMITED`: more than 5 requests/hour from this IP.

---

## Request password reset

Emails a six-digit reset code. Always reports success — the response, status and work done are
the same whether or not the address is known.

**API:**
`POST /api/v1/auth/forgot-password`

**Authentication:** not required.

**Request data:**

```json
{
  "email": "procurement@shinarar.am"
}
```

- `email` (**required**): valid email, lowercased.

**Response data:**

```json
{
  "data": {
    "sent": true,
    "message": "If that address has an account, a reset code is on its way."
  }
}
```

Always this exact object, regardless of input.

**Errors:**

- `422 VALIDATION_FAILED`: malformed email.
- `429 RATE_LIMITED`: more than 5 requests/hour from this IP.

---

## Check reset code

Validates a code **without spending it**, so a client can check it on the screen where it was
typed before asking for a new password. A wrong guess still costs an attempt — the per-code
ceiling burns the code on the fifth failure — or this endpoint would be the unlimited oracle
that ceiling exists to prevent.

**API:**
`POST /api/v1/auth/verify-reset-code`

**Authentication:** not required.

**Request data:**

```json
{
  "email": "procurement@shinarar.am",
  "code": "480219"
}
```

- `email` (**required**): valid email, lowercased.
- `code` (**required**): exactly six digits.

**Response data:**

```json
{
  "data": {
    "valid": true,
    "message": "Code confirmed. Choose a new password."
  }
}
```

**Errors:**

- `422 VALIDATION_FAILED`: `details[0].field` is `code` — "That code is not correct." or
  "That code has expired. Request a new one."
- `429 RATE_LIMITED`: "Too many incorrect codes. Request a new one."
  (`details.reason: "code_burned"`), or more than 10 requests/10 minutes from this IP.

---

## Reset password

Spends the code, replaces the hash, marks the address verified, and revokes every session. The
revocation is the point of a reset — leaving old refresh tokens alive would preserve the access
it was meant to remove. Reading a code out of the inbox is stronger proof of the address than
the confirmation link, so the account is verified by this act.

**API:**
`POST /api/v1/auth/reset-password`

**Authentication:** not required.

**Request data:**

```json
{
  "email": "procurement@shinarar.am",
  "code": "480219",
  "newPassword": "a much longer replacement phrase"
}
```

- `email` (**required**): valid email, lowercased.
- `code` (**required**): exactly six digits.
- `newPassword` (**required**): 12–200 chars.

**Response data:**

```json
{
  "data": {
    "reset": true,
    "emailVerified": true,
    "verifiedByReset": false,
    "sessionsRevoked": 2,
    "message": "Your password has been changed and all sessions were signed out."
  }
}
```

`verifiedByReset` is `true` when this reset is what confirmed a previously unverified address.

**Errors:**

- `404 NOT_FOUND`: "Account not found."
- `422 VALIDATION_FAILED`: wrong or expired code; short password.
- `429 RATE_LIMITED`: code burned after five failed attempts, or more than 10 requests/10
  minutes from this IP.

---

## Switch organization

Re-mints the session against another of the caller's own memberships — the consultant moving
between client tenants. **No permission is checked**: choosing which tenant to act in is not an
act inside one, and holding the membership is the authority.

It starts a **new refresh family** rather than rotating the current one, so the refresh token
for the organization being left keeps working; switching back and forth during a day never
signs anyone out.

**API:**
`POST /api/v1/auth/switch-org`

**Authentication:** required (Bearer). No permission check.

**Request data:**

```json
{
  "organizationId": "cm9zx4k1p0301qw8fd8k2m4q6"
}
```

- `organizationId` (**required**): 1–64 chars. Must be an organization the caller is a member
  of.

**Response data:**

Same shape as [Log in](#log-in), minted for the requested organization:

```json
{
  "data": {
    "accessToken": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...",
    "refreshToken": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...",
    "expiresIn": 900,
    "user": {
      "id": "cm9zx4k1p0000qw8f3h2l7d5t",
      "email": "consultant@example.am",
      "displayName": "Anahit Petrosyan",
      "locale": "hy",
      "emailVerified": true
    },
    "organization": { "id": "cm9zx4k1p0301qw8fd8k2m4q6", "name": "Client B LLC" },
    "role": "consultant",
    "plan": "free",
    "organizations": [
      { "id": "cm9zx4k1p0001qw8f6b3n2v8y", "name": "Advisory LLC", "role": "owner" },
      { "id": "cm9zx4k1p0301qw8fd8k2m4q6", "name": "Client B LLC", "role": "consultant" }
    ]
  }
}
```

**Errors:**

- `401 UNAUTHENTICATED` / `401 TOKEN_EXPIRED`.
- `404 NOT_FOUND`: "Organization not found." — the caller holds no membership there. Not
  `403`, so the endpoint cannot be used to learn which organization ids exist.
- `422 VALIDATION_FAILED`: missing `organizationId`.
- `429 RATE_LIMITED`: more than 30 switches/minute for this user.

---

## Current user

Returns the token's own claims — what a client needs on boot to know who it is signed in as.
It reads `req.user` directly and performs **no database lookup**, so it reflects the token, not
the current database state.

**API:**
`GET /api/v1/auth/me`

**Authentication:** required (Bearer). No permission check.

**Request data:**

No request body

**Response data:**

```json
{
  "data": {
    "id": "cm9zx4k1p0000qw8f3h2l7d5t",
    "organizationId": "cm9zx4k1p0001qw8f6b3n2v8y",
    "role": "owner",
    "plan": "free",
    "tokenId": "cm9zx4k1p0002qw8f9m4c1r7k"
  }
}
```

For an orgless session `organizationId`, `role` and `plan` are all `null`.

**Errors:**

- `401 UNAUTHENTICATED` / `401 TOKEN_EXPIRED`.

---

## Tenders (discovery)

## List tenders

Filtered, cursor-paginated search over the public tender corpus. Not tenant-scoped — public
procurement data is the same for every organization. A CPV filter matches the tender's headline
code **or any of its lots**, and only `is_latest` rows are returned, so an amended tender
appears once at its current version.

**API:**
`GET /api/v1/tenders`

**Authentication:** required (Bearer). Permission: `tender:read` (all roles).

**Request data:**

No request body

**Query parameters:**

- `filter[cpv]` (optional): CPV code, or several — repeated params, a comma-separated string,
  or `filter[cpv][]` array items. Each max 20 chars.
- `filter[keyword]` (optional): free-text search, max 200 chars. Empty string allowed.
- `filter[buyerId]` (optional): buyer party id, max 40 chars.
- `filter[region]` (optional): buyer region, max 100 chars.
- `filter[procedure]` (optional): one of `open`, `quotation`, `single_source`, `e_auction`,
  `restricted`. (The only live source produces `e_auction` exclusively.)
- `filter[status]` (optional): one or several of `planned`, `active`, `amended`, `closed`,
  `awarded`, `cancelled`.
- `filter[minValue]` (optional): number ≥ 0.
- `filter[maxValue]` (optional): number ≥ 0.
- `filter[deadlineAfter]` (optional): ISO-8601 date.
- `filter[deadlineBefore]` (optional): ISO-8601 date.
- `filter[purchaseKind]` (optional): one or several of `goods`, `works`, `services` — the
  source's own label on every tender (Ապրանք / Աշխատանք / Ծառայություն). Anything else is a
  `422`, not an empty list.
- `filter[field]` (optional): one or several [field](#list-fields) ids — repeat the parameter
  for several; any of them matches. Resolved to the field's CPV prefixes and matched against the
  headline code **or any lot**, like `filter[cpv]`, so a tender whose lot 7 of 18 is medical is
  returned for `medical`. A tender with no CPV code anywhere matches no field. An unknown id is a
  `422`.
- `page[size]` (optional): 1–100, default 20.
- `page[cursor]` (optional): opaque cursor from a previous `meta.cursor`, max 200 chars.

Undeclared query parameters are stripped by validation and never reach the repository.

Example: `GET /api/v1/tenders?filter[status]=active&filter[purchaseKind]=services&page[size]=20`

**Response data:**

```json
{
  "data": [
    {
      "id": "cm9zx4k1p0010qw8fj3k9d2p1",
      "sourceId": "armeps:284391",
      "title": "Շինարարական աշխատանքների գնում",
      "referenceCode": "ՀՀ-ԳՀԱՊՁԲ-24/118",
      "cpvCode": "45000000",
      "procedureType": "e_auction",
      "purchaseKind": "works",
      "status": "active",
      "sourceStatus": "Ընթացիկ",
      "estimatedValue": 12750000,
      "currency": "AMD",
      "publishedAt": "2026-08-14T09:30:00.000Z",
      "deadlineAt": "2026-09-12T11:00:00.000Z",
      "auctionAt": "2026-09-13T10:00:00.000Z",
      "buyer": {
        "id": "cm9zx4k1p0020qw8fh7v2x4m6",
        "name": "«Երևանի քաղաքապետարան» ՀՈԱԿ",
        "region": "Երևան"
      }
    }
  ],
  "meta": {
    "cursor": "MjAyNi0wOC0xNFQwOTozMDowMC4wMDBafGNtOXp4NGsxcDAwMTBxdzhmajNrOWQycDE",
    "hasMore": true
  }
}
```

`estimatedValue` is `null` when unknown; `deadlineAt` and `auctionAt` are nullable — some
notices carry neither.
`purchaseKind` is `goods`, `works` or `services`, and `null` on the rare row whose label is
blank or unrecognised.

**Errors:**

- `401 UNAUTHENTICATED` / `401 TOKEN_EXPIRED`.
- `403 ROLE_FORBIDDEN`: role lacks `tender:read`.
- `422 VALIDATION_FAILED`: bad enum value, `page[size]` over 100, unparseable date.

---

## Tender detail

One tender with its lots, documents and buyer tax id.

**API:**
`GET /api/v1/tenders/:id`

**Authentication:** required (Bearer). Permission: `tender:read`.

**Path parameters:**

- `id`: the tender's CUID2 id.

**Request data:**

No request body

**Response data:**

```json
{
  "data": {
    "id": "cm9zx4k1p0010qw8fj3k9d2p1",
    "sourceId": "armeps:284391",
    "title": "Շինարարական աշխատանքների գնում",
    "referenceCode": "ՀՀ-ԳՀԱՊՁԲ-24/118",
    "cpvCode": "45000000",
    "procedureType": "e_auction",
    "purchaseKind": "works",
    "status": "active",
    "sourceStatus": "Ընթացիկ",
    "estimatedValue": 12750000,
    "currency": "AMD",
    "publishedAt": "2026-08-14T09:30:00.000Z",
    "deadlineAt": "2026-09-12T11:00:00.000Z",
    "auctionAt": "2026-09-13T10:00:00.000Z",
    "qnaDeadlineAt": "2026-09-05T11:00:00.000Z",
    "invitationUrl": "https://eauction.armeps.am/tender/284391/invitation.zip",
    "version": 1,
    "buyer": {
      "id": "cm9zx4k1p0020qw8fh7v2x4m6",
      "name": "«Երևանի քաղաքապետարան» ՀՈԱԿ",
      "taxId": "00123456",
      "region": "Երևան"
    },
    "lots": [
      { "lotNumber": 1, "cpvCode": "45233120", "name": "Ճանապարհային ծածկ" }
    ],
    "documents": [
      { "kind": "invitation", "url": "https://eauction.armeps.am/...", "parsed": true }
    ]
  }
}
```

`buyer.taxId` (ՀՎՀՀ) is populated only for buyers, and only when the invitation archive was
parsed. `cpvCode` is `null` for most of the corpus — CPV lives inside the invitation ZIP.

**Errors:**

- `401 UNAUTHENTICATED` / `401 TOKEN_EXPIRED`.
- `403 ROLE_FORBIDDEN`.
- `404 NOT_FOUND`: "Tender not found."

---

## Saved searches

## List saved searches

Every alert profile the organization has defined. Scoped to the caller's organization.

**API:**
`GET /api/v1/saved-searches`

**Authentication:** required (Bearer). Permission: `tender:read`.

**Request data:**

No request body

**Response data:**

```json
{
  "data": [
    {
      "id": "cm9zx4k1p0030qw8fp2r6t8w4",
      "name": "Road works — Yerevan",
      "cpvCodes": ["45000000", "44100000"],
      "keywords": ["ասֆալտ", "բետոն"],
      "regions": ["Երևան", "Կոտայք"],
      "minValue": 500000,
      "maxValue": 50000000,
      "channels": ["email", "telegram"],
      "createdAt": "2026-07-02T08:11:44.221Z",
      "updatedAt": "2026-08-19T14:02:10.500Z"
    }
  ]
}
```

Not paginated — this returns a plain array with no `meta`.

**Errors:**

- `401 UNAUTHENTICATED` / `401 TOKEN_EXPIRED`.
- `403 ROLE_FORBIDDEN`.

---

## Create saved search

Defines an alert profile. At least one CPV code or keyword is mandatory: a profile with neither
matches every tender ever published, which is indistinguishable from spam to whoever receives it.

**API:**
`POST /api/v1/saved-searches`

**Authentication:** required (Bearer). Permission: `savedsearch:write` (not held by `viewer`).

**Request data:**

```json
{
  "name": "Road works — Yerevan",
  "cpvCodes": ["45000000"],
  "keywords": ["ասֆալտ"],
  "regions": ["Երևան"],
  "minValue": 500000,
  "maxValue": 50000000,
  "channels": ["email", "telegram"]
}
```

- `name` (required): 1–100 chars, trimmed. A label, not an identifier — two profiles may share one.
- `cpvCodes` (optional, default `[]`): up to 100 strings, each max 20 chars.
- `keywords` (optional, default `[]`): up to 50 strings, each 2–100 chars.
- **At least one of `cpvCodes` or `keywords` must be non-empty.**
- `regions` (optional, default `[]`): up to 20 strings, each max 100 chars.
- `minValue` (optional): number ≥ 0, or `null`.
- `maxValue` (optional): number ≥ 0, or `null`. Must be ≥ `minValue` when both are set.
- `channels` (optional, default `[]`): up to 2 of `email`, `telegram`. Empty means every channel the
  organization has linked, resolved at send time.

**Response data:**

`201 Created` — the created profile, same shape as one list entry.

```json
{
  "data": {
    "id": "cm9zx4k1p0030qw8fp2r6t8w4",
    "name": "Road works — Yerevan",
    "cpvCodes": ["45000000"],
    "keywords": ["ասֆալտ"],
    "regions": ["Երևան"],
    "minValue": 500000,
    "maxValue": 50000000,
    "channels": ["email", "telegram"],
    "createdAt": "2026-09-05T10:20:00.000Z",
    "updatedAt": "2026-09-05T10:20:00.000Z"
  }
}
```

**Errors:**

- `401 UNAUTHENTICATED` / `401 TOKEN_EXPIRED`.
- `403 ROLE_FORBIDDEN`: `viewer` lacks `savedsearch:write`.
- `422 VALIDATION_FAILED`: missing `name`; no CPV code and no keyword; `minValue` > `maxValue`; unknown channel.

---

## Update saved search

Partial update. At least one field must be present.

**API:**
`PATCH /api/v1/saved-searches/:id`

**Authentication:** required (Bearer). Permission: `savedsearch:write`.

**Path parameters:**

- `id`: the saved search's CUID2 id.

**Request data:**

```json
{
  "keywords": ["ասֆալտ", "խճանյութ"],
  "channels": ["telegram"]
}
```

All fields optional individually, but the object must carry **at least one**. Same types and
limits as [Create saved search](#create-saved-search); the create-time "CPV or keyword" rule is
not re-applied on update.

**Response data:**

The updated profile, same shape as one list entry.

```json
{
  "data": {
    "id": "cm9zx4k1p0030qw8fp2r6t8w4",
    "name": "Road works — Yerevan",
    "cpvCodes": ["45000000"],
    "keywords": ["ասֆալտ", "խճանյութ"],
    "regions": ["Երևան"],
    "minValue": 500000,
    "maxValue": 50000000,
    "channels": ["telegram"],
    "createdAt": "2026-07-02T08:11:44.221Z",
    "updatedAt": "2026-09-05T10:22:31.004Z"
  }
}
```

**Errors:**

- `401 UNAUTHENTICATED` / `401 TOKEN_EXPIRED`.
- `403 ROLE_FORBIDDEN`.
- `404 NOT_FOUND`: "Saved search not found." Also returned for another tenant's id — the
  repository filters by organization, so a miss is indistinguishable from a wrong id.
- `422 VALIDATION_FAILED`: empty body.

---

## Delete saved search

**API:**
`DELETE /api/v1/saved-searches/:id`

**Authentication:** required (Bearer). Permission: `savedsearch:write`.

**Path parameters:**

- `id`: the saved search's CUID2 id.

**Request data:**

No request body

**Response data:**

`204 No Content`

No response body

**Errors:**

- `401 UNAUTHENTICATED` / `401 TOKEN_EXPIRED`.
- `403 ROLE_FORBIDDEN`.
- `404 NOT_FOUND`: "Saved search not found." (also for another tenant's id).

---

## Tracked tenders (bid pipeline)

The pursuit state machine ([src/features/trackedTenders/trackedTender.service.js](src/features/trackedTenders/trackedTender.service.js)):

| From | May move to |
|---|---|
| `considering` | `preparing`, `dropped` |
| `preparing` | `considering`, `submitted`*, `dropped` |
| `submitted` | `won`, `lost` |
| `won` | — |
| `lost` | — |
| `dropped` | `considering` |

\* `submitted` is reachable only through `POST /tracked-tenders/:id/bid/submit`, never by
PATCHing the status.

## List tracked tenders

The organization's pipeline, cursor-paginated, each row joined to its tender and its bid.

**API:**
`GET /api/v1/tracked-tenders`

**Authentication:** required (Bearer). Permission: `tender:read`.

**Request data:**

No request body

**Query parameters:**

- `filter[status]` (optional): one or several of `considering`, `preparing`, `submitted`,
  `won`, `lost`, `dropped`.
- `page[size]` (optional): 1–100, default 20.
- `page[cursor]` (optional): opaque cursor, max 200 chars.

**Response data:**

```json
{
  "data": [
    {
      "id": "cm9zx4k1p0040qw8fz9y3b1n7",
      "status": "preparing",
      "goNoGo": "go",
      "decisionNote": "Margins work if we subcontract the asphalt.",
      "createdAt": "2026-08-20T07:45:12.331Z",
      "updatedAt": "2026-08-28T15:09:03.118Z",
      "tender": {
        "id": "cm9zx4k1p0010qw8fj3k9d2p1",
        "title": "Շինարարական աշխատանքների գնում",
        "referenceCode": "ՀՀ-ԳՀԱՊՁԲ-24/118",
        "status": "active",
        "cpvCode": "45000000",
        "estimatedValue": 12750000,
        "currency": "AMD",
        "deadlineAt": "2026-09-12T11:00:00.000Z",
        "auctionAt": "2026-09-13T10:00:00.000Z",
        "buyer": {
          "id": "cm9zx4k1p0020qw8fh7v2x4m6",
          "name": "«Երևանի քաղաքապետարան» ՀՈԱԿ"
        }
      },
      "bid": {
        "id": "cm9zx4k1p0050qw8fq4d8s2j9",
        "price": 11900000,
        "lotNumber": 1,
        "currency": "AMD",
        "notes": "Excludes VAT.",
        "locked": false,
        "submittedAt": null,
        "outcome": null,
        "outcomeResolvedAt": null,
        "winningPrice": null,
        "gapVsWinner": null
      }
    }
  ],
  "meta": {
    "cursor": "MjAyNi0wOC0yMFQwNzo0NToxMi4zMzFafGNtOXp4NGsxcDAwNDBxdzhmejl5M2Ixbjc",
    "hasMore": false
  }
}
```

`bid` is `null` when no draft exists. `gapVsWinner` is computed, not stored:
`(price - winningPrice) / winningPrice`, and `null` unless both are known and the winner's
price is positive. `outcome` is `won`, `lost`, `not_found` or `null` — `not_found` means the
public ledger does not list this organization, which is a real outcome and not an error.

**Errors:**

- `401 UNAUTHENTICATED` / `401 TOKEN_EXPIRED`.
- `403 ROLE_FORBIDDEN`.
- `422 VALIDATION_FAILED`: unknown status value; `page[size]` over 100.

---

## Pipeline board counts

Column headers for a kanban board — every status present, including the empty ones, so the
client renders a stable set of columns.

**API:**
`GET /api/v1/tracked-tenders/board`

**Authentication:** required (Bearer). Permission: `tender:read`.

**Request data:**

No request body

**Response data:**

```json
{
  "data": {
    "counts": {
      "considering": 4,
      "preparing": 2,
      "submitted": 1,
      "won": 0,
      "lost": 3,
      "dropped": 1
    },
    "total": 11
  }
}
```

**Errors:**

- `401 UNAUTHENTICATED` / `401 TOKEN_EXPIRED`.
- `403 ROLE_FORBIDDEN`.

---

## Bid performance

The organization's own win/loss record. Obeys the same honesty threshold as a public benchmark:
below `INTELLIGENCE.MIN_COMPARABLES` (default 5) decided bids, `winRate` and `avgGapWhenLost`
are `null` and `basis` is `insufficient_data`. Raw counts are always returned — "1 win, 0
losses" is true and useful; "100% win rate" is neither.

**API:**
`GET /api/v1/tracked-tenders/performance`

**Authentication:** required (Bearer). Permission: `tender:read`.

**Request data:**

No request body

**Response data:**

```json
{
  "data": {
    "won": 4,
    "lost": 7,
    "notFound": 1,
    "avgGapWhenLost": 0.083,
    "decided": 11,
    "winRate": 0.3636363636363636,
    "minimumForRates": 5,
    "basis": "own_submitted_bids"
  }
}
```

Below the threshold:

```json
{
  "data": {
    "won": 1,
    "lost": 1,
    "notFound": 0,
    "avgGapWhenLost": null,
    "decided": 2,
    "winRate": null,
    "minimumForRates": 5,
    "basis": "insufficient_data"
  }
}
```

`winRate` is a fraction (0–1), not a percentage. `avgGapWhenLost` is the mean of
`(price - winningPrice) / winningPrice` over lost bids.

**Errors:**

- `401 UNAUTHENTICATED` / `401 TOKEN_EXPIRED`.
- `403 ROLE_FORBIDDEN`.

---

## Track a tender

Starts pursuing a tender. Idempotent: tracking something already tracked returns the existing
row with `200` instead of `201`, so the status code is how a client tells a repeat from a fresh
create. Both are successes.

**API:**
`POST /api/v1/tracked-tenders`

**Authentication:** required (Bearer). Permission: `trackedtender:write`.

**Request data:**

```json
{
  "tenderId": "cm9zx4k1p0010qw8fj3k9d2p1",
  "status": "considering",
  "goNoGo": "undecided",
  "decisionNote": "Waiting on the subcontractor quote."
}
```

- `tenderId` (**required**): tender id, max 40 chars.
- `status` (optional, default `considering`): `considering` or `preparing` only. Settled and
  submitted states are reached by doing the thing, not by claiming it.
- `goNoGo` (optional): `go`, `no_go`, `undecided`, or `null`.
- `decisionNote` (optional): max 2000 chars, `null` or `""` allowed.

**Response data:**

`201 Created` on a new pursuit, `200 OK` when it was already tracked. Body is the full tracked
tender in the same shape as [Tracked tender detail](#tracked-tender-detail).

**Errors:**

- `401 UNAUTHENTICATED` / `401 TOKEN_EXPIRED`.
- `403 ROLE_FORBIDDEN`: `viewer` lacks `trackedtender:write`.
- `404 NOT_FOUND`: "Tender not found." Checked before insert so a bad id is a 404, not a
  foreign-key violation reported as a 500.
- `422 VALIDATION_FAILED`: missing `tenderId`; `status` of `submitted`/`won`/`lost`/`dropped`.

---

## Tracked tender detail

**API:**
`GET /api/v1/tracked-tenders/:id`

**Authentication:** required (Bearer). Permission: `tender:read`.

**Path parameters:**

- `id`: the tracked tender's CUID2 id.

**Request data:**

No request body

**Response data:**

One object in the same shape as a [list](#list-tracked-tenders) row (id, status, goNoGo,
decisionNote, createdAt, updatedAt, nested `tender`, nested `bid` or `null`), wrapped in `data`.

```json
{
  "data": {
    "id": "cm9zx4k1p0040qw8fz9y3b1n7",
    "status": "preparing",
    "goNoGo": "go",
    "decisionNote": "Margins work if we subcontract the asphalt.",
    "createdAt": "2026-08-20T07:45:12.331Z",
    "updatedAt": "2026-08-28T15:09:03.118Z",
    "tender": { },
    "bid": { }
  }
}
```

**Errors:**

- `401 UNAUTHENTICATED` / `401 TOKEN_EXPIRED`.
- `403 ROLE_FORBIDDEN`.
- `404 NOT_FOUND`: "Tracked tender not found." (also for another tenant's id).

---

## Update tracked tender

Moves a pursuit through the pipeline or edits its go/no-go decision. Illegal transitions are
refused with `409` and the response names what would have been legal.

**API:**
`PATCH /api/v1/tracked-tenders/:id`

**Authentication:** required (Bearer). Permission: `trackedtender:write`.

**Path parameters:**

- `id`: the tracked tender's CUID2 id.

**Request data:**

```json
{
  "status": "preparing",
  "goNoGo": "go",
  "decisionNote": "Quote came back — we're in."
}
```

All optional individually, but at least one required.

- `status` (optional): any of `considering`, `preparing`, `submitted`, `won`, `lost`,
  `dropped` — subject to the transition table above. `submitted` is always refused here.
- `goNoGo` (optional): `go`, `no_go`, `undecided`, `null`.
- `decisionNote` (optional): max 2000 chars, `null` or `""`.

**Response data:**

The full updated tracked tender, same shape as [detail](#tracked-tender-detail).

**Errors:**

- `401 UNAUTHENTICATED` / `401 TOKEN_EXPIRED`.
- `403 ROLE_FORBIDDEN`.
- `404 NOT_FOUND`: "Tracked tender not found."
- `409 CONFLICT`: illegal transition — `A tracked tender cannot move from "won" to
  "preparing".` with `details: { from, to, allowed }`; or attempting `status: "submitted"` —
  `Submit the bid to reach "submitted" — POST /tracked-tenders/:id/bid/submit.`
- `422 VALIDATION_FAILED`: empty body; unknown status.

---

## Untrack a tender

Deletes the pursuit. Refused once a bid is locked — `bids` cascades on delete, and a submitted
bid is a record, not a draft. `dropped` is the status for walking away with the history intact.

**API:**
`DELETE /api/v1/tracked-tenders/:id`

**Authentication:** required (Bearer). Permission: `trackedtender:write`.

**Path parameters:**

- `id`: the tracked tender's CUID2 id.

**Request data:**

No request body

**Response data:**

`204 No Content`

No response body

**Errors:**

- `401 UNAUTHENTICATED` / `401 TOKEN_EXPIRED`.
- `403 ROLE_FORBIDDEN`.
- `404 NOT_FOUND`: "Tracked tender not found."
- `409 CONFLICT`: "This pursuit has a submitted bid and cannot be deleted. Set its status to
  'dropped' instead." with `details: { bidId }`.

---

## Save draft bid

Creates or replaces the draft bid. The bid is a subresource, not its own collection —
`bids.tracked_tender_id` is UNIQUE, so there is exactly one per pursuit. Drafting a price on a
`considering` pursuit silently advances it to `preparing`.

**API:**
`PUT /api/v1/tracked-tenders/:id/bid`

**Authentication:** required (Bearer). Permission: `bid:write`.

**Path parameters:**

- `id`: the tracked tender's CUID2 id.

**Request data:**

```json
{
  "price": 11900000,
  "lotNumber": 1,
  "currency": "AMD",
  "notes": "Excludes VAT."
}
```

All optional individually, but at least one required.

- `price` (optional): number 0 – 1e13, or `null`. The upper bound is real defence: the source
  publishes bids like 6,666,600,000,000 AMD against a 75,000 budget, and a typo of that shape
  would wreck the organization's own win-rate maths.
- `lotNumber` (optional): integer ≥ 1, or `null`.
- `currency` (optional, default `AMD`): exactly 3 chars, uppercased.
- `notes` (optional): max 5000 chars, `null` or `""`.

**Response data:**

The full tracked tender with its bid, same shape as [detail](#tracked-tender-detail).

**Errors:**

- `401 UNAUTHENTICATED` / `401 TOKEN_EXPIRED`.
- `403 ROLE_FORBIDDEN`.
- `404 NOT_FOUND`: "Tracked tender not found."
- `409 CONFLICT`: "This bid was submitted and is now a read-only snapshot." with
  `details: { submittedAt }`.
- `422 VALIDATION_FAILED`: empty body; price over 1e13; currency not 3 chars.

---

## Submit bid

Locks the bid as a read-only snapshot and advances the pursuit to `submitted`. Then tries to
resolve the outcome immediately against the public ledger — a bid entered after the fact on an
already-settled tender has its answer waiting — and, if resolved, moves the pursuit straight to
`won` or `lost`. An unsettled tender simply stays `submitted` until the half-hourly reconcile
job picks it up.

**API:**
`POST /api/v1/tracked-tenders/:id/bid/submit`

**Authentication:** required (Bearer). Permission: `bid:write`.

**Path parameters:**

- `id`: the tracked tender's CUID2 id.

**Request data:**

```json
{
  "submittedAt": "2026-09-01T09:15:00.000Z"
}
```

- `submittedAt` (optional): ISO-8601 date, **not in the future**. Defaults to now. Accepted so
  a bid entered after the fact carries its real date — backdating is the normal case for an
  organization onboarding with history.

The body may be omitted entirely.

**Response data:**

The full tracked tender, with `bid.locked: true` and a `bid.submittedAt`, same shape as
[detail](#tracked-tender-detail).

**Errors:**

- `401 UNAUTHENTICATED` / `401 TOKEN_EXPIRED`.
- `403 ROLE_FORBIDDEN`.
- `404 NOT_FOUND`: "Tracked tender not found." or "Bid not found."
- `409 CONFLICT`: "This bid has already been submitted." (with `details: { submittedAt }`, or
  bare when a concurrent submit won the race); "A bid needs a price before it can be
  submitted."
- `422 VALIDATION_FAILED`: `submittedAt` in the future.

---

## Delete draft bid

Discards an unsubmitted draft. A submitted bid cannot be deleted.

**API:**
`DELETE /api/v1/tracked-tenders/:id/bid`

**Authentication:** required (Bearer). Permission: `bid:write`.

**Path parameters:**

- `id`: the tracked tender's CUID2 id.

**Request data:**

No request body

**Response data:**

`204 No Content`

No response body

**Errors:**

- `401 UNAUTHENTICATED` / `401 TOKEN_EXPIRED`.
- `403 ROLE_FORBIDDEN`.
- `404 NOT_FOUND`: "Bid not found."
- `409 CONFLICT`: "A submitted bid cannot be deleted." with `details: { submittedAt }`.

---

## Bid checklist (AI)

Requirements extracted from the tender's invitation document by a model, each with a category,
a confidence and a **verbatim evidence span** that is verified to appear in the source text —
an item whose evidence is not actually present is dropped in code, not merely discouraged in
the prompt.

## Get checklist

The checklist and its items. `status` is the honest state machine: `absent` (never generated),
`pending` (a job is running), `ready`, `unavailable` (no invitation document to read — the
common path, since only a minority of tenders have an archive) or `failed`. An empty list is
never returned in place of `unavailable`, because "nothing is required for this tender" is the
most dangerous thing this feature could say.

**API:**
`GET /api/v1/tracked-tenders/:id/checklist`

**Authentication:** required (Bearer). Permission: `tender:read`.

**Path parameters:**

- `id`: the tracked tender's CUID2 id.

**Request data:**

No request body

**Response data:**

Never generated:

```json
{
  "data": {
    "status": "absent",
    "items": [],
    "progress": null,
    "advisory": true
  }
}
```

Generated:

```json
{
  "data": {
    "id": "cm9zx4k1p0060qw8fw7c2n5h3",
    "status": "ready",
    "source": "ai",
    "model": "claude-opus-5",
    "generatedAt": "2026-08-29T12:41:07.882Z",
    "failureReason": null,
    "progress": {
      "total": 14,
      "done": 6,
      "outstandingRequired": 7,
      "needsReview": 2
    },
    "items": [
      {
        "id": "cm9zx4k1p0070qw8fk8m4v1q6",
        "label": "Հարկային մարմնի տեղեկանք պարտքի բացակայության մասին",
        "category": "document",
        "required": true,
        "done": false,
        "confidence": 0.92,
        "evidence": "Մասնակիցը ներկայացնում է հարկային մարմնի կողմից տրված տեղեկանք",
        "needsReview": false,
        "source": "ai",
        "reviewedAt": null,
        "document": {
          "id": "cm9zx4k1p0080qw8fr3t7y9u2",
          "kind": "tax-clearance",
          "filename": "tax-clearance-2026.pdf",
          "attachedAt": "2026-08-30T09:02:11.400Z",
          "expiry": {
            "status": "valid",
            "daysRemaining": 118,
            "validUntil": "2027-01-01T00:00:00.000Z"
          }
        }
      }
    ],
    "advisory": true
  }
}
```

- `category`: `eligibility`, `financial`, `technical`, `document`, `procedural`, or `null`.
- `confidence`: 0–1 for AI items, **`null` for manual ones** — a person's assertion stays
  distinguishable from an extraction. `evidence` is likewise `null` on manual items.
- `needsReview`: stored, not recomputed. Below `AI.CHECKLIST_MIN_CONFIDENCE` (0.75) an item is
  flagged; the flag is persisted so raising the threshold cannot silently re-open items a human
  already cleared.
- `document.expiry.status`: `valid`, `expiring_soon`, `expired` or `no_expiry` — recomputed on
  every read, so a certificate that lapsed since being attached shows as expired here.
- `advisory: true` on every response: this is model output assisting a bid decision, not a
  legal reading of the tender.

**Errors:**

- `401 UNAUTHENTICATED` / `401 TOKEN_EXPIRED`.
- `403 ROLE_FORBIDDEN`.
- `404 NOT_FOUND`: "Tracked tender not found."

---

## Generate checklist

Enqueues an extraction. Answers `202` — a model call over a full invitation takes tens of
seconds, far past an HTTP budget, so the client polls
[GET /tracked-tenders/:id/checklist](#get-checklist) for the result. The tracked tender is the
job's idempotency key, so two clicks cannot buy two model calls.

**API:**
`POST /api/v1/tracked-tenders/:id/checklist/generate`

**Authentication:** required (Bearer). Permission: `bid:write` — generating spends money, which
is a stronger act than viewing.

**Path parameters:**

- `id`: the tracked tender's CUID2 id.

**Request data:**

```json
{
  "force": false
}
```

- `force` (optional, default `false`): re-run an extraction the worker would otherwise skip as
  unchanged. It exists for the case the document hash cannot detect — the *prompt* changed.

The body may be omitted entirely.

**Response data:**

`202 Accepted`

```json
{
  "data": {
    "id": "cm9zx4k1p0060qw8fw7c2n5h3",
    "status": "pending",
    "advisory": true
  }
}
```

**Errors:**

- `401 UNAUTHENTICATED` / `401 TOKEN_EXPIRED`.
- `403 ROLE_FORBIDDEN`.
- `404 NOT_FOUND`: "Tracked tender not found."
- `409 CONFLICT`: "A checklist is already being generated for this tender." (unless `force`).
- `503 DEPENDENCY_UNAVAILABLE`: "AI checklist extraction is not configured." Refused up front
  rather than enqueueing a job certain to fail.

---

## Add checklist item

Adds a requirement the model missed. Manual items are marked `source: "manual"` and survive a
regenerate — `replaceItems` deletes only AI rows, so a human who corrects the machine does not
lose the correction.

**API:**
`POST /api/v1/tracked-tenders/:id/checklist/items`

**Authentication:** required (Bearer). Permission: `bid:write`.

**Path parameters:**

- `id`: the tracked tender's CUID2 id.

**Request data:**

```json
{
  "label": "Բանկային երաշխիք 5% չափով",
  "category": "financial",
  "required": true
}
```

- `label` (**required**): trimmed, 3–500 chars.
- `category` (optional): `eligibility`, `financial`, `technical`, `document`, `procedural`, or
  `null`.
- `required` (optional, default `true`): boolean.

`confidence` and `evidence` are **not accepted** — those describe a model's reading of a
document, and letting a client set them would make an assertion indistinguishable from an
extraction.

**Response data:**

`201 Created` — one item, same shape as a checklist item above, with `confidence: null`,
`evidence: null`, `source: "manual"`.

```json
{
  "data": {
    "id": "cm9zx4k1p0090qw8fd6g1h4s8",
    "label": "Բանկային երաշխիք 5% չափով",
    "category": "financial",
    "required": true,
    "done": false,
    "confidence": null,
    "evidence": null,
    "needsReview": false,
    "source": "manual",
    "reviewedAt": null,
    "document": null
  }
}
```

**Errors:**

- `401 UNAUTHENTICATED` / `401 TOKEN_EXPIRED`.
- `403 ROLE_FORBIDDEN`.
- `404 NOT_FOUND`: "Tracked tender not found."
- `422 VALIDATION_FAILED`: label shorter than 3 chars; unknown category.

---

## Update checklist item

Ticks an item off, edits its label, or clears the review flag. Addressed by the item's own id
without the parent in the path — ticking one off is the most frequent write in the feature.

**API:**
`PATCH /api/v1/tracked-tenders/checklist/items/:itemId`

**Authentication:** required (Bearer). Permission: `bid:write`.

**Path parameters:**

- `itemId`: the checklist item's CUID2 id.

**Request data:**

```json
{
  "done": true,
  "needsReview": false
}
```

All optional individually, but at least one required.

- `done` (optional): boolean.
- `required` (optional): boolean.
- `label` (optional): trimmed, 3–500 chars.
- `needsReview` (optional): boolean. Clearing it is a human saying "I checked this"; setting it
  back to `true` is allowed too, since a second reviewer may disagree.

**Response data:**

The updated item, same shape as one checklist item.

**Errors:**

- `401 UNAUTHENTICATED` / `401 TOKEN_EXPIRED`.
- `403 ROLE_FORBIDDEN`.
- `404 NOT_FOUND`: "Checklist item not found." (also for another tenant's id).
- `422 VALIDATION_FAILED`: empty body; label too short.

---

## Attach document to checklist item

Says which vault document satisfies this requirement — or detaches one with `null`. This is
where BR-12 bites: an expired certificate cannot be attached to a bid. Detaching is deliberately
unguarded, because attaching the wrong certificate is the easiest mistake in the feature.

Needs `bid:write`, not `vault:write`: attaching changes the bid, not the document.

**API:**
`PATCH /api/v1/tracked-tenders/checklist/items/:itemId/document`

**Authentication:** required (Bearer). Permission: `bid:write`.

**Path parameters:**

- `itemId`: the checklist item's CUID2 id.

**Request data:**

```json
{
  "vaultDocumentId": "cm9zx4k1p0080qw8fr3t7y9u2"
}
```

- `vaultDocumentId` (**required**, nullable): a vault document id (max 40 chars), or `null` to
  detach.

**Response data:**

The updated item, same shape as one checklist item, with its `document` block populated (or
`null` after a detach).

**Errors:**

- `401 UNAUTHENTICATED` / `401 TOKEN_EXPIRED`.
- `403 ROLE_FORBIDDEN`.
- `404 NOT_FOUND`: "Vault document not found." or "Checklist item not found."
- `409 CONFLICT`: "That document expired and cannot be attached to a bid." with
  `details: { documentId, validUntil }`; or "That document has not finished uploading." with
  `details: { documentId }` when its status is not `ready`.
- `422 VALIDATION_FAILED`: `vaultDocumentId` missing (omitting it is not the same as `null`).

---

## Delete checklist item

**API:**
`DELETE /api/v1/tracked-tenders/checklist/items/:itemId`

**Authentication:** required (Bearer). Permission: `bid:write`.

**Path parameters:**

- `itemId`: the checklist item's CUID2 id.

**Request data:**

No request body

**Response data:**

`204 No Content`

No response body

**Errors:**

- `401 UNAUTHENTICATED` / `401 TOKEN_EXPIRED`.
- `403 ROLE_FORBIDDEN`.
- `404 NOT_FOUND`: "Checklist item not found."

---

## Organization

## List fields

The fixed list an organization's **fields** — the industries it works in — are chosen from.
Each carries the CPV prefixes it covers: a 2-digit division, or a 3-digit group where a division
is split between two fields. The same list drives `filter[field]` on the tender lists and the
field signal in [Relevant tenders](#relevant-tenders), so "what counts as medical" has one answer.

Ids only: the client writes the names. There is no `other` — fields are optional, so "none of
these" is choosing none.

**API:**
`GET /api/v1/fields`

**Authentication:** required (Bearer). **Orgless allowed** — the first screen that needs this
list is founding an organization. No permission check.

**Request data:**

No request body

**Response data:**

```json
{
  "data": [
    { "id": "furniture", "cpvPrefixes": ["391", "392", "393", "395", "397"] },
    { "id": "medical", "cpvPrefixes": ["33", "85"] },
    { "id": "chemicals_cleaning", "cpvPrefixes": ["24", "398"] }
  ]
}
```

Sixteen entries today: `furniture`, `it_telecom`, `medical`, `fuel_energy`, `electrical`,
`construction`, `vehicles_transport`, `professional_services`, `industrial_machinery`,
`laboratory`, `chemicals_cleaning`, `office_stationery`, `food_catering`,
`facilities_security`, `education_leisure`, `textiles_workwear`. Ids are stable; their prefixes
may be refined.

**Errors:**

- `401 UNAUTHENTICATED` / `401 TOKEN_EXPIRED`.

---

## Create organization

Founds an organization, makes the caller its **owner** in the same transaction, and returns a
full session for it — the caller is working inside the new organization immediately, with no
second call and no re-login. The caller's existing memberships are untouched; the previous
session keeps working, and [Switch organization](#switch-organization) moves between them.

An account may found at most **three** organizations that still exist, counted from who created
them (not who owns them now, so handing the owner seat away does not free a slot).

**API:**
`POST /api/v1/organizations`

**Authentication:** required (Bearer). No permission check — there is no tenant yet to hold a
role in.

**Request data:**

```json
{
  "name": "Shinarar LLC",
  "fields": ["construction"]
}
```

- `name` (**required**): trimmed, 2–200 chars.
- `fields` (optional): up to **3** distinct ids from [List fields](#list-fields). Default `[]`.
  Optional so founding stays one screen; it can be changed afterwards with
  [Update organization](#update-organization).

**Response data:**

`201 Created` — same shape as [Log in](#log-in), minted for the new organization:

```json
{
  "data": {
    "accessToken": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...",
    "refreshToken": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...",
    "expiresIn": 900,
    "user": {
      "id": "cm9zx4k1p0000qw8f3h2l7d5t",
      "email": "procurement@shinarar.am",
      "displayName": "Gevorg Sargsyan",
      "locale": "hy",
      "emailVerified": true
    },
    "organization": { "id": "cm9zx4k1p0001qw8f6b3n2v8y", "name": "Shinarar LLC" },
    "role": "owner",
    "plan": "free",
    "organizations": [
      { "id": "cm9zx4k1p0001qw8f6b3n2v8y", "name": "Shinarar LLC", "role": "owner" }
    ]
  }
}
```

If the organization is created but minting the session fails, the organization still exists:
it appears in the next login's `organizations`, and switching into it is the recovery — retrying
the create would found a second one.

**Errors:**

- `401 UNAUTHENTICATED` / `401 TOKEN_EXPIRED`.
- `403 EMAIL_UNVERIFIED`: address not confirmed.
- `422 VALIDATION_FAILED`: missing or short `name`; a field id not on the list, a repeat, or a
  fourth field.
- `429 QUOTA_EXCEEDED`: "An account can create at most 3 organizations." `details: { limit, created }`.
- `429 RATE_LIMITED`: more than 10 creations/hour for this user.

---

## Get organization

The organization this session is acting in, with its fields.

**API:**
`GET /api/v1/organization`

**Authentication:** required (Bearer). Permission: `tender:read` (every member).

**Request data:**

No request body

**Response data:**

```json
{
  "data": {
    "id": "cm9zx4k1p0001qw8f6b3n2v8y",
    "name": "Shinarar LLC",
    "fields": ["construction", "electrical"]
  }
}
```

`fields` is `[]`, never `null`, when none are claimed.

**Errors:**

- `401 UNAUTHENTICATED` / `401 TOKEN_EXPIRED`.
- `403 NO_ORGANIZATION`: orgless session.

---

## Update organization

Change the organization's settings — its **fields**, today. The list is replaced whole, not
merged: send what is ticked, and `[]` clears it. The change is visible on the next read.

**API:**
`PATCH /api/v1/organization`

**Authentication:** required (Bearer). Permission: `org:manage` (owner, admin). Acts on the
session's own organization only — there is no id in the path to point elsewhere.

**Request data:**

```json
{
  "fields": ["construction", "electrical"]
}
```

- `fields`: up to **3** distinct ids from [List fields](#list-fields).

**Response data:**

`200 OK` — the organization as [Get organization](#get-organization) returns it.

**Errors:**

- `401 UNAUTHENTICATED` / `401 TOKEN_EXPIRED`.
- `403 ROLE_FORBIDDEN`: role lacks `org:manage`.
- `403 NO_ORGANIZATION`: orgless session.
- `422 VALIDATION_FAILED`: empty body; a field id not on the list, a repeat, or a fourth field.

---

## List members

The roster: who is on this organization's team now, and at what role. Every member reads it, a
`viewer` included — a tenant is a company, and its own staff list is not a secret from its staff.
Removed members are simply absent; removal deletes the membership rather than marking it.

For callers holding `user:manage` (owner, admin), **pending invitations are merged into the same
list**, after the members, as `kind: "invitation"` entries. Everyone else — a `viewer` included —
gets members only, so an invited address is never shown to them.

Members are ordered by when each person joined, oldest first (so the founder leads); invitations
follow in the order they were sent. An id tiebreaker means paging can neither repeat nor drop an
entry.

**API:**
`GET /api/v1/organization/members`

**Authentication:** required (Bearer). Permission: `tender:read`.

**Request data:**

Query parameters:

- `page[size]` (optional): 1–100, default 20.
- `page[cursor]` (optional): `meta.cursor` from the previous page, verbatim. An unreadable cursor
  is treated as absent and returns the first page.

**Response data:**

```json
{
  "data": [
    {
      "kind": "member",
      "userId": "cm9zx4k1p0000qw8f3h2l7d5t",
      "displayName": "Gevorg Sargsyan",
      "email": "procurement@shinarar.am",
      "role": "owner",
      "joinedAt": "2026-09-13T08:14:02.311Z"
    },
    {
      "kind": "member",
      "userId": "cm9zx4k1p0400qw8f1r6d9s3m",
      "displayName": "Lilit Hakobyan",
      "email": "lilit@shinarar.am",
      "role": "coordinator",
      "joinedAt": "2026-09-14T11:40:57.020Z"
    }
  ],
  "meta": {
    "cursor": "MjAyNi0wOS0xNFQxMTo0MDo1Ny4wMjBafGNtOXo...",
    "hasMore": false
  }
}
```

An invitation entry, as an owner or admin sees it:

```json
{
  "kind": "invitation",
  "invitationId": "cm9zx4k1p0500qw8f7t2x6c1n",
  "userId": null,
  "displayName": null,
  "email": "armen@example.am",
  "role": "coordinator",
  "joinedAt": null,
  "invitedAt": "2026-09-15T09:02:11.845Z"
}
```

`userId`, `displayName` and `joinedAt` are explicitly `null` rather than faked — nobody has
joined, and there may be no account behind the address.

**Errors:**

- `401 UNAUTHENTICATED` / `401 TOKEN_EXPIRED`.
- `403 NO_ORGANIZATION`: the session is in no organization.
- `422 VALIDATION_FAILED`: `page[size]` out of range.

---

## Change a member's role

Moves a member among the four non-owner roles. Ownership is **not** assignable here — it is a
hand-off, done by transfer.

- Subject to the [rank rule](#authorization-gates): an admin cannot change another admin's role or
  the owner's.
- The owner's own role cannot be changed this way either (the organization would have no owner).
- **Nobody is signed out.** Role and plan are re-read on every refresh, so the new role takes
  effect within one access-token lifetime.
- Not plan-gated — a downgraded organization can always reassign its people.
- A real change raises an organization-wide announcement (`team-role-changed`), worded in the third
  person: "Gevorg Sargsyan's role in Shinarar LLC has been changed to consultant." Setting the role
  a member already has changes nothing and announces nothing.

**API:**
`PATCH /api/v1/organization/members/:userId`

**Authentication:** required (Bearer). Permission: `user:manage`, plus the rank rule.

**Request data:**

```json
{
  "role": "consultant"
}
```

- `role` (**required**): `admin` | `coordinator` | `viewer` | `consultant`. `owner` is a
  `422 VALIDATION_FAILED` whose message names `POST /organization/transfer-ownership`.

**Response data:**

The member, in the roster's shape:

```json
{
  "data": {
    "kind": "member",
    "userId": "cm9zx4k1p0400qw8f1r6d9s3m",
    "displayName": "Lilit Hakobyan",
    "email": "lilit@shinarar.am",
    "role": "consultant",
    "joinedAt": "2026-09-14T11:40:57.020Z"
  }
}
```

**Errors:**

- `401 UNAUTHENTICATED` / `401 TOKEN_EXPIRED`.
- `403 NO_ORGANIZATION`.
- `403 ROLE_FORBIDDEN`: caller lacks `user:manage`; the target outranks them
  (`details: { role, targetRole }`); or the caller may not grant that role
  (`details: { role, grantedRole }` — an admin promoting to `admin`).
- `404 NOT_FOUND`: no such member in this organization.
- `409 CONFLICT`: the target is the owner ("Transfer ownership to another member first"); or the
  member changed concurrently.
- `422 VALIDATION_FAILED`: unknown role, or `owner`.

---

## Remove a member

Ends another member's membership. It is a plain deletion — nothing records that they were here —
and everything they created (documents, tracked tenders, bids) stays with the organization.

- Subject to the [rank rule](#authorization-gates); the owner cannot be removed — transfer the seat
  first, or, if the owner is the only member, delete the organization.
- **Not plan-gated**, so a downgraded organization can always close an access hole.
- Revokes the removed member's refresh sessions **for this organization only**; their sessions in
  other organizations keep working. Their current access token is stateless and keeps working until
  it expires (up to one access-token lifetime). If this was their last organization, their next
  sign-in lands in the [orgless state](#the-orgless-state).
- Clears their accepted invitation, so the organization can invite them back later at any role.
- Raises an organization-wide announcement (`team-member-removed`): "Lilit Hakobyan has been removed
  from Shinarar LLC." The removed member's own alert destinations are **not** revoked, so it reaches
  them too — which is how they learn which organization removed them. An owner can switch those
  destinations off under Integrations.

**API:**
`DELETE /api/v1/organization/members/:userId`

**Authentication:** required (Bearer). Permission: `user:manage`, plus the rank rule.

**Request data:**

No request body

**Response data:**

`204 No Content`

**Errors:**

- `401 UNAUTHENTICATED` / `401 TOKEN_EXPIRED`.
- `403 NO_ORGANIZATION`.
- `403 ROLE_FORBIDDEN`: caller lacks `user:manage`, or the target outranks them.
- `404 NOT_FOUND`: no such member in this organization.
- `409 CONFLICT`: the target is the owner — "Transfer ownership to another member first", or, as the
  only member, "Delete the organization instead". `details: { role, otherMembers }`. Or the member
  changed concurrently.

---

## Leave the organization

Ends the caller's own membership in the organization their session is acting in. **No permission is
needed** — it is their own membership — which is why it is a separate endpoint from removal. Leaving
never deletes anything.

The owner cannot leave: with other members they must [transfer ownership](#transfer-ownership)
first; as the only member they must delete the organization instead.

The session for this organization is over (its refresh families are revoked), so the response
carries a fresh session: the caller's first remaining membership, or an orgless session if this was
their last.

**API:**
`POST /api/v1/organization/leave`

**Authentication:** required (Bearer). No permission check.

**Request data:**

No request body

**Response data:**

```json
{
  "data": {
    "left": true,
    "organization": { "id": "cm9zx4k1p0001qw8f6b3n2v8y", "name": "Shinarar LLC" },
    "session": {
      "accessToken": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...",
      "refreshToken": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...",
      "expiresIn": 900,
      "user": {
        "id": "cm9zx4k1p0400qw8f1r6d9s3m",
        "email": "lilit@shinarar.am",
        "displayName": "Lilit Hakobyan",
        "locale": "hy",
        "emailVerified": true
      },
      "organization": null,
      "role": null,
      "plan": null,
      "organizations": []
    }
  }
}
```

**Errors:**

- `401 UNAUTHENTICATED` / `401 TOKEN_EXPIRED`.
- `403 NO_ORGANIZATION`: the session is in no organization.
- `404 NOT_FOUND`: the caller is no longer a member here.
- `409 CONFLICT`: the caller is the owner — "Transfer ownership to another member first", or, as the
  only member, "Delete the organization instead". `details: { role, otherMembers }`.

---

## Transfer ownership

Hands the organization's single owner seat to another member — the **only** way ownership moves.
The caller becomes an `admin` (so they can finish what they were doing, or then leave) and the
target becomes the `owner`, in one transaction: the organization is never without an owner and never
has two.

- Owner-only, checked against the database: a previous owner's still-valid token cannot hand the
  seat away again.
- The target must already be a member — not an email address, not a pending invitation.
- **Nobody is signed out.** Both new roles take effect within one access-token lifetime, so the
  outgoing owner briefly keeps `billing:manage`.
- Raises an organization-wide announcement (`team-ownership-transferred`): "Ownership of Shinarar
  LLC has passed from Gevorg Sargsyan to Lilit Hakobyan."

**API:**
`POST /api/v1/organization/transfer-ownership`

**Authentication:** required (Bearer). Permission: `user:manage`, and the caller must be the owner.

**Request data:**

```json
{
  "userId": "cm9zx4k1p0400qw8f1r6d9s3m"
}
```

- `userId` (**required**): the member receiving the seat; must not be the caller.

**Response data:**

```json
{
  "data": {
    "owner": {
      "kind": "member",
      "userId": "cm9zx4k1p0400qw8f1r6d9s3m",
      "displayName": "Lilit Hakobyan",
      "email": "lilit@shinarar.am",
      "role": "owner",
      "joinedAt": "2026-09-14T11:40:57.020Z"
    },
    "previousOwner": {
      "kind": "member",
      "userId": "cm9zx4k1p0000qw8f3h2l7d5t",
      "displayName": "Gevorg Sargsyan",
      "email": "procurement@shinarar.am",
      "role": "admin",
      "joinedAt": "2026-09-13T08:14:02.311Z"
    }
  }
}
```

**Errors:**

- `401 UNAUTHENTICATED` / `401 TOKEN_EXPIRED`.
- `403 NO_ORGANIZATION`.
- `403 ROLE_FORBIDDEN`: "Only the owner can transfer ownership." — including a previous owner, and
  the loser of two simultaneous transfers.
- `404 NOT_FOUND`: the target is not a member of this organization.
- `422 VALIDATION_FAILED`: missing `userId`, or the caller's own id.

---

## Delete the organization

Closes the account. Deliberately narrow: **the owner only, only as its sole member, and only with the
organization's name typed back** exactly. Everything private cascades with it — vault documents,
tracked tenders, bids, checklists, saved searches, invitations, notifications and alert
destinations.

**Vault files are erased from storage before the organization row is deleted.** If storage fails
part-way, the request answers `503` and the organization, its rows and its remaining files are left
intact, so the same request can simply be sent again. Leaving never deletes anything; this is the
only way an organization goes away.

The caller's sessions for the organization are revoked, and the response carries a fresh session:
their first remaining membership, or an orgless session if this was their last. A deleted
organization no longer counts toward the three-organization creation cap.

**API:**
`DELETE /api/v1/organization`

**Authentication:** required (Bearer). Permission: `org:manage`, and the caller must be the owner.

**Request data:**

```json
{
  "name": "Shinarar LLC"
}
```

- `name` (**required**): the organization's current name, exactly — not trimmed, not
  case-insensitive. Sent in the `DELETE` body rather than the query string, so the name does not
  end up in access logs.

**Response data:**

```json
{
  "data": {
    "deleted": true,
    "organization": { "id": "cm9zx4k1p0001qw8f6b3n2v8y", "name": "Shinarar LLC" },
    "vaultObjectsErased": 4,
    "session": {
      "accessToken": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...",
      "refreshToken": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...",
      "expiresIn": 900,
      "user": {
        "id": "cm9zx4k1p0000qw8f3h2l7d5t",
        "email": "procurement@shinarar.am",
        "displayName": "Gevorg Sargsyan",
        "locale": "hy",
        "emailVerified": true
      },
      "organization": null,
      "role": null,
      "plan": null,
      "organizations": []
    }
  }
}
```

**Errors:**

- `401 UNAUTHENTICATED` / `401 TOKEN_EXPIRED`.
- `403 NO_ORGANIZATION`.
- `403 ROLE_FORBIDDEN`: "Only the owner can delete the organization."
- `409 CONFLICT`: other members remain (`details.otherMembers`) — remove them, or transfer ownership
  and leave; a document upload registered within the upload-URL lifetime may still be in flight
  (`details.retryAfterSeconds`) — nothing has been erased; or a member joined or a document was
  added while deleting (retry).
- `422 VALIDATION_FAILED`: `name` missing or not exactly the organization's name.
- `503 DEPENDENCY_UNAVAILABLE`: document storage failed part-way; nothing was deleted from the
  database, and the request can be retried.

---

## Invite a member

Offers an email address a role in the caller's organization. The answer is **the same object for
every address** — registered or not — and nothing about the invitee is looked up, so the endpoint
cannot be used to learn who is a TenderIQ customer. The offer is recorded either way and is matched
when that address registers and verifies.

- Re-inviting an address updates the role on the existing offer instead of creating a second one,
  and returns a `declined` offer to `pending` — a decline answers one offer, not all of them. An
  `accepted` offer is left untouched: that person has joined, and their role moves by role change.
  (The response is still the same constant.)
- Invitations never expire; no credential travels with them, and no email is sent.
- Sending raises an organization-wide announcement (`team-invitation`) through the organization's
  linked Telegram and email destinations. It names the role and the sender, never the address.

**API:**
`POST /api/v1/organization/invitations`

**Authentication:** required (Bearer). Permission: `user:manage`. **Plan:** `pro`, `business` or
`enterprise` — until a subscription writer exists, every organization reads as `free` and this
answers `402`.

**Request data:**

```json
{
  "email": "armen@example.am",
  "role": "coordinator"
}
```

- `email` (**required**): valid email, lowercased, max 255 chars.
- `role` (**required**): `admin` | `coordinator` | `viewer` | `consultant`. `owner` is refused —
  there is one owner seat and it moves only by transfer.

**Response data:**

```json
{
  "data": {
    "sent": true,
    "message": "If that person is registered, they will get the invitation."
  }
}
```

Always exactly this. Use [List sent invitations](#list-sent-invitations) to see the offer.

**Errors:**

- `401 UNAUTHENTICATED` / `401 TOKEN_EXPIRED`.
- `402 PLAN_UPGRADE_REQUIRED`: `details: { permission: "user:manage", feature: "invitations", plan }`.
- `403 NO_ORGANIZATION` / `403 ROLE_FORBIDDEN` — including an admin inviting at `admin`
  (`details: { role, grantedRole }`). This depends only on the sender, so the response for any
  address is still identical.
- `422 VALIDATION_FAILED`: bad email; unknown role; `owner`, with a message naming
  `POST /organization/transfer-ownership`.
- `429 RATE_LIMITED`: more than 60 invitations/hour for this user.

---

## List sent invitations

Every offer this organization has sent, at `pending`, `accepted` or `declined` — so an owner can
tell "they have not answered" from "they said no". Newest first.

**API:**
`GET /api/v1/organization/invitations`

**Authentication:** required (Bearer). Permission: `user:manage`. Not plan-gated.

**Request data:**

Query parameters:

- `filter[status]` (optional): `pending` | `accepted` | `declined`.
- `page[size]` (optional): 1–100, default 20.
- `page[cursor]` (optional): `meta.cursor` from the previous page.

**Response data:**

```json
{
  "data": [
    {
      "id": "cm9zx4k1p0500qw8f7t2x6c1n",
      "email": "armen@example.am",
      "role": "coordinator",
      "status": "declined",
      "invitedBy": { "userId": "cm9zx4k1p0000qw8f3h2l7d5t", "displayName": "Gevorg Sargsyan" },
      "createdAt": "2026-09-15T09:02:11.845Z",
      "updatedAt": "2026-09-15T09:02:11.845Z",
      "respondedAt": "2026-09-16T14:30:00.000Z"
    }
  ],
  "meta": { "cursor": "MjAyNi0wOS0xNVQwOTowMjoxMS44NDVafGNtOXo...", "hasMore": false }
}
```

`invitedBy` is `null` once the sender's account no longer exists.

**Errors:**

- `401 UNAUTHENTICATED` / `401 TOKEN_EXPIRED`.
- `403 NO_ORGANIZATION` / `403 ROLE_FORBIDDEN`.
- `422 VALIDATION_FAILED`: unknown status or bad page size.

---

## Cancel an invitation

Withdraws an offer — a mistyped address is otherwise a standing offer to a stranger. Pending and
declined offers can be cancelled; an accepted one cannot, because the person has joined and
cancelling the record would not remove them.

**API:**
`DELETE /api/v1/organization/invitations/:id`

**Authentication:** required (Bearer). Permission: `user:manage`. Not plan-gated.

**Request data:**

No request body

**Response data:**

`204 No Content`

**Errors:**

- `401 UNAUTHENTICATED` / `401 TOKEN_EXPIRED`.
- `403 NO_ORGANIZATION` / `403 ROLE_FORBIDDEN`.
- `404 NOT_FOUND`: no such invitation in this organization (including another organization's id).
- `409 CONFLICT`: "That invitation has already been accepted. Remove the member instead."

---

## Get supplier identity

Which party in the public corpus this organization bids **as** — the join that makes automatic
win/loss resolution possible at all. Awards and the public bid ledger identify a bidder by
`parties.id`; without this link there is no way to ask "did we win".

**API:**
`GET /api/v1/organization/supplier-identity`

**Authentication:** required (Bearer). Permission: `tender:read`.

**Request data:**

No request body

**Response data:**

```json
{
  "data": {
    "supplierPartyId": "cm9zx4k1p0100qw8fn2j5l8w1",
    "name": "«Շինարար» ՍՊԸ",
    "taxId": null
  }
}
```

Unclaimed:

```json
{
  "data": {
    "supplierPartyId": null,
    "name": null,
    "taxId": null
  }
}
```

`taxId` is `null` for supplier parties in practice: `parties.tax_id` is populated only for
buyers, scraped from the invitation ZIP.

**Errors:**

- `401 UNAUTHENTICATED` / `401 TOKEN_EXPIRED`.
- `403 ROLE_FORBIDDEN`.

---

## Set supplier identity

Claims (or unclaims) the party this organization bids as. Requires `org:manage`, not
`bid:write` — this decides whose public win record gets attributed to the account, so a
coordinator entering prices should not be able to re-point it. It is **never auto-matched on
name**: party names are scraped Armenian legal names with inconsistent quoting, and a fuzzy
link would attach one company's win record to another account invisibly.

**API:**
`PUT /api/v1/organization/supplier-identity`

**Authentication:** required (Bearer). Permission: `org:manage` (`owner` and `admin` only).

**Request data:**

```json
{
  "supplierPartyId": "cm9zx4k1p0100qw8fn2j5l8w1"
}
```

- `supplierPartyId` (**required**, nullable): a party id (max 40 chars), or `null` to unclaim —
  an organization that linked the wrong party has to be able to undo it.

**Response data:**

The identity, same shape as [Get supplier identity](#get-supplier-identity).

**Errors:**

- `401 UNAUTHENTICATED` / `401 TOKEN_EXPIRED`.
- `403 ROLE_FORBIDDEN`: only `owner` and `admin` hold `org:manage`.
- `404 NOT_FOUND`: "Party not found."
- `409 CONFLICT`: "That supplier is already claimed by another organization." — a partial
  unique index arbitrating, not application logic.
- `422 VALIDATION_FAILED`: `supplierPartyId` omitted.

---

## Search supplier candidates

The picker behind the claim. Ranked by how often each party actually appears in the bid ledger,
since a trading name is rarely unique. Read-level permission, because it only surfaces public
party names already searchable through the tender corpus.

**API:**
`GET /api/v1/organization/supplier-identity/candidates`

**Authentication:** required (Bearer). Permission: `tender:read`.

**Request data:**

No request body

**Query parameters:**

- `q` (**required**): search term, trimmed, 2–200 chars.

Example: `GET /api/v1/organization/supplier-identity/candidates?q=շինարար`

**Response data:**

```json
{
  "data": [
    {
      "id": "cm9zx4k1p0100qw8fn2j5l8w1",
      "name": "«Շինարար» ՍՊԸ",
      "taxId": null,
      "region": "Երևան",
      "bidCount": 47
    }
  ]
}
```

Plain array, not paginated.

**Errors:**

- `401 UNAUTHENTICATED` / `401 TOKEN_EXPIRED`.
- `403 ROLE_FORBIDDEN`.
- `422 VALIDATION_FAILED`: `q` missing or shorter than 2 chars.

---

## Invitations (addressed to me)

The invitee's side of an invitation. All three endpoints are on the
[orgless allowlist](#the-orgless-state) and need no permission — an offer addressed to you is yours
to read and answer, and there may be no tenant yet to hold a role in. The address is always the
session user's own verified email; nothing in the request names it.

## List my invitations

Pending offers addressed to the caller's address, from **any** organization — so someone can join
several clients. An offer sent before the address had an account appears here once that address
registers and verifies. Answered offers drop out, and so do offers from organizations the caller
already belongs to (they cannot be accepted). Newest first.

**API:**
`GET /api/v1/invitations`

**Authentication:** required (Bearer); orgless sessions allowed. No permission check.

**Request data:**

Query parameters:

- `page[size]` (optional): 1–100, default 20.
- `page[cursor]` (optional): `meta.cursor` from the previous page.

**Response data:**

```json
{
  "data": [
    {
      "id": "cm9zx4k1p0500qw8f7t2x6c1n",
      "organization": { "id": "cm9zx4k1p0001qw8f6b3n2v8y", "name": "Shinarar LLC" },
      "role": "coordinator",
      "invitedBy": { "displayName": "Gevorg Sargsyan" },
      "createdAt": "2026-09-15T09:02:11.845Z"
    }
  ],
  "meta": { "cursor": "MjAyNi0wOS0xNVQwOTowMjoxMS44NDVafGNtOXo...", "hasMore": false }
}
```

**Errors:**

- `401 UNAUTHENTICATED` / `401 TOKEN_EXPIRED`.
- `422 VALIDATION_FAILED`: bad page size.

---

## Accept an invitation

Adds a membership at the invitation's role. It **adds, never moves**: every membership the caller
already holds is left exactly as it was.

Where the caller ends up depends on where they are working:

- **Orgless session** → `session` is a full session for the new organization, so they are working
  inside it immediately with no second call.
- **Session already in an organization** → `session` is `null` and the caller stays where they
  are; moving to the new tenant is [Switch organization](#switch-organization).

Someone removed from an organization and invited back joins at the **new** invitation's role.

**API:**
`POST /api/v1/invitations/:id/accept`

**Authentication:** required (Bearer); orgless sessions allowed. No permission check.

**Request data:**

No request body

**Response data:**

```json
{
  "data": {
    "accepted": true,
    "organization": { "id": "cm9zx4k1p0001qw8f6b3n2v8y", "name": "Shinarar LLC" },
    "role": "coordinator",
    "session": {
      "accessToken": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...",
      "refreshToken": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...",
      "expiresIn": 900,
      "user": {
        "id": "cm9zx4k1p0600qw8f2k9b4j7h",
        "email": "armen@example.am",
        "displayName": "Armen Grigoryan",
        "locale": "hy",
        "emailVerified": true
      },
      "organization": { "id": "cm9zx4k1p0001qw8f6b3n2v8y", "name": "Shinarar LLC" },
      "role": "coordinator",
      "plan": "pro",
      "organizations": [
        { "id": "cm9zx4k1p0001qw8f6b3n2v8y", "name": "Shinarar LLC", "role": "coordinator" }
      ]
    }
  }
}
```

**Errors:**

- `401 UNAUTHENTICATED` / `401 TOKEN_EXPIRED`.
- `404 NOT_FOUND`: no such invitation addressed to the caller (another person's invitation id
  answers the same).
- `409 CONFLICT`: already accepted; already declined ("Ask for a new one to join."); or the caller is
  already a member of that organization — the offer stays pending and their role is unchanged.

Re-accepting an offer the caller already accepted, from an orgless session while still holding that
membership, answers `200` with a session again rather than `409` — the recovery path if the first
response was lost after the membership was created.
- `429 RATE_LIMITED`: more than 30 answers/minute for this user.

---

## Decline an invitation

Records a refusal the sender can see as `declined` in
[List sent invitations](#list-sent-invitations). Nothing is announced to the sender's organization.
A declined offer can be re-sent by the organization, which returns it to pending.

**API:**
`POST /api/v1/invitations/:id/decline`

**Authentication:** required (Bearer); orgless sessions allowed. No permission check.

**Request data:**

No request body

**Response data:**

```json
{
  "data": {
    "declined": true
  }
}
```

**Errors:**

- `401 UNAUTHENTICATED` / `401 TOKEN_EXPIRED`.
- `404 NOT_FOUND`: no such invitation addressed to the caller.
- `409 CONFLICT`: already accepted or already declined.
- `429 RATE_LIMITED`: more than 30 answers/minute for this user.

---

## Document vault

Uploading is a **three-step handshake**, not a POST of bytes:

1. `POST /vault-documents` — declare what you are about to send; get a presigned PUT back.
2. **PUT the file straight to object storage** at the returned URL, with the returned headers
   verbatim. This is not an API request and is not documented as an endpoint here — every
   header is signed into the URL, so changing or omitting one fails the signature.
3. `POST /vault-documents/:id/confirm` — the API asks storage whether the object arrived.

The storage key is minted server-side from the organization id and content hash. A presigned
PUT is a write capability, so a client-supplied key would let one tenant write into another's
prefix. A row without `status: "ready"` has no file behind it.

## List vault documents

**API:**
`GET /api/v1/vault-documents`

**Authentication:** required (Bearer). Permission: `vault:read` (held by `viewer` too). Not
plan-gated — a supplier's own certificates are their data.

**Request data:**

No request body

**Query parameters:**

- `filter[kind]` (optional): one or several kind slugs (lowercase, `^[a-z0-9][a-z0-9-]{1,58}[a-z0-9]$`).
- `filter[status]` (optional, default `ready`): `ready`, `pending`, `rejected`, or `all`.
  `pending` rows are hidden by default — they have no file behind them.
- `page[size]` (optional): 1–100, default 20.
- `page[cursor]` (optional): opaque cursor, max 200 chars.

**Response data:**

```json
{
  "data": [
    {
      "id": "cm9zx4k1p0080qw8fr3t7y9u2",
      "kind": "tax-clearance",
      "filename": "tax-clearance-2026.pdf",
      "contentType": "application/pdf",
      "sizeBytes": 184320,
      "status": "ready",
      "issuedAt": "2026-01-04T00:00:00.000Z",
      "notes": null,
      "expiry": {
        "status": "valid",
        "daysRemaining": 118,
        "validUntil": "2027-01-01T00:00:00.000Z"
      },
      "createdAt": "2026-01-05T11:20:04.000Z",
      "updatedAt": "2026-01-05T11:21:16.000Z"
    }
  ],
  "meta": {
    "cursor": "MjAyNi0wMS0wNVQxMToyMDowNC4wMDBafGNtOXp4NGsxcDAwODBxdzhmcjN0N3k5dTI",
    "hasMore": false
  }
}
```

`storage_key` and `hash` are deliberately **not on the wire** — publishing the key would invite
someone to construct their own, which is the one thing tenant namespacing exists to prevent.

Expiry is derived on every read, never stored: `no_expiry` when `validUntil` is `null` (a
company registration does not lapse), `expiring_soon` within `VAULT.EXPIRY_WARN_DAYS[0]`
(default 30) days, `expired` at or past the date, `valid` otherwise.

**Errors:**

- `401 UNAUTHENTICATED` / `401 TOKEN_EXPIRED`.
- `403 ROLE_FORBIDDEN`.
- `422 VALIDATION_FAILED`: bad `filter[status]`; malformed kind slug; `page[size]` over 100.

---

## Vault summary

Counts per kind with how many have lapsed — the header a vault list needs. Counts only
`ready` documents.

**API:**
`GET /api/v1/vault-documents/summary`

**Authentication:** required (Bearer). Permission: `vault:read`.

**Request data:**

No request body

**Response data:**

```json
{
  "data": {
    "byKind": [
      { "kind": "company-registration", "total": 1, "expired": 0 },
      { "kind": "iso-certificate", "total": 3, "expired": 1 },
      { "kind": "tax-clearance", "total": 2, "expired": 0 }
    ]
  }
}
```

**Errors:**

- `401 UNAUTHENTICATED` / `401 TOKEN_EXPIRED`.
- `403 ROLE_FORBIDDEN`.

---

## Vault upload options

What a client needs to build an upload form without hardcoding it. Served rather than
documented, so a cap raised in config takes effect without a client release.

**API:**
`GET /api/v1/vault-documents/options`

**Authentication:** required (Bearer). Permission: `vault:read`.

**Request data:**

No request body

**Response data:**

```json
{
  "data": {
    "contentTypes": [
      "application/pdf",
      "image/jpeg",
      "image/png",
      "image/tiff",
      "application/msword",
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      "application/vnd.ms-excel",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "application/zip"
    ],
    "maxUploadBytes": 20971520,
    "suggestedKinds": [
      "tax-clearance",
      "company-registration",
      "bank-reference",
      "iso-certificate",
      "licence",
      "insurance",
      "financial-statement",
      "power-of-attorney",
      "reference-letter",
      "other"
    ],
    "expiryWarnDays": [30, 7, 1]
  }
}
```

`suggestedKinds` is a **suggested vocabulary, not an enum** — `kind` accepts any slug, because
the set of documents a buyer can demand is defined by the tender, not by this product.
`maxUploadBytes` and `expiryWarnDays` reflect current config (defaults shown).

**Errors:**

- `401 UNAUTHENTICATED` / `401 TOKEN_EXPIRED`.
- `403 ROLE_FORBIDDEN`.

---

## Register document (get upload URL)

Step 1 of the handshake: reserves the row and hands back a presigned PUT. A hash the
organization already holds is not an error — it is the same document — so this answers with the
existing row and `upload: null` rather than a `409` the customer would have to interpret.

**API:**
`POST /api/v1/vault-documents`

**Authentication:** required (Bearer). Permission: `vault:write` (not held by `viewer`).

**Request data:**

```json
{
  "kind": "tax-clearance",
  "filename": "tax-clearance-2026.pdf",
  "contentType": "application/pdf",
  "sha256": "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08",
  "sizeBytes": 184320,
  "validUntil": "2027-01-01T00:00:00.000Z",
  "issuedAt": "2026-01-04T00:00:00.000Z",
  "notes": "Renewed annually in January."
}
```

- `kind` (**required**): lowercase slug, 3–60 chars, `^[a-z0-9][a-z0-9-]{1,58}[a-z0-9]$`.
- `filename` (**required**): 1–255 chars.
- `contentType` (**required**): one of the nine types listed in
  [Vault upload options](#vault-upload-options).
- `sha256` (**required**): 64 lowercase hex chars — the dedupe key and the tail of the storage
  key, so it must arrive before the bytes do.
- `sizeBytes` (**required**): integer 1 – `VAULT.MAX_UPLOAD_BYTES` (default 20 MiB).
- `validUntil` (optional, default `null`): ISO-8601 date, or `null` for "does not expire". A
  past date is accepted — an organization onboarding with history has expired certificates, and
  refusing them would make the vault lie about what they hold.
- `issuedAt` (optional, default `null`): ISO-8601 date, not in the future, or `null`.
- `notes` (optional): max 2000 chars, `null` or `""`.

**Response data:**

`201 Created` — a row really is created, it just has no bytes yet.

```json
{
  "data": {
    "document": {
      "id": "cm9zx4k1p0080qw8fr3t7y9u2",
      "kind": "tax-clearance",
      "filename": "tax-clearance-2026.pdf",
      "contentType": "application/pdf",
      "sizeBytes": 184320,
      "status": "pending",
      "issuedAt": "2026-01-04T00:00:00.000Z",
      "notes": "Renewed annually in January.",
      "expiry": {
        "status": "valid",
        "daysRemaining": 118,
        "validUntil": "2027-01-01T00:00:00.000Z"
      },
      "createdAt": "2026-09-05T10:40:00.000Z",
      "updatedAt": null
    },
    "duplicate": false,
    "upload": {
      "url": "https://minio.example.com/tenderiq/vault/cm9zx.../9f86d081....pdf?X-Amz-Algorithm=...",
      "method": "PUT",
      "headers": {
        "Content-Type": "application/pdf",
        "Content-Length": "184320",
        "x-amz-server-side-encryption": "AES256"
      },
      "expiresIn": 900
    }
  }
}
```

When the organization already holds this exact file as `ready`:

```json
{
  "data": {
    "document": { },
    "duplicate": true,
    "upload": null
  }
}
```

`upload.headers` must be sent **verbatim** on the PUT — every one is signed into the URL, and a
PUT that changes or omits any of them is rejected by storage with no explanation the client
could act on. The exact header set depends on the storage driver's signing configuration.

**Errors:**

- `401 UNAUTHENTICATED` / `401 TOKEN_EXPIRED`.
- `403 ROLE_FORBIDDEN`: `viewer` lacks `vault:write`.
- `422 VALIDATION_FAILED`: unsupported `contentType`; `sha256` not 64 hex chars; `sizeBytes`
  over the cap; malformed `kind` slug; `issuedAt` in the future.
- `503 DEPENDENCY_UNAVAILABLE`: "Document uploads are not available with the current storage
  driver." — the local filesystem driver cannot presign at all; that is a deployment problem,
  not a client one.

---

## Confirm upload

Step 3: did the bytes actually arrive? This process never observes the upload, so the only
honest way to answer is to ask storage. A missing object leaves the row `pending` — retryable
with a fresh URL — rather than rejected, because the usual cause is a client that has not
finished yet. The size storage reports **overwrites** the declared one: the declared size was a
hint used to bound the presigned URL; this is the fact.

**API:**
`POST /api/v1/vault-documents/:id/confirm`

**Authentication:** required (Bearer). Permission: `vault:write`.

**Path parameters:**

- `id`: the vault document's CUID2 id.

**Request data:**

No request body

**Response data:**

The document with `status: "ready"`, same shape as one list entry.

```json
{
  "data": {
    "id": "cm9zx4k1p0080qw8fr3t7y9u2",
    "kind": "tax-clearance",
    "filename": "tax-clearance-2026.pdf",
    "contentType": "application/pdf",
    "sizeBytes": 184320,
    "status": "ready",
    "issuedAt": "2026-01-04T00:00:00.000Z",
    "notes": "Renewed annually in January.",
    "expiry": {
      "status": "valid",
      "daysRemaining": 118,
      "validUntil": "2027-01-01T00:00:00.000Z"
    },
    "createdAt": "2026-09-05T10:40:00.000Z",
    "updatedAt": "2026-09-05T10:41:52.000Z"
  }
}
```

Confirming an already-`ready` document is idempotent and returns the row unchanged.

**Errors:**

- `401 UNAUTHENTICATED` / `401 TOKEN_EXPIRED`.
- `403 ROLE_FORBIDDEN`.
- `404 NOT_FOUND`: "Vault document not found."
- `409 CONFLICT`: "No uploaded file found for this document yet." with
  `details: { documentId, hint }`; or "This upload was rejected and cannot be confirmed."
- `422 VALIDATION_FAILED`: the stored object exceeds the size cap — the row is marked
  `rejected` and `details[0].field` is `sizeBytes`.
- `503 DEPENDENCY_UNAVAILABLE`: "Document storage is temporarily unavailable." Object storage
  being unreachable is a dependency failure, not a bug — this is deliberately not a 500.

---

## Vault document detail

**API:**
`GET /api/v1/vault-documents/:id`

**Authentication:** required (Bearer). Permission: `vault:read`.

**Path parameters:**

- `id`: the vault document's CUID2 id.

**Request data:**

No request body

**Response data:**

One document, same shape as a list entry.

**Errors:**

- `401 UNAUTHENTICATED` / `401 TOKEN_EXPIRED`.
- `403 ROLE_FORBIDDEN`.
- `404 NOT_FOUND`: "Vault document not found." (also for another tenant's id).

---

## Download link

Returns a short-lived presigned URL **in the envelope** rather than redirecting to it. A 302
would put a credential in a Location header and in browser history, and would break the
`{ data, meta }` contract every other endpoint keeps.

**API:**
`GET /api/v1/vault-documents/:id/download`

**Authentication:** required (Bearer). Permission: `vault:read`.

**Path parameters:**

- `id`: the vault document's CUID2 id.

**Request data:**

No request body

**Response data:**

```json
{
  "data": {
    "url": "https://minio.example.com/tenderiq/vault/cm9zx.../9f86d081....pdf?X-Amz-Algorithm=...",
    "expiresIn": 300,
    "filename": "tax-clearance-2026.pdf",
    "contentType": "application/pdf"
  }
}
```

`expiresIn` is `VAULT.DOWNLOAD_URL_TTL_SECONDS` (default 300). Short-lived because the URL
itself is the only thing standing between the object and anyone it is forwarded to.

**Errors:**

- `401 UNAUTHENTICATED` / `401 TOKEN_EXPIRED`.
- `403 ROLE_FORBIDDEN`.
- `404 NOT_FOUND`: "Vault document not found."
- `409 CONFLICT`: "This document has no uploaded file to download." — status is not `ready`.
- `503 DEPENDENCY_UNAVAILABLE`: "Document storage is temporarily unavailable."

---

## Update vault document

Edits metadata only — never the bytes. Replacing a file means registering a new document.

**API:**
`PATCH /api/v1/vault-documents/:id`

**Authentication:** required (Bearer). Permission: `vault:write`.

**Path parameters:**

- `id`: the vault document's CUID2 id.

**Request data:**

```json
{
  "validUntil": "2027-06-30T00:00:00.000Z",
  "notes": "Extended after the January renewal."
}
```

All optional individually, but at least one required.

- `kind` (optional): lowercase slug, 3–60 chars.
- `filename` (optional): 1–255 chars.
- `validUntil` (optional): ISO-8601 date, or `null` for "does not expire".
- `issuedAt` (optional): ISO-8601 date, not in the future, or `null`.
- `notes` (optional): max 2000 chars, `null` or `""`.

`contentType`, `sha256` and `sizeBytes` are **not** updatable.

**Response data:**

The updated document, same shape as a list entry.

**Errors:**

- `401 UNAUTHENTICATED` / `401 TOKEN_EXPIRED`.
- `403 ROLE_FORBIDDEN`.
- `404 NOT_FOUND`: "Vault document not found."
- `422 VALIDATION_FAILED`: empty body; `issuedAt` in the future; malformed kind slug.

---

## Delete vault document

Erases the row **and the file** — object first, row second, so a failed erasure is retryable
rather than reporting success while the certificate survives in the bucket. Checklist items
pointing at it are detached, not deleted: the requirement still exists, it is simply unmet
again, and the count is returned so the client can say so.

**API:**
`DELETE /api/v1/vault-documents/:id`

**Authentication:** required (Bearer). Permission: `vault:write`.

**Path parameters:**

- `id`: the vault document's CUID2 id.

**Request data:**

No request body

**Response data:**

`204 No Content`

No response body

The service computes `{ deleted: true, detachedChecklistItems: 2 }` internally, but the
controller answers `204` and discards it — the count does not reach the client.

**Errors:**

- `401 UNAUTHENTICATED` / `401 TOKEN_EXPIRED`.
- `403 ROLE_FORBIDDEN`.
- `404 NOT_FOUND`: "Vault document not found."
- `503 DEPENDENCY_UNAVAILABLE`: "Document storage is temporarily unavailable." — the row is
  deliberately left intact, because reporting a successful erasure while the file survives is
  the one failure this operation must not have.

---

## Notifications

## List notifications

The organization's alert feed, newest first. Reading your own alerts needs no more than
`tender:read` — every role has it, including `viewer`, because being told about a tender is not
a privileged act.

**API:**
`GET /api/v1/notifications`

**Authentication:** required (Bearer). Permission: `tender:read`.

**Request data:**

No request body

**Query parameters:**

- `limit` (optional): integer 1–100, default 50. Note this endpoint uses a flat `limit`, not
  the `page[size]` convention, and returns no `meta`.

**Response data:**

```json
{
  "data": [
    {
      "id": "cm9zx4k1p0110qw8fv5b8n3k7",
      "type": "tender-match",
      "tenderId": "cm9zx4k1p0010qw8fj3k9d2p1",
      "payload": {
        "title": "Շինարարական աշխատանքների գնում",
        "referenceCode": "ՀՀ-ԳՀԱՊՁԲ-24/118",
        "deadlineAt": "2026-09-12T11:00:00.000Z",
        "estimatedValue": "12750000.00",
        "currency": "AMD",
        "buyerName": "«Երևանի քաղաքապետարան» ՀՈԱԿ",
        "sourceUrl": "https://eauction.armeps.am/tender/284391/invitation.zip",
        "score": 0.82,
        "reasons": ["cpv:45000000", "keyword:ասֆալտ"],
        "matchedSearches": [
          { "id": "cm9zx4k1p0030qw8fp2r6t8w4", "name": "Road works — Yerevan", "score": 0.82, "reasons": ["cpv:45000000", "keyword:ասֆալտ"] },
          { "id": "cm9zx4k1p0031qw8fk7d2m1c9", "name": "Asphalt", "score": 0.5, "reasons": ["keyword:ասֆալտ"] }
        ]
      },
      "readAt": null,
      "createdAt": "2026-08-14T09:41:02.775Z"
    }
  ]
}
```

`type` values written by the workers today:

| Type | Raised by | Extra payload fields |
|---|---|---|
| `tender-match` | matcher | `score`, `reasons`, `matchedSearches` |
| `amendment` | matcher | `score`, `reasons`, `matchedSearches`, `changedFields` |
| `reminder-72h`, `reminder-24h` | reminder (matched safety net) | `hoursRemaining` |
| `countdown-48h`, `countdown-12h`, `countdown-3h` | reminder (pipeline countdown) | `hoursRemaining`, `trackedTenderId`, `pipelineStatus` |
| `vault-expiry-30d`, `vault-expiry-7d`, `vault-expiry-1d` | vault expiry sweep | `documentId`, `kind`, `filename`, `validUntil`, `daysRemaining` |
| `vault-expired` | vault expiry sweep | same, with `daysRemaining: 0` |

A tender raises **one** match alert per organization however many of its saved searches it
matches. `matchedSearches` lists them all (`id`, `name` as it was when the alert was raised,
`score`, `reasons`), best score first; the top-level `score` and `reasons` are the best match's.
Alerts raised before `matchedSearches` existed do not carry it.

`payload` is a JSONB column whose contents vary by `type` as above; the column itself is not
schema-constrained. `tenderId` is `null` on vault alerts — those dedupe on
`notifications.subject_id` instead (the document id), which is why the dedupe constraint is
`(organization_id, type, tender_id, subject_id)` with `NULLS NOT DISTINCT`.

**Errors:**

- `401 UNAUTHENTICATED` / `401 TOKEN_EXPIRED`.
- `403 ROLE_FORBIDDEN`.
- `422 VALIDATION_FAILED`: `limit` outside 1–100.

---

## Mark notification read

**API:**
`PATCH /api/v1/notifications/:id/read`

**Authentication:** required (Bearer). Permission: `tender:read`.

**Path parameters:**

- `id`: the notification's CUID2 id.

**Request data:**

No request body

**Response data:**

```json
{
  "data": {
    "id": "cm9zx4k1p0110qw8fv5b8n3k7",
    "readAt": "2026-09-05T10:52:14.881Z"
  }
}
```

`readAt` is generated in the service at response time, not read back from the row.

**Errors:**

- `401 UNAUTHENTICATED` / `401 TOKEN_EXPIRED`.
- `403 ROLE_FORBIDDEN`.
- `404 NOT_FOUND`: "Notification not found." (also for another tenant's id).

---

## Intelligence (Pro+)

Every endpoint in this section requires `intelligence:read`, which all five roles hold but
which is **additionally plan-gated** to `pro`, `business` and `enterprise`. A `free` plan gets
`402 PLAN_UPGRADE_REQUIRED`, so the client can offer an upgrade rather than a dead end. Role is
checked before plan, so a `viewer` on an Enterprise plan is told their *role* is the problem
rather than being invited to upgrade a plan that would not help.

**Never fabricate intelligence.** Below `INTELLIGENCE.MIN_COMPARABLES` (default 5) comparables,
these endpoints answer `status: "insufficient_data"` with `200`, not a number and not an error.

## Tender benchmark

The price benchmark panel for one tender. Resolves the tender's own category and buyer, so the
client asks about a tender rather than having to know how comparables are selected. A
multi-category tender is benchmarked on its headline code.

**API:**
`GET /api/v1/tenders/:id/benchmark`

**Authentication:** required (Bearer). Permission: `intelligence:read` + Pro/Business/Enterprise plan.

**Path parameters:**

- `id`: the tender's CUID2 id.

**Request data:**

No request body

**Response data:**

```json
{
  "data": {
    "tenderId": "cm9zx4k1p0010qw8fj3k9d2p1",
    "cpvCode": "45000000",
    "estimatedValue": 12750000,
    "currency": "AMD",
    "benchmark": {
      "status": "ok",
      "cpvCode": "45000000",
      "sampleSize": 34,
      "distinctTenders": 9,
      "minPrice": 4200000,
      "medianPrice": 9850000,
      "maxPrice": 24100000,
      "avgDiscountPct": 6.88,
      "computedAt": "2026-09-04T03:15:00.000Z",
      "basis": "materialized"
    }
  }
}
```

Not enough comparables:

```json
{
  "data": {
    "tenderId": "cm9zx4k1p0010qw8fj3k9d2p1",
    "cpvCode": null,
    "estimatedValue": 12750000,
    "currency": "AMD",
    "benchmark": {
      "status": "insufficient_data",
      "reason": "tender has no CPV code",
      "sampleSize": 0
    }
  }
}
```

`benchmark.status` is `ok` or `insufficient_data`. The `insufficient_data` shape carries
`reason`, `sampleSize`, and — when a tier was actually attempted — `required` and `basis`, so
the client can say "3 of 5 needed" rather than issue a bare refusal.

`basis` names how the comparables were selected: `materialized` (a stored row), or a live tier —
`buyer_exact_cpv`, `exact_cpv`, `cpv_family`. `distinctTenders` is the figure to read for
confidence, **not `sampleSize`** — awards are per lot, so one multi-lot procurement can clear
the threshold alone.

**Errors:**

- `401 UNAUTHENTICATED` / `401 TOKEN_EXPIRED`.
- `402 PLAN_UPGRADE_REQUIRED`: plan is `free` or `starter`.
- `403 ROLE_FORBIDDEN`.
- `404 NOT_FOUND`: "Tender not found."

---

## Competitor prices

Who bid on this tender, at what price, and who won each lot. Keyed entirely by tender id — it
needs no CPV code, so it works across the whole corpus rather than the third of it that has a
category, which makes it the intelligence section's headline. Rejected bids are included by
default and labelled, never silently dropped: a supplier comparing itself against a headline
price is entitled to know that price was disqualified.

**API:**
`GET /api/v1/tenders/:id/competitor-prices`

**Authentication:** required (Bearer). Permission: `intelligence:read` + Pro+ plan.

**Path parameters:**

- `id`: the tender's CUID2 id.

**Query parameters:**

- `filter[lot]` (optional): integer ≥ 1 — narrow to a single lot.
- `filter[includeRejected]` (optional, default `true`): boolean.

**Request data:**

No request body

**Response data:**

Settled tender:

```json
{
  "data": {
    "status": "ok",
    "tenderId": "cm9zx4k1p0010qw8fj3k9d2p1",
    "settled": true,
    "currency": "AMD",
    "summary": {
      "lotCount": 3,
      "lotsAwarded": 3,
      "lotsWithNoAcceptedBid": 0,
      "totalAwarded": 11450000,
      "totalBudget": 12750000,
      "totalDiscountPct": 10.2,
      "distinctBidders": 5,
      "avgBiddersPerLot": 2.7,
      "soleBidderLots": 1
    },
    "expectedCompetition": {
      "status": "ok",
      "sampleLots": 88,
      "avgBidders": 2.4,
      "medianBidders": 2,
      "maxBidders": 9,
      "soleBidderLots": 31,
      "soleBidderRatePct": 35.2,
      "basis": "buyer_exact_cpv",
      "sinceMonths": 24
    },
    "lots": [
      {
        "lotNumber": 1,
        "name": "Ճանապարհային ծածկ",
        "cpvCode": "45233120",
        "budgetPrice": 4250000,
        "currency": "AMD",
        "bidderCount": 3,
        "acceptedCount": 2,
        "rejectedCount": 1,
        "competition": "moderate",
        "winner": {
          "supplierId": "cm9zx4k1p0100qw8fn2j5l8w1",
          "name": "«Շինարար» ՍՊԸ",
          "region": "Երևան",
          "price": 3810000,
          "discountPct": 10.4,
          "awardedAt": "2026-07-18T00:00:00.000Z"
        },
        "outcome": "awarded",
        "priceRange": { "min": 3810000, "max": 4180000 },
        "bids": [
          {
            "supplierId": "cm9zx4k1p0100qw8fn2j5l8w1",
            "name": "«Շինարար» ՍՊԸ",
            "region": "Երևան",
            "rank": 1,
            "initialOffer": 4250000,
            "initialOfferUnreliable": false,
            "finalOffer": 3810000,
            "vatPct": 20,
            "status": "accepted",
            "isWinner": true,
            "discountPct": 10.4,
            "gapFromWinnerPct": 0,
            "applicationUrl": "https://eauction.armeps.am/..."
          }
        ]
      }
    ],
    "title": "Շինարարական աշխատանքների գնում",
    "referenceCode": "ՀՀ-ԳՀԱՊՁԲ-24/118",
    "buyer": {
      "id": "cm9zx4k1p0020qw8fh7v2x4m6",
      "name": "«Երևանի քաղաքապետարան» ՀՈԱԿ",
      "region": "Երևան"
    }
  }
}
```

Tender not yet settled (no public bid ledger):

```json
{
  "data": {
    "status": "no_public_bids",
    "reason": "This tender has no published bid ledger yet.",
    "tenderId": "cm9zx4k1p0010qw8fj3k9d2p1",
    "settled": false,
    "expectedCompetition": { },
    "lots": [],
    "title": "Շինարարական աշխատանքների գնում",
    "referenceCode": "ՀՀ-ԳՀԱՊՁԲ-24/118",
    "buyer": { }
  }
}
```

- `status`: `ok` or `no_public_bids`.
- `competition`: a band derived from `bidderCount` (`sole` when exactly one bidder).
- `outcome`: `awarded` or `no_accepted_bid`. **A win comes from `awards`, never from
  `rank = 1`** — the source ranks rejected submissions too, which is why `isWinner` and
  `winner` are award-derived.
- `initialOfferUnreliable: true` marks an opening offer that exceeds the published budget,
  which the source sometimes emits; the value is then nulled rather than reported.
- `totalDiscountPct` is computed from the totals, not as a mean of per-lot percentages — a mean
  of ratios would weight a 50,000 AMD lot the same as a 50,000,000 one.
- `distinctBidders` is smaller than the sum of per-lot counts, because the same company usually
  bids on every lot.

**Errors:**

- `401 UNAUTHENTICATED` / `401 TOKEN_EXPIRED`.
- `402 PLAN_UPGRADE_REQUIRED`.
- `403 ROLE_FORBIDDEN`.
- `404 NOT_FOUND`: "Tender not found."
- `422 VALIDATION_FAILED`: `filter[lot]` below 1 or not an integer.

---

## AI price recommendation

What to bid, and why. A GET because it is a read and safe to treat as one: the answer is cached
in Redis under a hash of its own evidence, so repeat views of an unchanged tender cost nothing
and a new award invalidates it automatically.

Answers `200` in every case a client can act on, **including the refusals** — turning either
into a 4xx/5xx would make an honest answer look like a fault.

**API:**
`GET /api/v1/tenders/:id/price-recommendation`

**Authentication:** required (Bearer). Permission: `intelligence:read` + Pro+ plan.

**Path parameters:**

- `id`: the tender's CUID2 id.

**Request data:**

No request body

**Response data:**

Three distinct `status` values are possible.

**`ok`** — a recommendation with its evidence:

```json
{
  "data": {
    "tenderId": "cm9zx4k1p0010qw8fj3k9d2p1",
    "status": "ok",
    "recommendedLow": 9200000,
    "recommendedHigh": 10400000,
    "rationale": "Recent awards in this category settled 6–11% below budget...",
    "risks": ["Only 9 distinct procurements support this range."],
    "currency": "AMD",
    "basis": "exact_cpv",
    "sampleSize": 34,
    "distinctTenders": 9,
    "evidence": {
      "status": "ok",
      "cpvCode": "45000000",
      "tender": {
        "estimatedValue": 12750000,
        "currency": "AMD",
        "procedureType": "e_auction",
        "lotCount": 3,
        "deadlineAt": "2026-09-12T11:00:00.000Z"
      },
      "benchmark": { },
      "competition": { },
      "buyer": {
        "name": "«Երևանի քաղաքապետարան» ՀՈԱԿ",
        "tenderCount": 142,
        "avgDiscountPct": 8.1,
        "avgBidders": 2.4,
        "soleBidderRatePct": 35.2,
        "distinctWinners": 46
      },
      "comparables": [
        {
          "publishedAt": "2026-04-02T00:00:00.000Z",
          "wonAt": 8900000,
          "budget": 9800000,
          "bidderCount": 3,
          "cpvCode": "45000000"
        }
      ],
      "untrustedSourceText": {
        "tenderTitle": "Շինարարական աշխատանքների գնում",
        "comparableTitles": ["Ճանապարհների ընթացիկ նորոգում"]
      }
    },
    "model": "claude-opus-5",
    "advisory": true,
    "disclaimer": "Advisory only. Derived from public award records; verify against the tender documents before bidding.",
    "cached": true
  }
}
```

The exact fields inside the model-produced half (`recommendedLow`, `recommendedHigh`,
`rationale`, `risks`) come from the AI output schema and are spread into the response; they are
schema-validated before use, and a range falling outside the observed `minPrice`/`maxPrice` is
**rejected, not clamped** — silently trimming it would hide that the model went outside its
evidence. `cached: true` appears only on a cache hit.

**`insufficient_data`** — too few comparables to support any recommendation:

```json
{
  "data": {
    "tenderId": "cm9zx4k1p0010qw8fj3k9d2p1",
    "status": "insufficient_data",
    "reason": "fewer than 5 comparable awards",
    "required": 5,
    "sampleSize": 2,
    "cpvCode": "45000000",
    "competition": { },
    "advisory": true
  }
}
```

**`evidence_only`** — the numbers exist but the explanation could not be produced (AI not
configured, refusal or truncation, schema validation failure, or a range outside the evidence):

```json
{
  "data": {
    "tenderId": "cm9zx4k1p0010qw8fj3k9d2p1",
    "status": "evidence_only",
    "reason": "AI explanation is not configured; the underlying evidence is included.",
    "evidence": { },
    "advisory": true
  }
}
```

**Errors:**

- `401 UNAUTHENTICATED` / `401 TOKEN_EXPIRED`.
- `402 PLAN_UPGRADE_REQUIRED`.
- `403 ROLE_FORBIDDEN`.
- `404 NOT_FOUND`: "Tender not found."

---

## Category benchmark

The benchmark for a CPV category directly, optionally narrowed to one buyer — the pre-bid
question, with no tender to hang it off.

**API:**
`GET /api/v1/benchmarks/:cpv`

**Authentication:** required (Bearer). Permission: `intelligence:read` + Pro+ plan.

**Path parameters:**

- `cpv`: the CPV code, e.g. `45000000`.

**Query parameters:**

- `buyerId` (optional): narrow the comparables to one buying agency. Note: **not** validated by
  a Joi schema on this route — it is read straight off `req.query`.

**Request data:**

No request body

**Response data:**

The bare benchmark object — the same shape nested under `benchmark` in
[Tender benchmark](#tender-benchmark), not wrapped in a tender context.

```json
{
  "data": {
    "status": "ok",
    "cpvCode": "45000000",
    "sampleSize": 34,
    "distinctTenders": 9,
    "minPrice": 4200000,
    "medianPrice": 9850000,
    "maxPrice": 24100000,
    "avgDiscountPct": 6.88,
    "computedAt": "2026-09-04T03:15:00.000Z",
    "basis": "materialized"
  }
}
```

**Errors:**

- `401 UNAUTHENTICATED` / `401 TOKEN_EXPIRED`.
- `402 PLAN_UPGRADE_REQUIRED`.
- `403 ROLE_FORBIDDEN`.

An unknown CPV code is not a 404 — it answers `200` with `status: "insufficient_data"`.

---

## Expected competition

How many bidders a lot like this one draws. The estimate, not the record — and the only piece of
competitor intelligence that works on a tender still open for bidding, which is the only kind a
supplier can act on.

Falls through five tiers until one clears the comparables threshold: `buyer_exact_cpv`,
`exact_cpv`, `cpv_family`, `buyer_all_categories`, `corpus`. The fourth exists because CPV is
missing on most of the corpus — "this buyer typically draws 2 bidders" is both available and far
more useful than a corpus-wide average.

**API:**
`GET /api/v1/competition`

**Authentication:** required (Bearer). Permission: `intelligence:read` + Pro+ plan.

**Query parameters:**

- `filter[cpv]` (optional): CPV code, max 20 chars.
- `filter[buyerId]` (optional): buyer party id, max 40 chars.
- `filter[sinceMonths]` (optional): integer 1–120. Defaults to `INTELLIGENCE.RECENCY_MONTHS`.

**Request data:**

No request body

**Response data:**

```json
{
  "data": {
    "status": "ok",
    "sampleLots": 88,
    "avgBidders": 2.4,
    "medianBidders": 2,
    "maxBidders": 9,
    "soleBidderLots": 31,
    "soleBidderRatePct": 35.2,
    "basis": "buyer_exact_cpv",
    "sinceMonths": 24
  }
}
```

Below the threshold:

```json
{
  "data": {
    "status": "insufficient_data",
    "reason": "fewer than 5 comparable lots",
    "sampleLots": 3,
    "required": 5,
    "basis": "corpus"
  }
}
```

`soleBidderRatePct` — the share of comparable lots that drew exactly one bidder — is the number
a supplier should read first: a market that routinely goes uncontested is a market whose lots
are winnable.

**Errors:**

- `401 UNAUTHENTICATED` / `401 TOKEN_EXPIRED`.
- `402 PLAN_UPGRADE_REQUIRED`.
- `403 ROLE_FORBIDDEN`.
- `422 VALIDATION_FAILED`: `filter[sinceMonths]` outside 1–120.

---

## Supplier profile

A competitor's profile — how often they bid, how often they win, how they price, and who they
run into. The role check is `role !== 'buyer'` rather than `role === 'supplier'`: a party that
both buys and supplies is stored as `both`, and demanding an exact role would 404 a genuine
competitor.

**API:**
`GET /api/v1/suppliers/:id/profile`

**Authentication:** required (Bearer). Permission: `intelligence:read` + Pro+ plan.

**Path parameters:**

- `id`: the supplier party's CUID2 id.

**Request data:**

No request body

**Response data:**

```json
{
  "data": {
    "supplier": {
      "id": "cm9zx4k1p0100qw8fn2j5l8w1",
      "name": "«Շինարար» ՍՊԸ",
      "taxId": null,
      "region": "Երևան"
    },
    "activity": {
      "lotsBid": 214,
      "lotsWon": 63,
      "lotsLost": 151,
      "tendersBid": 88,
      "tendersWon": 31,
      "lotsRejected": 12,
      "firstSeen": "2019-03-11T00:00:00.000Z",
      "lastSeen": "2026-08-22T00:00:00.000Z"
    },
    "winRate": {
      "value": 29.4,
      "status": "ok",
      "sample": 214
    },
    "pricing": {
      "avgDiscountPct": 7.2,
      "avgWinningDiscountPct": 11.8,
      "totalWon": 1840000000,
      "largestWin": 96000000,
      "currency": "AMD"
    },
    "categories": {
      "status": "ok",
      "coverageNote": "Derived from tenders whose CPV code is known. CPV is published only inside the invitation archive, so a supplier active in a category may not appear under it.",
      "items": [
        { "cpvCode": "45000000", "lotsBid": 41 }
      ]
    },
    "frequentRivals": [
      {
        "supplierId": "cm9zx4k1p0120qw8fs4k2m6t9",
        "name": "«Ճանշին» ՓԲԸ",
        "sharedLots": 37,
        "theyWon": 14,
        "weWon": 9
      }
    ]
  }
}
```

- `winRate.value` is a **percentage** here (29.4 = 29.4%), unlike
  [`/tracked-tenders/performance`](#bid-performance) where it is a fraction.
- `winRate.status` is `ok`, `insufficient_data` (with `required`), or `no_data`; `value` is
  `null` for the latter two.
- `activity.lotsRejected` is reported separately but is **inside** the loss denominator: being
  disqualified is still having bid and still having lost. The split shows how much of the loss
  column is disqualification rather than being outpriced — a materially different competitor.
- `pricing.avgDiscountPct` vs `avgWinningDiscountPct` is the useful gap: a competitor whose
  winning discount is far below its typical one is winning on something other than price.
- `categories.status` is `ok` or `no_data`; the `coverageNote` ships because CPV exists on only
  about a third of the corpus, and a silently short list would read as "they don't do that".

**Errors:**

- `401 UNAUTHENTICATED` / `401 TOKEN_EXPIRED`.
- `402 PLAN_UPGRADE_REQUIRED`.
- `403 ROLE_FORBIDDEN`.
- `404 NOT_FOUND`: "Supplier not found." — including when the party exists but is a pure buyer.

---

## Buyer profile

A buying agency's profile — what it spends, and how contested its work is.

**API:**
`GET /api/v1/buyers/:id/profile`

**Authentication:** required (Bearer). Permission: `intelligence:read` + Pro+ plan.

**Path parameters:**

- `id`: the buyer party's CUID2 id.

**Request data:**

No request body

**Response data:**

```json
{
  "data": {
    "buyer": {
      "id": "cm9zx4k1p0020qw8fh7v2x4m6",
      "name": "«Երևանի քաղաքապետարան» ՀՈԱԿ",
      "taxId": "00123456",
      "region": "Երևան"
    },
    "volume": {
      "tenderCount": 142,
      "tendersAwarded": 118,
      "lotsAwarded": 306,
      "firstSeen": "2018-06-02T00:00:00.000Z",
      "lastSeen": "2026-08-30T00:00:00.000Z"
    },
    "spend": {
      "totalSpend": 4820000000,
      "totalBudget": 5310000000,
      "totalEstimated": 5402000000,
      "avgDiscountPct": 8.1,
      "distinctWinners": 46,
      "currency": "AMD"
    },
    "competition": {
      "sampleLots": 306,
      "avgBidders": 2.4,
      "medianBidders": 2,
      "soleBidderLots": 108,
      "soleBidderRate": {
        "value": 35.3,
        "status": "ok",
        "sample": 306
      }
    },
    "topSuppliers": [
      {
        "supplierId": "cm9zx4k1p0100qw8fn2j5l8w1",
        "name": "«Շինարար» ՍՊԸ",
        "awardCount": 22,
        "totalValue": 412000000,
        "lastWonAt": "2026-07-18T00:00:00.000Z",
        "shareOfAwardsPct": 7.2,
        "shareOfSpendPct": 8.5
      }
    ]
  }
}
```

`topSuppliers` is named that, **not "favored"** (even though the stored column is
`favored_supplier_ids`), and carries counted evidence only — award count, value, share. Repeat
wins have many ordinary explanations: the firm may be the only one in the region that does the
work, or simply the cheapest. Non-competitive concerns are reportable as signals with evidence,
never as accusations; what ships is the evidence, and the reader draws their own conclusion.

`soleBidderRate` uses the same `{ value, status, sample }` shape as the supplier profile's
`winRate`, with `value` as a percentage.

**Errors:**

- `401 UNAUTHENTICATED` / `401 TOKEN_EXPIRED`.
- `402 PLAN_UPGRADE_REQUIRED`.
- `403 ROLE_FORBIDDEN`.
- `404 NOT_FOUND`: "Buyer not found." — including when the party exists but is a pure supplier.

---

## Integrations

Telegram and email are the two live delivery channels, and this section is where both are
switched on and off.

**A live `channel_subscriptions` row is the only switch.** A channel delivers for an organization
exactly when that organization has a verified, unrevoked row for it — there is no preference
table and no `alert_channels` column that could disagree. Turning a channel off is revoking its
rows; turning it on is linking again.

Telegram needs a handshake because a bot cannot open a conversation: a chat is linked by the user
opening a `t.me/<bot>?start=<token>` deep link.

**Only a private chat can be linked.** A group or supergroup is refused with an in-chat message
and the token is left unspent, so opening the link in the wrong place costs nothing — retry it in
your own chat with the bot. Every subscription is therefore one person's own destination, which is
why deleting a user removes their linked chats rather than orphaning them. Email needs none for a member's **own** address —
`users.email_verified_at` was set before they could log in, so a second confirmation mail is
theatre that fails silently in a spam folder. A *shared* address (`alerts@company.am`) has no
verified owner and would still need the token flow.

## List Telegram links

What the organization has linked. Pending rows are included so a half-finished link is visible.

**API:**
`GET /api/v1/integrations/telegram`

**Authentication:** required (Bearer). Permission: `tender:read`.

**Request data:**

No request body

**Response data:**

```json
{
  "data": [
    {
      "id": "cm9zx4k1p0130qw8fg8p3r5x2",
      "channel": "telegram",
      "status": "linked",
      "active": true,
      "linkedAt": "2026-08-02T13:44:19.201Z",
      "revokedAt": null,
      "failureCount": 0,
      "lastError": null
    }
  ]
}
```

`status` is `linked`, `pending` (a connect link was generated but never opened) or `off` (linked
once, switched off since). **Switched-off rows are listed**, and that is the point: switching a
channel off has never deleted anything, but the listing used to hide revoked rows, which made it
look identical to never having linked — leaving a client with no off state to render and no id to
switch back on. `linkedAt` survives a switch-off because it is the record that someone once proved
they own this chat, and that is exactly what makes turning it back on possible without a new deep
link. Active rows sort first.

The Telegram chat id is **not echoed back** — it is the destination, not a secret, but it
identifies a person's account, so the link is reported as a state instead.

**Errors:**

- `401 UNAUTHENTICATED` / `401 TOKEN_EXPIRED`.
- `403 ROLE_FORBIDDEN`.

---

## Create Telegram link

Mints a single-use, short-lived link token and returns the deep link the user opens in Telegram.
A POST rather than a GET because it mints a credential and writes a row — a GET would be
pre-fetched by browsers and link previews, burning tokens nobody asked for.

Requires `savedsearch:write`, not `org:manage`: linking a chat is configuring *where* alerts go,
which is the same job as defining what to be alerted about.

**API:**
`POST /api/v1/integrations/telegram/link`

**Authentication:** required (Bearer). Permission: `savedsearch:write`.

**Request data:**

No request body

**Response data:**

`201 Created`

```json
{
  "data": {
    "url": "https://t.me/TenderIQBot?start=aB3dE5fG7hJ9kL1mN3pQ5rS7tU9v",
    "expiresInMinutes": 15,
    "token": "aB3dE5fG7hJ9kL1mN3pQ5rS7tU9v"
  }
}
```

The raw `token` is returned so a client can render a QR code. It is not logged anywhere and it
expires (`TELEGRAM.LINK_TOKEN_TTL_MINUTES`).

**Errors:**

- `401 UNAUTHENTICATED` / `401 TOKEN_EXPIRED`.
- `403 ROLE_FORBIDDEN`: `viewer` lacks `savedsearch:write`.
- `503 DEPENDENCY_UNAVAILABLE`: "Telegram alerts are not configured on this server."

---


## List email alert subscriptions

Which addresses in this organization receive alert mail. Revoked rows are omitted; a row is
listed as `active` once verified.

**API:**
`GET /api/v1/integrations/email`

**Authentication:** required (Bearer). Permission: `tender:read`.

**Request data:** none.

**Response data:**

```json
{
  "data": [
    {
      "id": "cm9zx4k1p0130qw8fg8p3r5x2",
      "channel": "email",
      "address": "anna@shinarar.am",
      "status": "active",
      "active": true,
      "linkedAt": "2026-09-10T08:14:00.000Z",
      "revokedAt": null,
      "failureCount": 0,
      "lastError": null
    }
  ]
}
```

`status` is `active`, `pending` or `off`. Switched-off rows are listed so a client can render the
off position of a toggle and has the id needed to flip it back — see the Telegram listing above
for why.

**Errors:**

- `401 UNAUTHENTICATED` / `401 TOKEN_EXPIRED`.
- `403 ROLE_FORBIDDEN`.

---

## Switch email alerts on

Subscribes the **calling member's own** verified account address. Replaces what used to be
`PATCH /notifications/preferences` with `channels: ["email"]`.

**There is no address parameter, and that is the access control.** The only address this endpoint
can ever subscribe is the one on the authenticated user's own row, so no request shape can aim an
organization's alerts somewhere else.

Re-subscribing after a revoke revives the same row rather than inserting a second one —
`channel_subscriptions_live_uq` covers only live rows, so an insert after a revoke would succeed
and leave two histories for one destination.

**API:**
`POST /api/v1/integrations/email`

**Authentication:** required (Bearer). Permission: `savedsearch:write`.

**Request data:** none. A body, if sent, is ignored.

**Response data:** `201`

```json
{
  "data": {
    "id": "cm9zx4k1p0130qw8fg8p3r5x2",
    "channel": "email",
    "address": "anna@shinarar.am",
    "status": "active"
  }
}
```

**Errors:**

- `401 UNAUTHENTICATED` / `401 TOKEN_EXPIRED`.
- `403 ROLE_FORBIDDEN`: `viewer` lacks `savedsearch:write`.
- `403 EMAIL_UNVERIFIED`: the account address has not been confirmed.
- `503 DEPENDENCY_UNAVAILABLE`: "Email alerts are not configured on this server."

---

## Switch email alerts off

Revokes one email subscription. Revokes rather than deletes, so the trail survives and switching
back on revives the same row. When the last live row for a channel is revoked, that channel is
off for the organization and delivery records `skipped`, not `failed`.

**API:**
`DELETE /api/v1/integrations/email/:id`

**Authentication:** required (Bearer). Permission: `savedsearch:write`.

**Path parameters:**

- `id`: the channel subscription's CUID2 id.

**Response data:** `204`, no body.

**Errors:**

- `401 UNAUTHENTICATED` / `401 TOKEN_EXPIRED`.
- `403 ROLE_FORBIDDEN`.
- `404 NOT_FOUND`: "Subscription not found." (also for another tenant's id).

---

## Unlink Telegram chat

Revokes the subscription.

**API:**
`DELETE /api/v1/integrations/telegram/:id`

**Authentication:** required (Bearer). Permission: `savedsearch:write`.

**Path parameters:**

- `id`: the channel subscription's CUID2 id.

**Request data:**

No request body

**Response data:**

`204 No Content`

No response body

**Errors:**

- `401 UNAUTHENTICATED` / `401 TOKEN_EXPIRED`.
- `403 ROLE_FORBIDDEN`.
- `404 NOT_FOUND`: "Subscription not found."

---

## Switch a destination back on

Clears the switch-off. **No new deep link, no second `/start`, no re-confirmation.**

Switching a channel off sets one timestamp and erases nothing — the row keeps its address and the
`verified_at` that says someone once proved they own it. So turning it back on clears that
timestamp. For Telegram that is the whole point: the chat id exists only because the user messaged
the bot once, and making them repeat that to undo their own click is a tax on changing their mind.

**API:**
`POST /api/v1/integrations/telegram/:id/enable`
`POST /api/v1/integrations/email/:id/enable`

**Authentication:** required (Bearer). Permission: `savedsearch:write`.

**Scoped to the caller's own subscription — unlike switching off, which is organization-scoped.**
That asymmetry is deliberate. Turning a colleague's alerts off is configuration; turning them on
starts sending messages to their private chat or personal inbox, and the person who turned it off
may have been the recipient saying stop — through `/stop` in the chat, or the unsubscribe link in
a message. `savedsearch:write` must not overrule that. Another member's subscription is simply not
found.

**Path parameters:**

- `id`: the subscription's CUID2 id, from the listing — which now includes switched-off rows for
  exactly this reason.

**Request data:**

No request body.

**Response data:**

```json
{
  "data": {
    "id": "cm9zx4k1p0130qw8fg8p3r5x2",
    "channel": "telegram",
    "status": "linked",
    "active": true,
    "linkedAt": "2026-08-02T13:44:19.201Z",
    "revokedAt": null,
    "failureCount": 0,
    "lastError": null
  }
}
```

`failureCount` and `lastError` are reset. A destination that was auto-revoked after repeated
failures is being given a genuine second chance, and carrying the old count over would revoke it
again on the first hiccup.

**Idempotent**: enabling an already-active subscription reports the same success. A toggle pressed
twice, or two tabs saving at once, must not fail for a state the caller was asking for anyway.

**Errors:**

- `401 UNAUTHENTICATED` / `401 TOKEN_EXPIRED`.
- `403 ROLE_FORBIDDEN`.
- `404 NOT_FOUND`: no such subscription, another organization's, or another member's.
- `409 CONFLICT`: the row was never confirmed — a pending link has no address, so there is nothing
  to reactivate. Finish linking instead.

Note the related case: a member with **no row at all** switches email on with
`POST /integrations/email` (no body, no id), which creates or revives one from their own verified
address. This endpoint is for a row that already exists.

---

## Telegram webhook

Telegram's inbound update. **Not a frontend endpoint** — it is called by Telegram's servers —
but it is a documented HTTP route, and it is the only unauthenticated write path in the API.

Three deliberate behaviours: it refuses outright when no secret is configured (a webhook that
accepts anything because an env var is unset is worse than one switched off); a bad secret gets
**404, not 401**, so an unauthorised caller learns nothing; and once the secret checks out it
**always answers 200**, even when handling fails, because Telegram retries non-2xx and escalates
to disabling the webhook — a bug in the handler must not cost the integration.

**API:**
`POST /api/v1/integrations/telegram/webhook`

**Authentication:** not a Bearer token. The secret header **is** the entire access control,
compared in constant time.

**Headers:**

- `x-telegram-bot-api-secret-token`: must equal `TELEGRAM.WEBHOOK_SECRET`.

**Request data:**

A Telegram Bot API update, whitelisted to the four fields this bot reads. Unknown fields are
stripped, and Telegram sends exactly one of `message` / `my_chat_member` per update, so neither
is individually required.

```json
{
  "update_id": 884213077,
  "message": {
    "chat": { "id": 123456789 },
    "text": "/start aB3dE5fG7hJ9kL1mN3pQ5rS7tU9v"
  }
}
```

Or:

```json
{
  "update_id": 884213078,
  "my_chat_member": {
    "chat": { "id": 123456789 },
    "new_chat_member": { "status": "kicked" }
  }
}
```

- `update_id` (optional): integer.
- `message.chat.id` (**required** within `message`): number or string.
- `message.text` (optional): max 4096 chars. Commands handled: `/start <token>` and `/stop`.
- `my_chat_member.chat.id` (**required** within `my_chat_member`): number or string.
- `my_chat_member.new_chat_member.status` (optional): max 32 chars.

**Response data:**

```json
{
  "ok": true
}
```

Note this is **not** the `{ data }` envelope — Telegram expects a bare 200, and the shape is
what its API wants rather than what this API's clients expect. A body that fails validation
also answers `200 { "ok": true }`, deliberately, so Telegram stops redelivering a body that will
never be accepted; the failure is logged instead.

The user-facing outcome of a link attempt is delivered **in the chat**, not in this response:
every rejection path (no token, unknown token, expired token, already used) sends a message
back, because a silent failure would leave the user with no way to tell a typo'd link from a
broken integration.

**Errors:**

- `404` (empty body): `TELEGRAM_WEBHOOK_SECRET` is not configured, or the presented secret does
  not match. No error envelope — `res.status(404).end()`.
- `429 RATE_LIMITED`: more than 120 requests/minute from this IP.

---

## Unsubscribe (no login)

Switching a channel off from inside a delivered message. The authenticated way to do this is
`DELETE /integrations/email/:id` and `DELETE /integrations/telegram/:id`, and that remains how a
customer manages alerts; this exists for the person holding an email in a mail client who wants it
to stop now, with no account and no session.

Building it is self-interest rather than courtesy. Without an unsubscribe button an annoyed
recipient presses **spam** instead, and mail providers score a sending domain on how often that
happens — enough of them and every TenderIQ message lands in junk, password resets included. The
unsubscribe link is what protects the password resets.

**The token is derived, not stored.** It is an HMAC over the subscription id, keyed on the app
secret and domain-separated with an `unsubscribe:` prefix so a digest minted here can never be
replayed as an access token or a reset-code digest. There is no `unsubscribe_token` column to
migrate, rotate or leak.

**It only ever switches a channel OFF.** There is no token that turns one on. This link travels
through mail relays, spam filters, corporate archives and forwarded threads, so the worst thing
anyone who finds one can do must be "these alerts stop" — which is the effect the link is for.
Turning a channel back on requires signing in, where the address can be proved again.

Emitted on alert mail as:

```
List-Unsubscribe: <https://api.example.am/api/v1/unsubscribe?token=…>
List-Unsubscribe-Post: List-Unsubscribe=One-Click
```

Both headers or neither. Advertising one-click to a URL that cannot take a POST is worse than
staying silent, because the client shows the button and the recipient presses spam when it fails.
Both are omitted entirely when `API_BASE_URL` is unset — a wrong unsubscribe link is worse than
none, for the same reason.

Telegram alerts carry no link: `/stop` in the chat already does this, in the place the person is
already looking. The endpoint still accepts a Telegram subscription's token, so the mechanism is
one mechanism.

---

## Preview an unsubscribe link

Reports what the token would switch off. **Changes nothing.**

That split is the entire reason `GET` and `POST` differ. Corporate mail security scanners open
every URL in every message before the recipient sees it, so a `GET` that unsubscribed on sight
would silently switch alerts off for exactly the customers whose employers scan hardest — and
they would never learn why the alerts stopped.

**API:**
`GET /api/v1/unsubscribe?token=…`

**Authentication:** none. The token is the authorization, and it names exactly one subscription.

**Query parameters:**

- `token` (required): the opaque token from the message.

**Response data:**

Answers HTML to a browser and JSON to anything that asks for JSON — this is the only endpoint in
the API that does, because it is opened by a human in a browser and there is no frontend to
redirect them to. The HTML is a confirmation page whose button submits the `POST` below.

```json
{
  "data": {
    "channel": "email",
    "address": "a••••@shinarar.am",
    "active": true
  }
}
```

The address is masked: enough to recognise your own, not enough to learn someone else's from a
token found in a forwarded message or a log.

**Errors:**

- `404 NOT_FOUND`: "Unsubscribe link not found." Covers malformed, wrong-signature and
  unknown-subscription alike, deliberately — a caller able to tell those apart is an oracle for
  guessing ids, and the person clicking the link cannot act on the difference.
- `429 RATE_LIMITED`: more than 30 requests/minute from this IP.

---

## Confirm unsubscribe

Revokes the subscription. After this the channel reports `skipped` for that organization until
someone switches it back on from `/integrations`.

**API:**
`POST /api/v1/unsubscribe?token=…`

**Authentication:** none.

**Request data:**

The token is read from the **query string**, not the body. A one-click unsubscribe does not send a
body we could use: Gmail and Yahoo POST `List-Unsubscribe=One-Click` as the entire payload and
expect the URL itself to carry the identity.

**Response data:**

```json
{
  "data": {
    "channel": "email",
    "address": "a••••@shinarar.am",
    "status": "revoked"
  }
}
```

**Idempotent**, and that is a requirement rather than a nicety: a mail client may retry a one-click
unsubscribe, a person may click twice, and an archived message keeps working forever. A second call
reports the same success as the first — an error would tell someone their unsubscribe failed at the
exact moment it had already worked.

**Errors:**

- `404 NOT_FOUND`: as above.
- `429 RATE_LIMITED`: more than 30 requests/minute from this IP.

---

## Backend endpoints not currently used by frontend

**Every endpoint in this document.** This repository is a backend-only Node.js ESM service; the
planned Next.js client (`frontend/`, `ux/` in the reference spec at
`../CRM/gov-tender-monitoring/docs`) has not been started, and no HTTP client code targeting
these routes exists anywhere in the repo.

Cross-checking frontend requests against backend routes was therefore not possible, and no
endpoint could be marked "Backend endpoint not found" — that classification requires a frontend
request to classify.

Two routes are additionally not intended for a frontend at all, regardless of when one is built:

- `GET /api/v1/health` — for uptime probes and monitoring, unauthenticated by design.
- `POST /api/v1/integrations/telegram/webhook` — called by Telegram's servers, authenticated by
  a shared secret header rather than a user session.

---

## Summary table

| Method | Endpoint | Description | Auth Required |
|---|---|---|---|
| GET | `/api/v1/health` | Liveness and ingestion-pipeline health | No |
| POST | `/api/v1/auth/register` | Create a user (no organization), send verification | No |
| POST | `/api/v1/auth/login` | Verify password, mint session | No |
| POST | `/api/v1/auth/refresh` | Rotate refresh token, re-read role and plan | No (refresh token) |
| POST | `/api/v1/auth/logout` | Revoke the refresh token family | No (refresh token) |
| POST | `/api/v1/auth/verify-email` | Confirm address from emailed token | No |
| POST | `/api/v1/auth/verify-email/resend` | Resend confirmation link (neutral response) | No |
| POST | `/api/v1/auth/forgot-password` | Email a six-digit reset code (neutral response) | No |
| POST | `/api/v1/auth/verify-reset-code` | Check a reset code without spending it | No |
| POST | `/api/v1/auth/reset-password` | Spend the code, reset password, revoke all sessions | No |
| POST | `/api/v1/auth/switch-org` | Re-mint against another own membership, new refresh family | Yes |
| GET | `/api/v1/auth/me` | The token's own claims | Yes |
| GET | `/api/v1/tenders` | Filtered, cursor-paginated tender search | Yes (`tender:read`) |
| GET | `/api/v1/tenders/:id` | Tender detail with lots and documents | Yes (`tender:read`) |
| GET | `/api/v1/saved-searches` | List alert profiles | Yes (`tender:read`) |
| POST | `/api/v1/saved-searches` | Create an alert profile | Yes (`savedsearch:write`) |
| PATCH | `/api/v1/saved-searches/:id` | Update an alert profile | Yes (`savedsearch:write`) |
| DELETE | `/api/v1/saved-searches/:id` | Delete an alert profile | Yes (`savedsearch:write`) |
| GET | `/api/v1/tracked-tenders` | List the bid pipeline | Yes (`tender:read`) |
| GET | `/api/v1/tracked-tenders/board` | Per-status counts for the board | Yes (`tender:read`) |
| GET | `/api/v1/tracked-tenders/performance` | Own win/loss record, threshold-gated | Yes (`tender:read`) |
| POST | `/api/v1/tracked-tenders` | Start pursuing a tender (idempotent) | Yes (`trackedtender:write`) |
| GET | `/api/v1/tracked-tenders/:id` | One pursuit with its tender and bid | Yes (`tender:read`) |
| PATCH | `/api/v1/tracked-tenders/:id` | Move through the pipeline / edit decision | Yes (`trackedtender:write`) |
| DELETE | `/api/v1/tracked-tenders/:id` | Untrack (refused once the bid is locked) | Yes (`trackedtender:write`) |
| PUT | `/api/v1/tracked-tenders/:id/bid` | Create or update the draft bid | Yes (`bid:write`) |
| POST | `/api/v1/tracked-tenders/:id/bid/submit` | Lock the bid, advance, try to resolve outcome | Yes (`bid:write`) |
| DELETE | `/api/v1/tracked-tenders/:id/bid` | Discard an unsubmitted draft | Yes (`bid:write`) |
| GET | `/api/v1/tracked-tenders/:id/checklist` | The AI bid checklist and its progress | Yes (`tender:read`) |
| POST | `/api/v1/tracked-tenders/:id/checklist/generate` | Enqueue extraction (202, polled) | Yes (`bid:write`) |
| POST | `/api/v1/tracked-tenders/:id/checklist/items` | Add a manual requirement | Yes (`bid:write`) |
| PATCH | `/api/v1/tracked-tenders/checklist/items/:itemId` | Tick off / edit / clear review flag | Yes (`bid:write`) |
| PATCH | `/api/v1/tracked-tenders/checklist/items/:itemId/document` | Attach or detach a vault document | Yes (`bid:write`) |
| DELETE | `/api/v1/tracked-tenders/checklist/items/:itemId` | Delete a checklist item | Yes (`bid:write`) |
| GET | `/api/v1/fields` | The fixed field list and the CPV prefixes each covers | Yes (orgless allowed) |
| POST | `/api/v1/organizations` | Found an organization as its owner; returns a session for it | Yes |
| GET | `/api/v1/organization` | The session's organization and its fields | Yes (`tender:read`) |
| PATCH | `/api/v1/organization` | Replace the organization's fields | Yes (`org:manage`) |
| GET | `/api/v1/organization/members` | The roster, joined order, cursor-paginated | Yes (`tender:read`) |
| PATCH | `/api/v1/organization/members/:userId` | Change a member's role (rank rule, never owner) | Yes (`user:manage`) |
| DELETE | `/api/v1/organization/members/:userId` | Remove a member; revokes this org's sessions only | Yes (`user:manage`) |
| POST | `/api/v1/organization/leave` | Leave your own membership (never the owner) | Yes |
| POST | `/api/v1/organization/transfer-ownership` | Hand the owner seat to a member; caller becomes admin | Yes (owner) |
| DELETE | `/api/v1/organization` | Delete as sole-member owner, name typed back; vault erased first | Yes (owner) |
| POST | `/api/v1/organization/invitations` | Offer an address a role (neutral response) | Yes (`user:manage`, Pro+) |
| GET | `/api/v1/organization/invitations` | Offers this organization has sent, any status | Yes (`user:manage`) |
| DELETE | `/api/v1/organization/invitations/:id` | Withdraw a pending or declined offer | Yes (`user:manage`) |
| GET | `/api/v1/invitations` | Pending offers addressed to me, any organization | Yes (orgless allowed) |
| POST | `/api/v1/invitations/:id/accept` | Join at the offered role; session only if orgless | Yes (orgless allowed) |
| POST | `/api/v1/invitations/:id/decline` | Refuse an offer; the sender sees it | Yes (orgless allowed) |
| GET | `/api/v1/organization/supplier-identity` | The party this org bids as | Yes (`tender:read`) |
| PUT | `/api/v1/organization/supplier-identity` | Claim or unclaim that party | Yes (`org:manage`) |
| GET | `/api/v1/organization/supplier-identity/candidates` | Search parties for the claim | Yes (`tender:read`) |
| GET | `/api/v1/vault-documents` | List certificates | Yes (`vault:read`) |
| GET | `/api/v1/vault-documents/summary` | Counts per kind, with lapsed counts | Yes (`vault:read`) |
| GET | `/api/v1/vault-documents/options` | Accepted types, size cap, suggested kinds | Yes (`vault:read`) |
| POST | `/api/v1/vault-documents` | Register a document, get a presigned PUT | Yes (`vault:write`) |
| POST | `/api/v1/vault-documents/:id/confirm` | Ask storage whether the bytes arrived | Yes (`vault:write`) |
| GET | `/api/v1/vault-documents/:id` | Document detail | Yes (`vault:read`) |
| GET | `/api/v1/vault-documents/:id/download` | Short-lived presigned download URL | Yes (`vault:read`) |
| PATCH | `/api/v1/vault-documents/:id` | Edit metadata | Yes (`vault:write`) |
| DELETE | `/api/v1/vault-documents/:id` | Delete row and file, detach checklist items | Yes (`vault:write`) |
| GET | `/api/v1/notifications` | The organization's alert feed | Yes (`tender:read`) |
| PATCH | `/api/v1/notifications/:id/read` | Mark one notification read | Yes (`tender:read`) |
| GET | `/api/v1/tenders/:id/benchmark` | Price benchmark panel for one tender | Yes (`intelligence:read` + Pro+) |
| GET | `/api/v1/tenders/:id/competitor-prices` | Full bid ledger: who bid, what they bid, who won | Yes (`intelligence:read` + Pro+) |
| GET | `/api/v1/tenders/:id/price-recommendation` | AI bid range with its evidence | Yes (`intelligence:read` + Pro+) |
| GET | `/api/v1/benchmarks/:cpv` | Benchmark by CPV category | Yes (`intelligence:read` + Pro+) |
| GET | `/api/v1/competition` | Expected bidder count for a category/buyer | Yes (`intelligence:read` + Pro+) |
| GET | `/api/v1/suppliers/:id/profile` | Competitor profile | Yes (`intelligence:read` + Pro+) |
| GET | `/api/v1/buyers/:id/profile` | Buying-agency profile | Yes (`intelligence:read` + Pro+) |
| GET | `/api/v1/integrations/telegram` | Linked Telegram chats | Yes (`tender:read`) |
| POST | `/api/v1/integrations/telegram/link` | Mint a `t.me` deep link token | Yes (`savedsearch:write`) |
| DELETE | `/api/v1/integrations/telegram/:id` | Unlink a chat | Yes (`savedsearch:write`) |
| POST | `/api/v1/integrations/telegram/webhook` | Telegram inbound update | No (secret header) |
| GET | `/api/v1/unsubscribe` | Preview what a message's unsubscribe link would switch off | No (token) |
| POST | `/api/v1/unsubscribe` | Switch that channel off | No (token) |
| GET | `/api/v1/integrations/email` | Addresses receiving alert mail | Yes (`tender:read`) |
| POST | `/api/v1/integrations/email` | Switch email alerts on for your own address | Yes (`savedsearch:write`) |
| DELETE | `/api/v1/integrations/email/:id` | Switch email alerts off | Yes (`savedsearch:write`) |
| POST | `/api/v1/integrations/telegram/:id/enable` | Switch a linked chat back on (own only) | Yes (`savedsearch:write`) |
| POST | `/api/v1/integrations/email/:id/enable` | Switch an address back on (own only) | Yes (`savedsearch:write`) |

**59 endpoints** across 9 route modules.
