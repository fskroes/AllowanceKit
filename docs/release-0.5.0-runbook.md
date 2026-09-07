# Release runbook — allowance-kit + wallie 0.5.0 (R-06)

The gate is met: every `R`, `M`, `L`, and `C-05` ticket R-06 depends on is done,
and PR [#3](https://github.com/fskroes/AllowanceKit/pull/3) is green on Node
20/22/24. What remains is the human-gated flip below. Steps 1 and 3 change public
state (main, the npm registry) and are irreversible — do them deliberately.

## 0. Preconditions (verify before starting)

- [ ] PR #3 `feat/release-0.5.0 → main` is **MERGEABLE** and CI is **green** on the head commit.
      Check: `gh pr checks 3` → three `pass`; `gh pr view 3 --json mergeable`.
- [ ] `npm test` is 91/91 locally on Node ≥ 24 (`node --test "test/*.test.ts"`).
- [ ] `bash scripts/release.sh --dry-run 0.5.0` prints every step without error.

## 1. Merge the PR to main (no squash)

History is the changelog (R-01 convention), so merge with a merge commit, not a squash:

```
gh pr merge 3 --merge
git checkout main && git pull origin main
```

Confirm main is at the merge and clean:

```
git log --oneline -3
git status --porcelain   # must be empty
```

## 2. Load the npm token (do NOT `source .env`)

The `.env` holds a multi-line PEM that breaks the shell if sourced. Export just the one var
(this exact line is in memory and printed by the release script):

```
export NPM_ACCESS_TOKEN=$(grep '^NPM_ACCESS_TOKEN=' .env | cut -d= -f2-)
```

Sanity: `[ -n "$NPM_ACCESS_TOKEN" ] && echo "token set"`.

> A bare `401` on publish almost always means the token isn't exported under this exact
> name, not that the token is dead (memory: npm-publish-token-setup).

## 3. Run the release

```
scripts/release.sh 0.5.0
```

It asserts clean-tree-on-main, runs `npm ci` / build / test, bumps `allowance-kit` **and**
`packages/wallie` to 0.5.0 (alias pinned to `allowance-kit@^0.5.0`), promotes the CHANGELOG
`[Unreleased]` section, commits `release: v0.5.0`, tags `v0.5.0`, publishes both packages,
then `git push origin main --follow-tags`.

**Provenance:** a local run publishes **without** the `--provenance` badge — the script only
adds it when `$GITHUB_ACTIONS` is set (OIDC). That's fine for 0.5.0; R-06's done-when doesn't
require provenance. To get the badge later, add a publish job to CI that runs this script on a
`v*` tag (future work, not a 0.5.0 blocker).

## 4. Verify from a clean directory

```
cd "$(mktemp -d)"
npx allowance-kit@0.5.0 --version   # → 0.5.0
npx wallie@0.5.0 --version          # → 0.5.0
npx wallie demo                     # practice-money demo runs to completion
```

Also confirm the registry and the tag:

```
npm view allowance-kit@0.5.0 version
npm view wallie@0.5.0 version
git tag --list v0.5.0
```

**Done when:** both packages resolve to 0.5.0 on the registry and `npx wallie demo` passes.

## 5. After the release (not blockers for R-06)

- **Site:** `docs.html` on onewallie.com still needs the mainnet-statement update (the M-03
  site portion — that repo isn't here). Deploying the site needs the pinned-alias step
  (memory: onewallie-deploy-pinned-alias): `vercel --prod` then `vercel alias set`.
- **Wallie Cloud (deliverable B):** the €20/mo product the site sells still doesn't exist —
  C-01–C-09, billing (B), site fixes (S). The **§7 launch gate** ("released *and buyable*")
  is not met until that ships. 0.5.0 only delivers **A** (the mainnet-proven package).

## Rollback notes

- A bad publish cannot be unpublished after 72h and shouldn't be within it either; fix
  forward with 0.5.1.
- If the release script fails **after** the version-bump commit but **before** publish, reset
  with `git reset --hard origin/main` (nothing was pushed yet) and re-run.
