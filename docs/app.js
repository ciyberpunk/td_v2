set -euo pipefail

# 0) Abort any in-progress merge/rebase
[ -d .git/rebase-apply ] || [ -d .git/rebase-merge ] && git rebase --abort || true
[ -f .git/MERGE_HEAD ] && git merge --abort || true

# 1) Make sure folders exist
mkdir -p docs/data .github/workflows

# 2) Replace docs/app.js with your clipboard (no editors)
pbpaste > docs/app.js

# 3) Cache-bust app.js in index.html so Pages serves the new code
sed -i '' 's#<script defer src="app.js[^"]*"></script>#<script defer src="app.js?v=now"></script>#' docs/index.html || true

# 4) Ensure your Pages workflow is correctly placed
#    (If you already have it there, this is a no-op.)
if [ -f pages.yml ] && [ ! -f .github/workflows/pages.yml ]; then
  cp -f pages.yml .github/workflows/pages.yml
fi

# 5) Add, commit, push
git add docs/app.js docs/index.html .github/workflows/pages.yml 2>/dev/null || true
git commit -m "frontend: replace app.js; cache-bust; ensure pages workflow path" || true
git push -u origin main

echo "Reload 👉 https://ciyberpunk.github.io/td_v2/?v=$(date +%s)"
