# SLA Breach Tracking - Decision Notes

**Feature:** Part 2 -- SLA Breach Tracking
**Implemented:** 2026-09-12

## Design Decisions

1. **SLA clock starts at `tickets.created_at`** -- the canonical timestamp of when support
   obligation begins. `updated_at` is ineligible because it mutates on every assignment or comment.

2. **A valid staff response is the first comment by a user with `role IN ('agent', 'admin')`
   belonging to the same organisation as the ticket.** Requester comments do not satisfy SLA.
   Cross-organisation staff comments are also excluded (enforced by `author.org_id = t.org_id`
   inside the CASE expression).

3. **Breach is permanent once the first qualifying response is late.** A late response
   (`first_response_at > sla_deadline`) keeps `sla_breached = true` indefinitely.

4. **Deadline comparison is strict: `NOW() > sla_deadline` (not `>=`).** Handling a ticket
   at exactly T+4h is considered within SLA. MySQL DATETIME has second-level precision;
   the one-second boundary is within acceptable tolerance.

5. **SLA uses continuous elapsed hours.** No business-hour calendar, weekends, or pause/resume
   logic is defined in the specification.

6. **Current priority is used** if priority changes after creation. The schema stores no
   priority history or original deadline. Known limitation: lowering priority after a breach
   may appear to clear the breach.

7. **SLA is computed dynamically.** No sla_breached column is added to the schema;
   no background job or cron task is required. The CTE runs on every list and detail query.

8. **Breach filter (`breached=true`) is applied before LIMIT/OFFSET** inside a CTE,
   ensuring pagination counts only matching tickets.

9. **List and detail use the same SQL expressions** via the shared private `slaFragments()`
   helper in `ticketService.js`.

10. **`dateStrings: true` added to mysql2 pool** -- ensures DATETIME fields (`sla_deadline`,
    `first_response_at`) are returned as strings matching MySQL's stored format rather than as
    JavaScript Date objects shifted by the +05:30 session timezone.

## Deferred Finding (Out of Scope)

**Internal-comment authorization gap:** `comments.js` accepts `isInternal` from any
authenticated user including requesters, with no role check. Pre-existing issue, not
introduced by this feature, not fixed here. Future fix: add role guard in `comments.js`
rejecting `isInternal: true` from requesters with 403 Forbidden.
