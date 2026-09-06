FROM node:22-bookworm-slim

ARG CODEX_VERSION=0.144.6
ARG CLAUDE_CODE_VERSION=latest

# Codex uses the operating system trust store for its Rust HTTP client. The
# slim Node image includes Node's bundled roots but not the system CA bundle,
# which causes TLS failures against the provider endpoint.
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates \
    && rm -rf /var/lib/apt/lists/*

RUN npm install --global --ignore-scripts --no-audit --no-fund "@openai/codex@${CODEX_VERSION}" \
    && codex --version

# Install Claude Code with lifecycle scripts enabled.  The package downloads
# its platform-native executable during postinstall; using --ignore-scripts
# here would leave the `claude` command absent inside the isolated container.
RUN npm install --global --no-audit --no-fund "@anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}" \
    && claude --version

RUN useradd --create-home runner
WORKDIR /work
COPY environment/candidate-generation/entrypoint.sh /usr/local/bin/astra-generate
RUN chmod 0555 /usr/local/bin/astra-generate \
    && mkdir -p /input /output /work/candidate \
    && chown -R runner:runner /input /output /work

USER runner
ENTRYPOINT ["/usr/local/bin/astra-generate"]
