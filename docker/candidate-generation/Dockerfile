FROM node:22-bookworm-slim@sha256:d649c27dae7ba0137b3cef5dd75baa422c08dc3d9e3fc0c23dfb172dc3cc6436

RUN apt-get update \
    && apt-get install --yes --no-install-recommends ca-certificates git python3 ripgrep \
    && rm -rf /var/lib/apt/lists/*

ARG CODEX_VERSION=0.144.5
RUN npm install --global --include=optional --no-audit --no-fund "@openai/codex@${CODEX_VERSION}" \
    && codex --version \
    && npm cache clean --force

WORKDIR /opt/payflow-baseline
COPY codebase/package.json codebase/package-lock.json ./
RUN npm ci --ignore-scripts \
    && mv node_modules /opt/payflow-node_modules \
    && chmod -R a+rX /opt/payflow-node_modules

COPY docker/candidate-generation/entrypoint.sh /opt/benchmark-entrypoint.sh
RUN chmod 0555 /opt/benchmark-entrypoint.sh

ENV HOME=/tmp \
    CODEX_HOME=/codex-home \
    PYTHONDONTWRITEBYTECODE=1 \
    npm_config_update_notifier=false \
    npm_config_fund=false \
    npm_config_audit=false
WORKDIR /workspace/source
ENTRYPOINT ["/opt/benchmark-entrypoint.sh"]
