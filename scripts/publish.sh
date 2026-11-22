#!/usr/bin/env bash
# Publish dsh-delete-chat to GitHub.
#
# Required environment:
#   GH_OWNER    GitHub user or organization that will own the repository
#   GH_TOKEN    token with "Contents: read and write" (and repo creation) scope
#   GIT_NAME    author name for the rewritten commits
#   GIT_EMAIL   author email for the rewritten commits
#
# Optional:
#   REPO_NAME   repository name (default: dsh-delete-chat)
#   PRIVATE     "true" to create a private repository (default: public)
#
# The token is passed through an HTTP header, never written into the repository
# URL or .git/config. Run from anywhere: the script resolves its own root.
set -euo pipefail

: "${GH_OWNER:?set GH_OWNER}"
: "${GH_TOKEN:?set GH_TOKEN}"
: "${GIT_NAME:?set GIT_NAME}"
: "${GIT_EMAIL:?set GIT_EMAIL}"
REPO_NAME="${REPO_NAME:-dsh-delete-chat}"
PRIVATE="${PRIVATE:-false}"

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$root"

if ! git rev-parse --git-dir >/dev/null 2>&1; then
  echo "not a git repository: $root" >&2
  exit 1
fi
if [ -n "$(git status --porcelain)" ]; then
  echo "working tree is not clean; commit or stash first" >&2
  exit 1
fi

# 1. Fill in the repository URL everywhere it is declared.
if grep -q 'REPLACE_ME' package.json README.md 2>/dev/null; then
  sed -i.bak "s#github.com/REPLACE_ME/#github.com/${GH_OWNER}/#g" package.json README.md
  rm -f package.json.bak README.md.bak
  git add package.json README.md
  git -c user.name="$GIT_NAME" -c user.email="$GIT_EMAIL" commit -q -m "docs: point the repository at ${GH_OWNER}/${REPO_NAME}"
fi

# 2. Rewrite the placeholder author on every commit.
if git log --format='%an <%ae>' | grep -q 'dsh-delete-chat <noreply@localhost>'; then
  FILTER_BRANCH_SQUELCH_WARNING=1 git filter-branch -f --env-filter "
    export GIT_AUTHOR_NAME='$GIT_NAME'
    export GIT_AUTHOR_EMAIL='$GIT_EMAIL'
    export GIT_COMMITTER_NAME='$GIT_NAME'
    export GIT_COMMITTER_EMAIL='$GIT_EMAIL'
  " -- --all >/dev/null
  git update-ref -d refs/original/refs/heads/$(git branch --show-current 2>/dev/null || echo main) 2>/dev/null || true
fi

# 3. Create the repository (idempotent: 422 means it already exists).
status="$(curl -sS -o /tmp/dsh-delete-chat-repo.json -w '%{http_code}' \
  -X POST \
  -H "Authorization: Bearer ${GH_TOKEN}" \
  -H 'Accept: application/vnd.github+json' \
  -H 'X-GitHub-Api-Version: 2022-11-28' \
  https://api.github.com/user/repos \
  -d "{\"name\":\"${REPO_NAME}\",\"private\":${PRIVATE},\"description\":\"Delete part of a DeepSeek Harness conversation\"}")"
if [ "$status" != "201" ] && [ "$status" != "422" ]; then
  echo "repository creation failed (HTTP $status):" >&2
  cat /tmp/dsh-delete-chat-repo.json >&2
  exit 1
fi

# 4. Push with the token in a per-command header.
remote="https://github.com/${GH_OWNER}/${REPO_NAME}.git"
git remote remove origin 2>/dev/null || true
git remote add origin "$remote"
git -c http.extraheader="AUTHORIZATION: bearer ${GH_TOKEN}" push -u origin HEAD:main

echo
echo "published: https://github.com/${GH_OWNER}/${REPO_NAME}"
echo "install: clone the repository, then DSH → Plugins → Add plugin → choose the clone"
