# AI Usage Log

## Tools Used

The following AI tools were used during the assignment:

- **ChatGPT:** Used for discussions, understanding the assignment, researching technical concepts, evaluating security and SQL trade-offs, reviewing findings, considering edge cases, and preparing documentation.
- **Claude 4.6 in Antigravity:** Used for repository analysis, implementation planning, audit planning, and breaking larger tasks into smaller implementation steps.
- **Gemini 3.7 Flash:** Used for code generation, code writing, implementation assistance, and making selected code/documentation edits.

AI tools were used as development assistants rather than as a replacement for review or decision-making. I reviewed the generated suggestions, adapted them to the existing architecture, and verified important behavior against the source code and running application.

## Main Areas Where AI Assisted

AI assistance was used for:

- Understanding the existing frontend, backend, and database architecture.
- Reviewing authentication, authorization, and organization-isolation behavior.
- Identifying and prioritizing code-review findings.
- Planning the SLA breach-tracking implementation.
- Researching SQL approaches involving CTEs, calculated fields, filtering, and pagination.
- Considering SLA edge cases such as first-response semantics, requester comments, cross-organization comments, deadlines, timezones, and late responses.
- Generating implementation code and verification commands.
- Preparing audit findings, SLA decision notes, and submission documentation.

## Incorrect or Misleading Suggestions Identified

One initial concern was that returning `204 No Content` from the DELETE endpoint might be incorrect because the response did not contain a JSON body. After checking the HTTP semantics and the actual frontend behavior, I determined that this was not a valid finding. A successful DELETE operation can correctly return `204 No Content` when no response body is required, so it was excluded from the final audit.

Another important distinction was identified during the review of the invite-acceptance endpoint. Password hashing improves password storage security, but it does not authorize an unauthenticated caller to change an arbitrary user's password. This distinction was verified by reviewing the endpoint's user-ID handling and was documented as a remaining authorization concern rather than being incorrectly marked as fully fixed.

During the SLA work, SQL and timezone assumptions were also checked against the actual MySQL configuration and API responses rather than being accepted solely from AI suggestions.

## Verification and Responsibility

I manually reviewed the relevant source code, compared proposed behavior with the assignment requirements, ran the application and database reset process, tested API responses, checked SLA filtering and pagination behavior, and reviewed the resulting changes for regressions.

The final implementation, prioritization, testing, and submission decisions remain my responsibility.