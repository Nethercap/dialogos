#!/bin/sh
# Dialogos: opens the editor in the browser.  ./dialogos.sh [project.json]
# (dialogos.json in the current folder by default.)
here=$(dirname "$0")
if command -v python3 >/dev/null 2>&1; then exec python3 "$here/dialogos.py" "$@"; fi
if command -v python >/dev/null 2>&1; then exec python "$here/dialogos.py" "$@"; fi
echo "Python 3 is needed, or open web/index.html in your browser (it saves in the browser then)."
exit 1
