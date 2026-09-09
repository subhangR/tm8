FROM node:22-bookworm-slim AS build
WORKDIR /build
RUN npm install --ignore-scripts --no-audit --no-fund pg@8.22.0 zod@3.25.76 typescript@5.9.3 @types/node@20.19.43
COPY tsconfig.base.json ./
COPY packages/contract/package.json packages/contract/tsconfig.json ./packages/contract/
COPY packages/contract/src ./packages/contract/src
RUN ./node_modules/.bin/tsc -p packages/contract/tsconfig.json

FROM ubuntu:24.04
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates \
    && rm -rf /var/lib/apt/lists/* \
    && usermod -l tm8 -d /var/lib/tm8 -m -s /usr/sbin/nologin ubuntu \
    && groupmod -n tm8 ubuntu && usermod -G '' -L tm8
COPY --from=build /usr/local/ /usr/local/
WORKDIR /workspace/tm8
COPY --from=build /build/node_modules ./node_modules
COPY --from=build /build/packages/contract/package.json ./node_modules/@tm8/contract/package.json
COPY --from=build /build/packages/contract/dist ./node_modules/@tm8/contract/dist
COPY apps/control-plane ./apps/control-plane
ENV HOME=/var/lib/tm8 TM8_SERVICE_ROLE=control TM8_DISTRIBUTED_SYSTEM_FLAG=true TM8_CONTROL_BIND=0.0.0.0
USER tm8
CMD ["node", "apps/control-plane/src/main.mjs"]
