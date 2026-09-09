# Preserve existing accounts and project files

This is an operator tool, separate from the web app. It needs a privileged graph
database connection, read-only access to the old project directories, a writable
backup directory and Docker administration on the workspace machine. Do not give
those privileges to the tm8 service or user containers.

Build `tm8-ubuntu24:dev`, `tm8-control:ubuntu24` and the runner image first, then:

```bash
docker build -f deploy/docker/migration.Dockerfile -t tm8-migration:ubuntu24 .
```

Run the migration image with `TM8_MIGRATION_DATABASE_URL` in a private env file,
the appropriate PostgreSQL network, the Docker socket, original source paths
mounted read-only at their recorded paths and a writable `/migration` mount.
Choose mounts from the inventory; never mount a whole home just to guess a path.

1. Run `inventory --out /migration/inventory.json`. It records account/identity
   IDs, project IDs, space links, candidate owners and source Git state. It
   excludes password hashes and sessions. Missing or nested repository paths
   require review.
2. Create an explicit manifest. Every selected owner must already be a member
   of the chosen space. No account or graph ID is recreated:

   ```json
   {
     "machineId": "EXISTING_MACHINE_UUID",
     "projects": [{
       "projectId": "EXISTING_PROJECT_UUID",
       "ownerAccountId": "EXISTING_ACCOUNT_UUID",
       "homeSpaceId": "EXISTING_SPACE_UUID",
       "sourcePath": "/old/project/path"
     }]
   }
   ```

3. Stop tm8 and all user/agent activity that can modify the selected projects.
   Keep PostgreSQL and workspace egress available. Run
   `migrate --manifest /migration/manifest.json --out /migration/backups --quiesced`.
   The command takes a database backup, copies without following symlinks,
   verifies working files and Git state, provisions the private home and publishes
   committed history to the shared Git store. Only then does it update the old
   project row's path. Other members get private checkouts of the shared commits.
4. Restart tm8 and verify each project with its owner. Keep original directories,
   exported copies, database dumps and migration ledger until cutover is accepted.

The ledger makes a successful rerun a no-op and retains failed copies for review.
Changed source files or changed ownership after an interrupted copy cause a
refusal. A linked worktree becomes a self-contained repository. Staged changes,
unstaged edits, untracked files and the current Git history are preserved. No
source files are deleted. Rollback requires restoring the pre-cutover graph dump
with the matching old deployment and original directories; stop current activity
first and retain new workspace volumes so post-cutover edits are not lost.

## Move the directory to Supabase

Register the machine with its **existing machine ID** (the optional `machineId`
field of `POST /api/machines`) and enough capacity for all existing active users.
Run `export-directory --out /migration/directory.json` against the graph and
review each email. Missing email mappings stop the export; do not guess them.
The export preserves account IDs, identity IDs and any existing workspace IDs.

Mount the reviewed file read-only into the control app's operator command and run
`node apps/control-plane/src/import.mjs /migration/directory.json`. This imports
invited accounts and reserves their existing machine assignments atomically.
Conflicting email/identity mappings fail instead of merging accounts. Repeating
the same manifest does not allocate more capacity.

Issue invitations from the control app. Users authenticate with GitHub, whose
verified email must match the invitation; existing local password hashes are
never sent to Supabase. Existing graph IDs and memberships remain on
the node. Switch the node to distributed mode only after the directory and local
workspace copies are ready. Keep local passwords and originals for rollback.

## Link an existing account to GitHub

Password sign-in and signup are disabled. A user with an existing live session
can explicitly link GitHub in the workspace UI. If no session remains, an operator
must verify the account-to-GitHub mapping and use the numeric GitHub user ID:

```bash
# TM8_MIGRATION_DATABASE_URL comes from a private operator env file.
node deploy/workspaces/link-github.mjs local ACCOUNT_UUID GITHUB_NUMERIC_ID
# Use `control` instead of `local` for an existing control-directory account.
```

The tool preserves account/workspace IDs, refuses conflicting bindings, and never
mints a session. The user must then sign in through GitHub. Usernames or matching
emails alone do not authorize this mapping.
