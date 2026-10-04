#!/usr/bin/env bash
# Turn on the Sponsor button for every public, non-fork, non-archived repo of each owner.
set -euo pipefail
: "${GH_TOKEN:?GH_TOKEN is empty: add the SPONSOR_TOKEN secret}"
changed=0; checked=0
for owner in chrikrah Plexito-de; do
  rows=$(gh api graphql -f owner="$owner" -f query='
    query($owner: String!) { repositoryOwner(login: $owner) {
      repositories(first: 100, privacy: PUBLIC, isFork: false) {
        nodes { id nameWithOwner isArchived hasSponsorshipsEnabled } } } }' \
    --jq '.data.repositoryOwner.repositories.nodes[] | select(.isArchived | not) | [.id, .nameWithOwner, .hasSponsorshipsEnabled] | @tsv')
  [ -n "$rows" ] || { echo "::error::no public repos returned for $owner"; exit 1; }
  while IFS=$'\t' read -r id name enabled; do
    checked=$((checked + 1))
    [ "$enabled" = "true" ] && continue
    if [ "${DRY_RUN:-0}" = "1" ]; then echo "would enable: $name"; continue; fi
    gh api graphql -f id="$id" -f query='
      mutation($id: ID!) { updateRepository(input: {repositoryId: $id, hasSponsorshipsEnabled: true}) {
        repository { hasSponsorshipsEnabled } } }' \
      --jq '.data.updateRepository.repository.hasSponsorshipsEnabled' | grep -qx true
    echo "enabled: $name"; changed=$((changed + 1))
  done <<< "$rows"
done
echo "checked $checked public repos, enabled $changed"
