# Candidate runtime with a private rootless Docker daemon for PayFlow's public Compose checks.
FROM docker:29-dind-rootless

USER root
RUN apk add --no-cache bash nodejs npm git python3 python3-dev py3-pip ripgrep coreutils build-base \
    && npm install --global --include=optional --no-audit --no-fund @openai/codex@0.144.5 opencode-ai \
    && codex --version \
    && opencode --version

COPY docker/candidate-generation/rootless-dind-entrypoint.sh /usr/local/bin/payflow-rootless-entrypoint
COPY hackerrank-openhands-gateway /opt/hackerrank-openhands-gateway
RUN python3 -m pip install --break-system-packages --no-cache-dir /opt/hackerrank-openhands-gateway \
    && apk del build-base
RUN chmod 0555 /usr/local/bin/payflow-rootless-entrypoint \
    && mkdir -p /workspace/source /home/rootless/.docker/run \
    && chown -R rootless:rootless /workspace /home/rootless/.docker

USER rootless
ENV HOME=/home/rootless \
    XDG_RUNTIME_DIR=/home/rootless/.docker/run \
    DOCKER_HOST=unix:///home/rootless/.docker/run/docker.sock \
    DOCKER_TLS_CERTDIR= \
    npm_config_update_notifier=false \
    npm_config_fund=false \
    npm_config_audit=false
ENTRYPOINT ["/usr/local/bin/payflow-rootless-entrypoint"]
