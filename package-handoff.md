# GDPR customer erasure package handoff

- Candidate branch: `question/gdpr-customer-erasure`
- Reference branch: `solution/gdpr-customer-erasure`
- Platform type: `backend`
- Hidden verifier: 8 behavioral scenarios
- Reference qualification: 5/5 deterministic runs, 40/40 scenario checks
- Discriminator: baseline and all three naive mutations fail; reference passes
- Calibration panel: `gpt-5.6-sol` and `gpt-5.6-terra`, medium reasoning, 15 valid attempts each
- Measured band: `unsolvable` (0/15 full passes for each model), accepted reclassification from `hard`
- Upload artifact: `gdpr-customer-erasure.zip`

The ZIP includes `hidden_tests/`, `reference_solution/`, `DESIGN.md`, and `.gitattributes` for
platform scoring. Git `export-ignore` removes the private authoring and grading surfaces from the
provisioned solver workspace.
