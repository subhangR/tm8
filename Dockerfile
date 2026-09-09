# syntax=docker/dockerfile:1
ARG NODE_VERSION=22
ARG BUN_VERSION=1.2.23
FROM node:${NODE_VERSION}-bookworm-slim AS node
FROM oven/bun:${BUN_VERSION} AS bun

FROM ubuntu:24.04

ENV LANG=C.UTF-8 \
    LC_ALL=C.UTF-8 \
    PATH=/workspace/tm8/node_modules/.bin:/usr/lib/postgresql/16/bin:/usr/local/bin:/usr/local/sbin:/usr/sbin:/usr/bin:/sbin:/bin

RUN apt-get update \
    && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
       bash build-essential ca-certificates curl git openssh-client \
       postgresql-16 postgresql-client-16 procps python3 ripgrep socat unzip \
    && rm -rf /var/lib/apt/lists/*

COPY --from=node /usr/local/ /usr/local/
COPY --from=bun /usr/local/bin/bun /usr/local/bin/bun
ENV npm_config_nodedir=/usr/local
RUN ln -s /usr/local/bin/bun /usr/local/bin/bunx \
    && npm install --global node-gyp@11.5.0 \
    && node --version && bun --version

# Keep uid 1000 for existing volume ownership, with a dedicated locked service
# account and service state separate from the mounted application source.
RUN usermod -l tm8 -d /var/lib/tm8 -m -s /usr/sbin/nologin ubuntu \
    && groupmod -n tm8 ubuntu && usermod -L tm8 \
    && mkdir -p /workspace/tm8/node_modules /var/lib/tm8/.tm8-dev \
    && for package in cli contract execution mcp prompt pty-protocol server tm8-ui tm8_ui_2.0 ui; do \
         mkdir -p "/workspace/tm8/packages/$package/node_modules"; \
       done \
    && mkdir -p /workspace/tm8/tools/conformance/node_modules \
    && mkdir -p /workspace/tm8/apps/control-plane/node_modules /workspace/tm8/apps/workspace-broker/node_modules \
    && usermod -G '' tm8 \
    && chown -R tm8:tm8 /workspace /var/lib/tm8

ENV HOME=/var/lib/tm8
USER tm8
WORKDIR /workspace/tm8

# The application itself is bind-mounted by Compose, including its launcher.
EXPOSE 14610 14611
ENTRYPOINT ["bash", "deploy/docker/entrypoint.sh"]
CMD ["dev"]
