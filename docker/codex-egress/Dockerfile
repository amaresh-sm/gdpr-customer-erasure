FROM node:22-bookworm-slim@sha256:d649c27dae7ba0137b3cef5dd75baa422c08dc3d9e3fc0c23dfb172dc3cc6436

RUN groupadd --gid 65532 benchmark \
    && useradd --uid 65532 --gid 65532 --no-create-home --shell /usr/sbin/nologin benchmark

COPY docker/codex-egress/egress-proxy.mjs /usr/local/lib/egress-proxy.mjs
RUN chmod 0555 /usr/local/lib/egress-proxy.mjs

USER 65532:65532
ENV HOME=/tmp
ENTRYPOINT ["node", "/usr/local/lib/egress-proxy.mjs"]
