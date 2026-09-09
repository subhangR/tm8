FROM tm8-control:ubuntu24 AS dependencies
FROM tm8-ubuntu24:dev
USER root
COPY --from=dependencies /workspace/tm8/node_modules /workspace/tm8/node_modules
COPY deploy/workspaces /workspace/tm8/deploy/workspaces
COPY apps/workspace-broker/src /workspace/tm8/apps/workspace-broker/src
WORKDIR /workspace/tm8
ENTRYPOINT ["node", "deploy/workspaces/migrate.mjs"]
