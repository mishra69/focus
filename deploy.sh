#!/bin/bash
set -e

VERSION=$(date +%Y%m%d_%H%M)

# Stamp version into app
sed -i '' "s/const VERSION = '[^']*'/const VERSION = '$VERSION'/" focus-app/index.html

npx wrangler deploy

# -u stages every tracked file that changed — worker.js and sw.js ship with the deploy, so they
# must be committed with it. Untracked files are deliberately left alone (see .gitignore).
git add -u
git commit -m "deploy $VERSION"
git push
