/**
 * DIFF FIXTURES — the sample change the renderer is built and proved against.
 *
 * FIXTURE-FIRST ON PURPOSE. The live source of a diff (a session's working
 * copy) is not wired yet, and waiting for it would mean the renderer's first
 * exercise is a payload nobody can reproduce. These are reproducible: the
 * sample carries one modification, one addition, one deletion, one rename and
 * one binary file, because those five are the cases a naive renderer gets
 * wrong and a hand-made "looks about right" sample never contains.
 */

/**
 * A realistic small review diff. Five files, every `git diff` header shape
 * that changes what is SHOWN, and a hunk with no trailing newline.
 */
export const SAMPLE_DIFF = `diff --git a/packages/server/src/facade/handlers/projects.ts b/packages/server/src/facade/handlers/projects.ts
index 1a2b3c4..5d6e7f8 100644
--- a/packages/server/src/facade/handlers/projects.ts
+++ b/packages/server/src/facade/handlers/projects.ts
@@ -12,7 +12,11 @@ import { W2ProjectsAssociationsService } from '../services/w2/projects-associati
 export function projectsGet(deps: FacadeDeps): OperationHandler {
   return new W2ProjectsAssociationsService(deps).getProject;
 }
-
-export function projectsList(deps: FacadeDeps): OperationHandler {
-  return new W2ProjectsAssociationsService(deps).listProjects;
+
+export function projectsBranches(deps: FacadeDeps): OperationHandler {
+  return new W2ProjectsAssociationsService(deps).listBranches;
+}
+
+export function projectsList(deps: FacadeDeps): OperationHandler {
+  return new W2ProjectsAssociationsService(deps).listProjects;
 }
@@ -40,3 +42,4 @@ export function projectsUpdate(deps: FacadeDeps): OperationHandler {
 export function projectsLink(deps: FacadeDeps): OperationHandler {
   return new W2ProjectsAssociationsService(deps).link;
 }
+// branches is a read; it never mutates the working tree.
diff --git a/packages/server/src/git/branch-topology.ts b/packages/server/src/git/branch-topology.ts
new file mode 100644
index 0000000..9abcdef
--- /dev/null
+++ b/packages/server/src/git/branch-topology.ts
@@ -0,0 +1,6 @@
+import { runGit } from '@tm8/execution';
+
+export async function readBranchTopology(cwd: string) {
+  const { stdout } = await runGit(['for-each-ref', '--format=%(refname:short)'], { cwd });
+  return stdout.split('\\n').filter(Boolean);
+}
diff --git a/packages/server/src/git/legacy-branches.ts b/packages/server/src/git/legacy-branches.ts
deleted file mode 100644
index 2468ace..0000000
--- a/packages/server/src/git/legacy-branches.ts
+++ /dev/null
@@ -1,4 +0,0 @@
-import { execSync } from 'node:child_process';
-
-// Shell interpolation on a client-supplied ref. Replaced by argv-only runGit.
-export const branches = (dir: string) => execSync(\`git -C \${dir} branch\`).toString();
diff --git a/docs/git/topology.md b/docs/features/git-topology.md
similarity index 88%
rename from docs/git/topology.md
rename to docs/features/git-topology.md
--- a/docs/git/topology.md
+++ b/docs/features/git-topology.md
@@ -1,3 +1,3 @@
 # Branch topology

-Ahead/behind is measured against the checked-out branch.
+Ahead/behind is measured against the repository's default branch.
\\ No newline at end of file
diff --git a/packages/tm8-ui/public/diff-icon.png b/packages/tm8-ui/public/diff-icon.png
new file mode 100644
index 0000000..1357bdf
Binary files /dev/null and b/packages/tm8-ui/public/diff-icon.png differ
`;

/**
 * A diff big enough that rendering it whole is the defect. Generated rather
 * than stored: a checked-in megabyte of sample text costs every clone forever,
 * and what the cap is tested against is the SHAPE (one file, thousands of
 * rows), not the bytes.
 */
export function makeLargeDiff(lines = 4000, path = 'packages/server/src/generated/big.ts'): string {
  const body: string[] = [];
  for (let i = 0; i < lines; i += 1) body.push(`+export const value${i} = ${i};`);
  return [
    `diff --git a/${path} b/${path}`,
    'new file mode 100644',
    'index 0000000..fedcba9',
    '--- /dev/null',
    `+++ b/${path}`,
    `@@ -0,0 +1,${lines} @@`,
    ...body,
    '',
  ].join('\n');
}
