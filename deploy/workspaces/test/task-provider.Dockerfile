FROM tm8-workspace:ubuntu24
USER root
RUN rm /usr/local/bin/claude /usr/local/bin/codex
COPY --chmod=755 deploy/workspaces/test/task-provider.mjs /opt/tm8/task-provider.mjs
RUN ln -s /opt/tm8/task-provider.mjs /usr/local/bin/claude && ln -s /opt/tm8/task-provider.mjs /usr/local/bin/codex
USER user
