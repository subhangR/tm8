# slack-runtime: the tm8 Slack connector runtime (Socket Mode). Pure JS (ws + tsx), nothing native to build.
# State lives in mounted volumes:
#   /app/state    TM8_SLACK_STATE_DIR: each connection's sealed tokens. Persistent volume; back it up (SETUP.md).
#   /app/secrets  the DIRECTORY holding the bridge_runtime bearer the tm8 node writes (TM8_SLACK_RUNTIME_TOKEN_FILE on
#                 the node, <dir>/runtime.token), ro. Mount the directory, never the file: each mint writes a new file
#                 and renames it into place, and a single-file bind mount keeps the old, revoked one.
# Network: outbound HTTPS to slack.com / *.slack.com and WSS to wss-*.slack.com, plus the tm8 server. Nothing inbound.
# Behind a proxy: -e TM8_SLACK_PROXY_URL=http://proxy:3128 (or HTTPS_PROXY / NO_PROXY); SETUP.md › Behind a proxy.
#
#   docker build -t tm8-slack-runtime integrations/slack-bridge
#   docker run -d --name slack-runtime --restart unless-stopped --user "$(id -u):$(id -g)" \
#     -e TM8_SERVER_URL=http://host.docker.internal:7778 --add-host host.docker.internal:host-gateway \
#     -v "$HOME/.tm8-dev/data/bridges/slack-runtime-secrets:/app/secrets:ro" \
#     -v tm8-slack-state:/app/state tm8-slack-runtime
FROM node:22-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund && npm cache clean --force

FROM node:22-slim
ENV NODE_ENV=production \
    TM8_SLACK_STATE_DIR=/app/state \
    TM8_BRIDGE_RUNTIME_TOKEN_FILE=/app/secrets/runtime.token
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY package.json tsconfig.json ./
COPY src ./src
RUN mkdir -p /app/state /app/secrets && chmod 1777 /app/state
# Run as the host user that owns the token file (docker run --user "$(id -u):$(id -g)"); the image default is node.
ARG APP_USER=node
USER ${APP_USER}
VOLUME ["/app/state"]
CMD ["node", "--import", "tsx", "src/runtime-main.ts"]
