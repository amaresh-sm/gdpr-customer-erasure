# GDPR customer erasure publishing hold

- Candidate branch: `question/gdpr-customer-erasure`
- Reference branch: `solution/gdpr-customer-erasure`
- Platform type: `backend`
- Hidden verifier: 8 behavioral scenarios
- Reference qualification: 5/5 deterministic runs, 40/40 scenario checks
- Discriminator: baseline and all three naive mutations fail; reference passes
- Superseded Sol panel: 0/5 full solves; predates the Mailpit topology revision
- Fresh Terra panel: 0/3 full solves; 9/24 aggregate scenario checks
- Directional measured band: `unsolvable`
- Certification status: `provisional` because N=3 is below the required N>=15
- Previous ZIP: stale; do not publish

The fairness audit passed and the candidate specification and verifier are frozen after the Mailpit
revision. Branch and content preflight may proceed, but the packaging skill blocks a publishable ZIP
while calibration is provisional. Twelve additional valid attempts, or an explicit
benchmark-governance exception to the N>=15 gate, is required before rebuilding and certifying the
upload artifact.
