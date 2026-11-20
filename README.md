# mdfit-backend

The MD Fit API (Express, Node 22, JSON file store on Railway). Tests: `node --test`.

## ** DO NOT TOUCH after compliancy is set **

MD Fit is a live patient EMR under HIPAA (45 CFR Parts 160 and 164) and Florida law. Once the Compliance checklist
(`GET /api/admin/compliance/checklist`, shown in the workspace) reports the safeguards as met, the parts below are
locked. Do not change, refactor, "tidy" or remove them, and do not weaken what they do, unless the practice owner asks
for that exact change in writing in the session. A bug fix elsewhere is never a reason to touch them.

| Locked part | Where | Rule it serves |
|---|---|---|
| Staff sign-in, lockout, two-step sign-in | `server.js` (`/api/admin/login`, `requireAdmin`), `lib/auth.js` | §164.312(d) |
| Server-side sessions: idle logoff and sign-out | `server.js` (staff sessions), `POST /api/admin/logout` | §164.312(a)(2)(iii) |
| Roles and permissions; unmapped routes are owner-only | `lib/staff.js` (`ROUTE_PERMISSIONS`, `ROLES`, `PHI_PERMISSIONS`) | §164.312(a)(1), §164.502(b) |
| Audit ledger: append-only, hash chain, signatures | `lib/audit.js`, the audit middleware in `server.js` | §164.312(b), §164.312(c) |
| Encryption at rest, whole-file and field-level | `lib/store.js`, `lib/phi.js`, `lib/messages.js` (cipher) | §164.312(a)(2)(iv) |
| Security headers, no-store on patient data | `lib/security.js` | §164.312(e) |
| The chart (EMR) and clinical notes | `lib/emr.js`, `lib/notes.js`, `lib/intake.js` | Part 164 Subpart E |
| Patient rights: copy of record, corrections, disclosure accounting, contact restrictions, privacy notice | `lib/hipaa.js` | §164.520–528 |
| Incident and breach log with deadlines | `lib/hipaa.js` | §164.400–414, Fla. §501.171 |
| Compliance registers, audit review, checklist | `lib/compliance.js` | §164.308, §164.310, §164.316 |
| Weekly encrypted backup | `lib/backup.js` | §164.308(a)(7) |
| Business-associate allowlist for AI services | `lib/baa.js` | §164.504(e) |
| SimplePractice import (owner only, undoable, records keep their source) | `lib/sp-import.js`, import helpers in `lib/emr.js` | §164.312(b), record retention |
| Client trash keeps the chart | `lib/clients.js` (`finalize`, `clinicalFootprint`) | Record retention |
| Agreement locks: revenue share and commission settings | `lib/partner-share.js`, `lib/affiliates.js` | Agreement Rev. 2 |

Also locked: the tests that prove these (`test/compliance.test.js`, `test/hipaa.test.js`, `test/staff*.test.js`,
`test/audit*.test.js`, `test/client-trash.test.js`, `test/partner-share.test.js`). Never delete, skip or loosen one to
get a change through.

If a change to a locked part is asked for: say which safeguard it affects and which rule it serves, make the smallest
change, run `node --test`, and re-check the checklist afterwards. Never print, copy or log a key or any patient data.
