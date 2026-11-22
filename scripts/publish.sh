#!/usr/bin/env bash
# Publish dsh-delete-chat to GitHub.
#
# Two modes:
#   1. SSH (default, no secret needed): create an EMPTY public repository on
#      GitHub first, then run with GH_OWNER set. The script pushes over your
#      existing SSH key.
#   2. Token: also pass GH_TOKEN (Contents: read and write). The script creates
#      the repository through the API and pushes over HTTPS.
#
# Required:
#   GH_OWNER    GitHub user or organization that owns the repository
#
# Optional:
#   GH_TOKEN    token with repository-creation and contents scope
#   REPO_NAME   repository name (default: dsh-delete-chat)
#   PRIVATE     "true" to create a private repository (token mode only)
#   GIT_NAME    author name used when placeholder commits must be rewritten
#   GIT_EMAIL   author email used for the same rewrite
#
# In token mode the token is passed through a per-command HTTP header, never
# written into the repository URL or .git/config.
set -euo pipefail

: "${GH_OWNER:?set GH_OWNER}"
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

# 1. Fill in the repository URL wherever the placeholder is still present.
if grep -q 'REPLACE_ME' package.json README.md 2>/dev/null; then
  sed -i.bak "s#github.com/REPLACE_ME/#github.com/${GH_OWNER}/#g" package.json README.md
  rm -f package.json.bak README.md.bak
  git add package.json README.md
  git -c user.name="${GIT_NAME:-$GH_OWNER}" -c user.email="${GIT_EMAIL:-${GH_OWNER}@users.noreply.github.com}" \
    commit -q -m "docs: point the repository at ${GH_OWNER}/${REPO_NAME}"
fi

# 2. Rewrite placeholder authors when they are still present.
if git log --format='%an <%ae>' | grep -q 'dsh-delete-chat <noreply@localhost>'; then
  : "${GIT_NAME:?set GIT_NAME to rewrite the placeholder author}"
  : "${GIT_EMAIL:?set GIT_EMAIL to rewrite the placeholder author}"
  FILTER_BRANCH_SQUELCH_WARNING=1 git filter-branch -f --env-filter "
    export GIT_AUTHOR_NAME='$GIT_NAME'
    export GIT_AUTHOR_EMAIL='$GIT_EMAIL'
    export GIT_COMMITTER_NAME='$GIT_NAME'
    export GIT_COMMITTER_EMAIL='$GIT_EMAIL'
  " -- --all >/dev/null
fi

# 3. Publish.
if [ -n "${GH_TOKEN:-}" ]; then
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

  remote="https://github.com/${GH_OWNER}/${REPO_NAME}.git"
  git remote remove origin 2>/dev/null || true
  git remote add origin "$remote"
  git -c http.extraheader="AUTHORIZATION: bearer ${GH_TOKEN}" push -u origin HEAD:main
else
  remote="git@github.com:${GH_OWNER}/${REPO_NAME}.git"
  if ! git ls-remote "$remote" >/dev/null 2>&1; then
    echo "repository not found over SSH: ${remote}" >&2
    echo "create an empty public repository first: https://github.com/new?name=${REPO_NAME}" >&2
    exit 1
  fi
  git remote remove origin 2>/dev/null || true
  git remote add origin "$remote"
  git push -u origin HEAD:main
fi

echo
echo "published: https://github.com/${GH_OWNER}/${REPO_NAME}"
echo "install: clone the repository, then DSH → Plugins → Add plugin → choose the clone"
