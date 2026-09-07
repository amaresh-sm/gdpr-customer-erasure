FROM python:3.12-slim-bookworm AS python-runtime

FROM node:22-bookworm-slim

ARG CODEX_VERSION=0.144.6
ARG CLAUDE_CODE_VERSION=latest

# Codex uses the operating system trust store for its Rust HTTP client. The
# slim Node image includes Node's bundled roots but not the system CA bundle,
# which causes TLS failures against the provider endpoint.
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates curl build-essential git python3 python3-pip tmux \
    && rm -rf /var/lib/apt/lists/*

# The OpenHands SDK requires Python 3.12; Node remains the primary runtime for
# candidate repositories and their TypeScript build/test tooling.
COPY --from=python-runtime /usr/local/bin/python3.12 /usr/local/bin/python3.12
COPY --from=python-runtime /usr/local/bin/pip3.12 /usr/local/bin/pip3.12
COPY --from=python-runtime /usr/local/lib/python3.12 /usr/local/lib/python3.12
COPY --from=python-runtime /usr/local/lib/libpython3.12.so.1.0 /usr/local/lib/libpython3.12.so.1.0
RUN ln -sf /usr/local/bin/python3.12 /usr/local/bin/python3 \
    && ln -sf /usr/local/bin/pip3.12 /usr/local/bin/pip3 \
    && ldconfig

RUN npm install --global --ignore-scripts --no-audit --no-fund "@openai/codex@${CODEX_VERSION}" \
    && codex --version

# Install Claude Code with lifecycle scripts enabled.  The package downloads
# its platform-native executable during postinstall; using --ignore-scripts
# here would leave the `claude` command absent inside the isolated container.
RUN npm install --global --no-audit --no-fund "@anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}" \
    && claude --version

ARG OPENHANDS_VERSION=1.44.1
RUN python3.12 -m pip install --no-cache-dir \
      "openhands-sdk==${OPENHANDS_VERSION}" \
      "openhands-tools==${OPENHANDS_VERSION}"

RUN useradd --create-home runner
WORKDIR /work
COPY environment/candidate-generation/entrypoint.sh /usr/local/bin/astra-generate
COPY astra_harness/openhands_runner.py /opt/astra/openhands_runner.py
RUN chmod 0555 /usr/local/bin/astra-generate \
    && mkdir -p /input /output /work/candidate \
    && chown -R runner:runner /input /output /work

USER runner
ENTRYPOINT ["/usr/local/bin/astra-generate"]
