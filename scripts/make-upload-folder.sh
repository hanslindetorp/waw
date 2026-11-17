#!/bin/sh
# Builds ~/Downloads/waw-upload: exactly what goes into waw/ on waxml.org (FileZilla),
# in the same folder structure. Never contains lti/config.php, the database or tests.
set -e
cd "$(dirname "$0")/.."
OUT="${1:-$HOME/Downloads/waw-upload}"
rm -rf "$OUT"
mkdir -p "$OUT/lti/lib"
rsync -a --exclude .DS_Store index.html viewer.html waxml.js css js schemas public templates "$OUT/"
cp lti/done.php lti/admin.php lti/launch.php lti/login.php lti/jwks.php "$OUT/lti/"
cp lti/lib/*.php "$OUT/lti/lib/"
echo "Ready: $OUT"
find "$OUT" -type f | wc -l | xargs echo "files:"
