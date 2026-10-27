#!/usr/bin/env bash
# Publish all packages in dependency order. Requires `npm login` first.
set -euo pipefail
cd "$(dirname "$0")/.."
VERSION="${1:?usage: scripts/release.sh <version>}"
for p in core render playwright cli; do
  node -e "
    const fs=require('fs');const f='packages/$p/package.json';const j=JSON.parse(fs.readFileSync(f));
    j.version='$VERSION';
    for (const k of Object.keys(j.dependencies||{})) if (k.startsWith('@demo-engine/')) j.dependencies[k]='$VERSION';
    fs.writeFileSync(f, JSON.stringify(j,null,2)+'\n');"
done
sed -i.bak "s/\.version(\"[0-9.]*\")/.version(\"$VERSION\")/" packages/cli/src/index.ts && rm -f packages/cli/src/index.ts.bak
npm run build
npm test
for p in core render playwright cli; do
  (cd "packages/$p" && npm publish --access public)
done
git add -A && git commit -m "release v$VERSION" && git tag "v$VERSION" && git push && git push --tags
echo "published demo-engine@$VERSION"
