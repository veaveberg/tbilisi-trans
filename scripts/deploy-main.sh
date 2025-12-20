#!/bin/bash

# Exit on error
set -e

# Configuration
BRANCH="main"
REMOTE="origin"
TIMESTAMP=$(date +%Y%m%d-%H%M)
BACKUP_BRANCH="main-backup-$TIMESTAMP"

echo "🚀 Starting backup and push process for branch '$BRANCH'..."

# 1. Create a local backup branch
echo "📦 Creating backup branch: $BACKUP_BRANCH"
git branch "$BACKUP_BRANCH"

# 2. Push the backup branch to remote
echo "📤 Pushing backup to $REMOTE..."
git push "$REMOTE" "$BACKUP_BRANCH"

# 3. Push the main branch to remote
echo "📤 Pushing $BRANCH to $REMOTE..."
git push "$REMOTE" "$BRANCH"

echo "✅ Done! Site should be redeploying now."
echo "🔗 Backup created at: $BACKUP_BRANCH"
