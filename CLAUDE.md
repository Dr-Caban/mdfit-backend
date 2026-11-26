# mdfit-backend — notes for Claude sessions

- The working notes for both repositories are in `mdfit-frontend/CLAUDE.md`. Read that first.
- **DO NOT TOUCH after compliancy is set:** read the section of that name in `README.md` here before editing anything
  near sign-in, sessions, roles, the audit ledger, encryption, the chart, patient-rights records or the agreement locks.
- **Every change is monitored:** see "Every change is monitored" in `README.md` and `docs/MONITORING.md` in
  `mdfit-frontend`. Before finishing a session that shipped a change, confirm the scheduled task
  "MD Fit endpoint failure review" exists and is enabled.
- Railway does not deploy on push: after a backend merge, reconnect the service source to `main`.
- Tests: `node --test`. Never skip or loosen a test to get a change through.
