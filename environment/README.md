# Candidate Generation and Verification

The candidate and verifier stages use separate images and separate mounts.

## Candidate generation

Build both isolated images from the repository root with:

```bash
npm run build:images
```

Use `--candidate-tag` and `--verifier-tag` after the command when a task needs its own image tags.

Mount only the prepared candidate workspace:
```text
/workspace/            (writable candidate workspace)
```

The runner starts a long-lived generation container, copies only the candidate-facing instruction
and public files into `/workspace`, then executes the provider CLI with `docker exec`. Logs and
metadata stay in the host run directory. The image must not receive `verifier/`, hidden tests,
mutants, calibration data, or scoring rules.

For a Codex login, pass the host credentials explicitly with `--auth-file` and, when the session
uses managed policies, its matching `--cloud-config-file`. The image installs the Debian system CA
bundle so Codex can establish TLS connections. If a local network adds its own trusted root, pass
that PEM with `--ca-cert`; never copy a private key or the whole host credential directory.

## Verification

Mount:

```text
/input/candidate/      (read-only candidate output)
/input/verifier/       (read-only private tests and reference material)
/output/               (writable reports only)
```

The verifier copies the candidate into its private work directory, runs `VERIFIER_COMMAND`, and
exports reports without exposing private verifier files to the candidate process. Task authors can
extend either Dockerfile for language runtimes, databases, browsers, or service dependencies.

The runner must keep the hidden directory and all verifier data out of any candidate application
subprocess or child container. The verifier image owns the private mount; the candidate runtime
receives only the candidate workspace.

The verifier still receives separate read-only candidate and private-verifier mounts and writes
reports to the host run directory. Both stages use non-root users and remove their containers
after each run. A production runner should additionally apply CPU/memory limits, a temporary
filesystem, and an explicit network policy.
