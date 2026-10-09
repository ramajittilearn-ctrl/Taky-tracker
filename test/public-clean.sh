#!/bin/sh
# Fails if public/ contains anything other than index.html and _headers.
cd "$(dirname "$0")/.." || exit 1
found=$(find public -type f | sed 's|^public/||' | sort | tr '\n' ' ')
[ "$found" = "_headers index.html " ] && echo "OK public/: $found" || { echo "FAIL public/: $found"; exit 1; }
