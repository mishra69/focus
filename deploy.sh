#!/bin/bash
set -e

VERSION=$(date +%Y%m%d_%H%M)

# Stamp version into app
sed -i '' "s/const VERSION = '[^']*'/const VERSION = '$VERSION'/" focus-app/index.html

npx wrangler deploy

git add focus-app/index.html
git commit -m "deploy $VERSION"
git push
