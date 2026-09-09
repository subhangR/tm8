# syntax=docker/dockerfile:1
FROM node:22-bookworm-slim AS node
FROM oven/bun:1.2.23 AS bun
FROM ubuntu:24.04
RUN apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
    bash git curl ca-certificates openssh-client python3 build-essential procps \
    && rm -rf /var/lib/apt/lists/* \
    && usermod -l user -d /home/user -m ubuntu && groupmod -n user ubuntu && usermod -G '' -L user \
    && mkdir -p /home/user/projects /repos /opt/tm8 \
    && chown -R user:user /home/user /repos
COPY --from=node /usr/local/ /usr/local/
COPY --from=bun /usr/local/bin/bun /usr/local/bin/bun
ARG CLAUDE_CODE_VERSION=2.1.266
ARG CODEX_VERSION=0.153.4
RUN npm install -g @anthropic-ai/claude-code@${CLAUDE_CODE_VERSION} @openai/codex@${CODEX_VERSION} \
    && npm cache clean --force
COPY apps/workspace-broker/runner/runner.mjs /opt/tm8/runner.mjs
COPY apps/workspace-broker/runner/git-credential.mjs /opt/tm8/git-credential.mjs
COPY apps/workspace-broker/runner/providers.mjs /opt/tm8/providers.mjs
COPY apps/workspace-broker/runner/provider-login.mjs /opt/tm8/provider-login.mjs
COPY apps/workspace-broker/runner/execution.mjs /opt/tm8/execution.mjs
COPY apps/workspace-broker/runner/execution-run.mjs /opt/tm8/execution-run.mjs
ENV HOME=/home/user LANG=C.UTF-8 LC_ALL=C.UTF-8
USER user
WORKDIR /home/user
CMD ["sleep", "infinity"]
