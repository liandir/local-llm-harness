# The release build must supply an immutable, audited runtime image reference,
# for example `--build-arg VERIFIED_RUNTIME_IMAGE=registry/runtime@sha256:...`.
# There is deliberately no mutable default. Runtime command execution never
# invokes this Dockerfile, a pull, or a build.
ARG VERIFIED_RUNTIME_IMAGE
FROM ${VERIFIED_RUNTIME_IMAGE}
ARG VERIFIED_RUNTIME_IMAGE

# The verified runtime must provide /usr/local/bin/node plus the explicitly
# allow-listed command binaries, must have no declared volumes/ports/healthcheck,
# and must not contribute additional ENV keys. Preflight rejects the resulting
# image if any of those immutable-image assumptions are false.
USER 0:0
COPY --chown=65532:65532 supervisor.mjs /opt/local-llm-harness/supervisor.mjs
RUN /usr/local/bin/node -e 'if (!/^[a-z0-9][a-z0-9._/:+-]*@sha256:[0-9a-f]{64}$/.test(process.argv[1])) process.exit(1)' "${VERIFIED_RUNTIME_IMAGE}" \
    && chmod 0555 /opt/local-llm-harness/supervisor.mjs \
    && test -x /usr/local/bin/node

ENV PATH=/usr/bin:/bin \
    HOME=/tmp/home \
    XDG_CONFIG_HOME=/tmp/xdg \
    TMPDIR=/tmp \
    LANG=C \
    LC_ALL=C \
    GIT_CONFIG_NOSYSTEM=1 \
    GIT_CONFIG_GLOBAL=/dev/null \
    GIT_CONFIG_SYSTEM=/dev/null \
    GIT_ATTR_NOSYSTEM=1 \
    GIT_TERMINAL_PROMPT=0 \
    GIT_ASKPASS=/bin/false \
    SSH_ASKPASS=/bin/false \
    GIT_PAGER=cat \
    PAGER=cat \
    GIT_OPTIONAL_LOCKS=0 \
    GIT_NO_REPLACE_OBJECTS=1 \
    GIT_NO_LAZY_FETCH=1 \
    GIT_LITERAL_PATHSPECS=1 \
    GIT_CEILING_DIRECTORIES=/workspace \
    GIT_EDITOR=/bin/false \
    GIT_SEQUENCE_EDITOR=/bin/false \
    GIT_SSH_COMMAND=/bin/false \
    GIT_PROXY_COMMAND=/bin/false \
    NO_COLOR=1

LABEL local-llm-harness.supervisor-profile="1" \
      local-llm-harness.supervisor-sha256="e00022844d0571c1cd0bd3d321b9a107ce1aad3fbbf53ee9732aac31605ac074"
USER 65532:65532
WORKDIR /workspace
ENTRYPOINT ["/usr/local/bin/node"]
CMD ["/opt/local-llm-harness/supervisor.mjs"]
