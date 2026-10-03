# tm8 website

The public site at https://tm8-site.web.app (Firebase Hosting site `tm8-site`).

- `index.template.html` is the source; `index.html` is generated from it by the build in the
  deliverable (`tools/build.cjs`), which injects the icon set, expands the recording placeholders,
  content-hashes `styles.css`, `app.js`, `mesh.js` and `sessions.js`, and writes the single-file
  review copy. Edit the template, never `index.html`.
- `firebase.json` and `.firebaserc` deploy this folder (`public: "."`); the database rules for the
  sign-up and demo-request instance are beside them. Deploys run from the deliverable with
  `tools/deploy.sh`, which needs the project's service-account key outside the repository.
- `scripts/validate-website.mjs` at the repository root checks the built site.
- The design record (decisions, evidence, the three-actor protocol) is `HANDOFF.md` in the
  deliverable `/home/tm8/prod-workspace/deliverables/tm8-website-v2` on the production node.
