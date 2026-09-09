FROM node:22-bookworm-slim
RUN groupadd -g 1000 tm8-broker-access || true
WORKDIR /opt/tm8
COPY apps/workspace-broker/package.json ./package.json
RUN npm install --omit=dev --ignore-scripts
COPY apps/workspace-broker/src ./src
CMD ["node", "src/main.mjs"]
