# tm8/rea:6.8.0 — REA (rea-agents) for tm8's RE Lab, run only through rea-sandbox
# under gVisor with no network. The image holds REA, a JDK and small system tools.
# Engines that are large or licensed (Ghidra, Kuna, JADX, apktool, Rizin, WABT,
# Binwalk, Unblob, and the owner's IDA / Hopper / JEB) stay on the root disk under
# /home/tm8/rea-lab/engines and are mounted read-only at /engines (see rea-sandbox.json).
FROM node:24.22.2-trixie-slim@sha256:54f84b4cf8432b21aaffd5d3ce8d41e12cea0d10d33c09d2f3c9879d49d6b446

ARG REA_VERSION=6.8.0
ARG REA_INTEGRITY=sha512-9QDeRnGqEDzABZyr04eLnBXBv/c6I9/TWu/6M0MD4pEfkySI/BIgwTODIbAReX3C1x6hjw9+Jlx4A2yUSPZ9ww==

# procps: JADX needs ps. openjdk-21: Ghidra 12.1.x, JADX, apktool, JEB.
# binutils/gdb/tshark: REA_OBJDUMP_COMMAND, gdb tools, pcap family.
# xvfb + X libs: Hopper's Linux GUI. libfontconfig1/liblzma5/libbz2: Binwalk 3.
# 7zip/lz4/zstd/squashfs-tools/unar: Unblob extractors.
RUN apt-get update \
 && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
      procps ca-certificates file unzip xz-utils \
      openjdk-21-jdk-headless \
      binutils gdb tshark \
      python3 \
      xvfb xauth libx11-6 libxtst6 libfontconfig1 liblzma5 libbz2-1.0 \
      7zip lz4 zstd squashfs-tools unar \
 && rm -rf /var/lib/apt/lists/*

# Install from a tarball whose sha512 matches the pinned registry integrity.
RUN cd /tmp \
 && npm pack "rea-agents@${REA_VERSION}" --json > pack.json \
 && node -e 'const p=require("/tmp/pack.json")[0]; if (p.integrity !== process.env.REA_INTEGRITY) { console.error("rea-agents integrity mismatch: " + p.integrity); process.exit(1); }' \
 && npm install -g "/tmp/rea-agents-${REA_VERSION}.tgz" \
 && rm -f /tmp/*.tgz /tmp/pack.json \
 && npm cache clean --force \
 && mkdir -p /opt/rea \
 && npm ls -g --all --json > /opt/rea/npm-tree.json \
 && echo "rea-agents ${REA_VERSION} ${REA_INTEGRITY}" > /opt/rea/VERSION

# The rest of Unblob's extractors (`unblob --show-external-dependencies`): Debian
# packages, plus sasquatch from onekey-sec's release .deb at its GitHub-attested sha256.
ADD --checksum=sha256:efbc92bd27594e01211e1b582f105a463a0017360a0746a93de3f283906ade95 \
    https://github.com/onekey-sec/sasquatch/releases/download/sasquatch-v4.5.1-6/sasquatch_1.0_amd64.deb \
    /tmp/sasquatch_1.0_amd64.deb
RUN apt-get update \
 && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
      e2fsprogs erofs-utils lziprecover lzop partclone android-sdk-libsparse-utils \
      /tmp/sasquatch_1.0_amd64.deb \
 && rm -rf /var/lib/apt/lists/* /tmp/sasquatch_1.0_amd64.deb

COPY --chmod=0755 bin/ /opt/rea/bin/
ENV JAVA_HOME=/usr/lib/jvm/java-21-openjdk-amd64 \
    PATH=/opt/rea/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin \
    REA_LOG_LEVEL=warn

# Run as the host's tm8 uid/gid so case output stays readable and removable by tm8.
ARG RUN_UID=110
ARG RUN_GID=114
RUN groupadd --gid "${RUN_GID}" rea \
 && useradd --uid "${RUN_UID}" --gid "${RUN_GID}" --home-dir /home/rea --create-home --shell /usr/sbin/nologin rea

USER rea
WORKDIR /case
HEALTHCHECK NONE
ENTRYPOINT ["/opt/rea/bin/rea-entry"]
