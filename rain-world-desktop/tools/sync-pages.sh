#!/usr/bin/env bash
# Mirror this folder (rain-world-desktop/) to its own repository, whose `main`
# branch GitHub Pages publishes: https://nickssoftwarefun.github.io/rain-world-desktop/
#
#   rain-world-desktop/tools/sync-pages.sh [branch]
#
# Run from anywhere in the Multi-Project-Playground checkout after pushing the
# development branch (default: the current branch). It splits the folder's
# history out with `git subtree split` (the same commits every time, so each
# sync is a fast-forward) and pushes it to the mirror's main branch.
set -euo pipefail
MIRROR=${RW_MIRROR_URL:-https://github.com/NicksSoftwareFun/rain-world-desktop.git}
cd "$(git rev-parse --show-toplevel)"
BRANCH=${1:-$(git rev-parse --abbrev-ref HEAD)}
SPLIT=$(git subtree split -q --prefix=rain-world-desktop "$BRANCH")
echo "rain-world-desktop @ $BRANCH -> $SPLIT"
for i in 1 2 3 4; do
  git push "$MIRROR" "$SPLIT:refs/heads/main" && exit 0
  sleep $((2 ** i))
done
echo "push to $MIRROR failed" >&2
exit 1
