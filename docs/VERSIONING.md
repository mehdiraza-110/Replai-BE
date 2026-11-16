# Release versioning

Each repo (Replai-BE, Replai-FE) has a plain-text `VERSION` file at its root: `MAJOR.MINOR.PATCH.BUILD`, starting at `1.0.0.0`.
**Every deployment bumps the last part.** A bigger change bumps an earlier part by hand. `package.json` keeps its own
3-part npm version; `VERSION` is the source of truth. BE and FE are versioned independently.

## Releasing

1. In each repo being deployed: `npm run version:bump` (or `npm run version:bump -- 1.1.0.0` for an explicit version).
2. FE only: if the release has changes people can see, add an entry to `RELEASE_NOTES` in `src/sv/feedback/whatsNew.ts`
   whose `version` equals the new FE `VERSION`. The newest entry should always match.
3. Commit `VERSION` as `Release vX.Y.Z.W`, `git tag vX.Y.Z.W`, push the branch and the tag.
4. Deploy the normal way. Verify: BE `GET /api/v1/health` returns `version`; FE shows `vX.Y.Z.W` at the bottom of the sidebar.

## Where the version shows up

- BE: `config/version.js` reads `VERSION`; `/api/v1/health` returns it. `VERSION` must be part of the deployed files (the
  deploy is a `git reset --hard`, and the file is tracked, so it ships).
- FE: `vite.config.ts` injects it as `__APP_VERSION__` at build time. The sidebar label opens the What's new dialog, which
  also opens by itself once per new version (`localStorage['whats-new-seen-version']`).
