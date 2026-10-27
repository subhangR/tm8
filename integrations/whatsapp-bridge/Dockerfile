# wa-bridge: Baileys + better-sqlite3 (native, built here) + tsx, plus whisper.cpp and ffmpeg for local voice-note
# transcription. State lives in mounted volumes:
#   /app/auth (linked device), /app/data (SQLite, media, data/models), /app/secrets (tm8 token), /app/config.json (ro).
FROM node:22-slim AS deps
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ ca-certificates git \
  && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund && npm cache clean --force

# whisper.cpp CLI, statically linked against ggml. CPU only; AVX2/FMA/F16C (this host's EPYC), no -march=native so the
# image doesn't depend on the build machine beyond that.
FROM debian:bookworm-slim AS whisper
ARG WHISPER_CPP_VERSION=v1.9.5
RUN apt-get update && apt-get install -y --no-install-recommends cmake make g++ git ca-certificates \
  && rm -rf /var/lib/apt/lists/*
RUN git clone --depth 1 --branch "$WHISPER_CPP_VERSION" https://github.com/ggml-org/whisper.cpp /src
WORKDIR /src
RUN cmake -B build -DCMAKE_BUILD_TYPE=Release -DBUILD_SHARED_LIBS=OFF -DWHISPER_BUILD_TESTS=OFF -DWHISPER_BUILD_SERVER=OFF \
    -DGGML_NATIVE=OFF -DGGML_AVX=ON -DGGML_AVX2=ON -DGGML_FMA=ON -DGGML_F16C=ON -DGGML_OPENMP=OFF \
  && cmake --build build -j"$(nproc)" --target whisper-cli \
  && cp build/bin/whisper-cli /usr/local/bin/whisper-cli

FROM node:22-slim
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg && rm -rf /var/lib/apt/lists/*
COPY --from=whisper /usr/local/bin/whisper-cli /usr/local/bin/whisper-cli
ENV NODE_ENV=production WA_BRIDGE_ROOT=/app
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY package.json tsconfig.json ./
COPY src ./src
# The image runs as tm8 (uid 110) so files in the mounted volumes stay owned by tm8 on the host.
USER 110:114
HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=3 \
  CMD node -e "fetch(process.env.HEALTH_URL||'http://127.0.0.1:8787/health').then(r=>r.json()).then(j=>process.exit(j.wa.connected?0:1)).catch(()=>process.exit(1))"
CMD ["node", "--import", "tsx", "src/main.ts"]
