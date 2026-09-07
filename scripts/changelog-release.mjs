// Promote the CHANGELOG's [Unreleased] section to a dated release, and open a
// fresh empty [Unreleased] above it. Called by scripts/release.sh.
//
//   node scripts/changelog-release.mjs 0.5.0
import fs from "node:fs";

const version = process.argv[2];
if (!version) {
  console.error("usage: changelog-release.mjs <version>");
  process.exit(2);
}
const date = new Date().toISOString().slice(0, 10);
const repo = "https://github.com/fskroes/AllowanceKit";
const file = new URL("../CHANGELOG.md", import.meta.url);

let s = fs.readFileSync(file, "utf8");
if (!s.includes("## [Unreleased]")) {
  console.error("CHANGELOG.md has no `## [Unreleased]` section — nothing to release.");
  process.exit(1);
}

// The content currently under [Unreleased] *is* this version's notes; rename the
// heading and drop a fresh, empty [Unreleased] above it.
s = s.replace(/## \[Unreleased\]\n/, `## [Unreleased]\n\n## [${version}] - ${date}\n`);

// Repoint the link refs at the bottom: [Unreleased] now compares from the new
// tag, and a [version] ref is added pointing at the previous tag.
const unrel = /^\[Unreleased\]: .*compare\/v([0-9][0-9A-Za-z.-]*)\.\.\.HEAD$/m;
const m = s.match(unrel);
if (m) {
  const prev = m[1];
  s = s.replace(
    unrel,
    `[Unreleased]: ${repo}/compare/v${version}...HEAD\n[${version}]: ${repo}/compare/v${prev}...v${version}`,
  );
  console.log(`CHANGELOG.md: opened [${version}] - ${date} (previous v${prev})`);
} else {
  console.warn(`CHANGELOG.md: renamed [Unreleased] -> [${version}], but could not find the link refs to update — add them by hand.`);
}

fs.writeFileSync(file, s);
