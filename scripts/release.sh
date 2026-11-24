#!/usr/bin/env bash
set -euo pipefail

DRY=0
VERSION=""
for a in "$@"; do
  case "$a" in
    --dry-run|-n) DRY=1 ;;
    -*) echo "unknown flag: $a" >&2; exit 2 ;;
    *) VERSION="$a" ;;
  esac
done

if [ -z "$VERSION" ]; then
  echo "usage: scripts/release.sh [--dry-run] <version>   e.g. scripts/release.sh 0.5.0" >&2
  exit 2
fi
if ! [[ "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+([-.][0-9A-Za-z.-]+)?$ ]]; then
  echo "not a version number: \"$VERSION\" (expected e.g. 0.5.0)" >&2
  exit 2
fi

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

say()  { printf '\n\033[1m==> %s\033[0m\n' "$*"; }
warn() { printf '\033[33m  ! %s\033[0m\n' "$*" >&2; }
step() {
  local cmd="$*"
  if [ "$DRY" = 1 ]; then
    printf '  [dry-run] %s\n' "$cmd"
  else
    printf '  + %s\n' "$cmd"
    eval "$cmd"
  fi
}
stop() {
  if [ "$DRY" = 1 ]; then warn "$1 (ignored in --dry-run)"; else echo "  x $1" >&2; exit 1; fi
}

say "Releasing allowance-kit, wallie, and wallie-mcp @ $VERSION"

say "Preconditions"
BRANCH="$(git rev-parse --abbrev-ref HEAD)"
if [ "$BRANCH" != "main" ]; then stop "release from main, not \"$BRANCH\""; fi
if [ -n "$(git status --porcelain)" ]; then stop "working tree is not clean — commit or stash first"; fi
if git rev-parse -q --verify "refs/tags/v$VERSION" >/dev/null; then stop "tag v$VERSION already exists"; fi
printf '  branch=%s  clean=%s  tag-free=yes\n' "$BRANCH" "$([ -z "$(git status --porcelain)" ] && echo yes || echo no)"

say "npm authentication"
EXPORT_LINE="export NPM_ACCESS_TOKEN=\$(grep '^NPM_ACCESS_TOKEN=' .env | cut -d= -f2-)"
if [ -z "${NPM_ACCESS_TOKEN:-}" ]; then
  warn "NPM_ACCESS_TOKEN is not set. Load it (do NOT 'source .env' — the multi-line PEM breaks the shell):"
  warn "  $EXPORT_LINE"
  stop "NPM_ACCESS_TOKEN required to publish"
else
  printf '  NPM_ACCESS_TOKEN is set\n'
fi

PROV=""
if [ -n "${GITHUB_ACTIONS:-}" ]; then PROV="--provenance"; printf '  running in CI — publishing with --provenance\n'; else warn "not in CI — publishing without --provenance (a local npm login publish has no provenance badge)"; fi

say "Test and build"
step "npm ci"
step "npm run build"
step "npm test"

say "Bump versions to $VERSION"
step "npm version $VERSION --no-git-tag-version --allow-same-version"
step "npm --prefix packages/wallie version $VERSION --no-git-tag-version --allow-same-version"
step "npm --prefix packages/wallie pkg set dependencies.allowance-kit=^$VERSION"
step "npm --prefix packages/wallie-mcp version $VERSION --no-git-tag-version --allow-same-version"
step "npm --prefix packages/wallie-mcp pkg set dependencies.allowance-kit=^$VERSION"

say "Verify the packed SDK, CLI aliases, and MCP server in a fresh consumer"
step "node scripts/verify-release.ts"

say "CHANGELOG"
step "node scripts/changelog-release.mjs $VERSION"

say "Commit and tag"
step "git add package.json package-lock.json packages/wallie/package.json packages/wallie-mcp/package.json CHANGELOG.md"
step "git commit -m \"release: v$VERSION\""
step "git tag -a v$VERSION -m \"v$VERSION\""

say "Publish"
step "npm publish $PROV --access public --userconfig \"$ROOT/.npmrc\""
step "( cd packages/wallie && npm publish $PROV --access public --userconfig \"$ROOT/.npmrc\" )"
step "( cd packages/wallie-mcp && npm publish $PROV --access public --userconfig \"$ROOT/.npmrc\" )"

say "Push"
step "git push origin main --follow-tags"

say "Done — verify from a clean directory"
printf '  npx allowance-kit@%s --version\n  npx wallie@%s --version\n  npx wallie-mcp@%s\n' "$VERSION" "$VERSION" "$VERSION"
if [ "$DRY" = 1 ]; then printf '\n(dry-run: nothing above was executed)\n'; fi
