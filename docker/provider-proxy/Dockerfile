FROM node:22-bookworm-slim@sha256:d649c27dae7ba0137b3cef5dd75baa422c08dc3d9e3fc0c23dfb172dc3cc6436

ARG CODEX_VERSION=0.144.5
RUN apt-get update \
    && apt-get install --yes --no-install-recommends ca-certificates socat \
    && rm -rf /var/lib/apt/lists/* \
    && npm install --global --include=optional --no-audit --no-fund "@openai/codex-responses-api-proxy@${CODEX_VERSION}" \
    && codex-responses-api-proxy --help >/dev/null \
    && npm cache clean --force \
    && groupadd --gid 65532 benchmark \
    && useradd --uid 65532 --gid 65532 --no-create-home --shell /usr/sbin/nologin benchmark

COPY docker/provider-proxy/proxy-supervisor.mjs /usr/local/lib/proxy-supervisor.mjs
COPY docker/provider-proxy/portkey-adapter.mjs /usr/local/lib/portkey-adapter.mjs
RUN chmod 0555 /usr/local/lib/proxy-supervisor.mjs /usr/local/lib/portkey-adapter.mjs

USER 65532:65532
ENV HOME=/tmp
ENTRYPOINT ["node", "/usr/local/lib/proxy-supervisor.mjs"]
