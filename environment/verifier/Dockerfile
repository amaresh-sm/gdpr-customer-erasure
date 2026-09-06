FROM node:22-bookworm-slim

RUN useradd --create-home verifier
WORKDIR /work
COPY environment/verifier/entrypoint.sh /usr/local/bin/astra-verify
RUN chmod 0555 /usr/local/bin/astra-verify \
    && mkdir -p /input/candidate /input/verifier /output /work/candidate \
    && chown -R verifier:verifier /input /output /work

USER verifier
ENTRYPOINT ["/usr/local/bin/astra-verify"]
