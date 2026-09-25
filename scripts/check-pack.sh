#!/usr/bin/env bash
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

packages=(
  "packages/sdk"
  "packages/nulth-sdk"
  "packages/mcp-server"
)

allowed_exact=("package.json" "README.md" "LICENSE")

for pkg_dir in "${packages[@]}"; do
  full_path="$root/$pkg_dir"
  echo "Checking packed files for $pkg_dir..."
  
  # Run npm pack --dry-run --json and parse files
  files_json=$(npm pack --dry-run --json "$full_path")
  
  # Extract file paths from the json array
  file_list=$(echo "$files_json" | jq -r '.[0].files[].path')
  
  while IFS= read -r file; do
    [[ -z "$file" ]] && continue
    
    # Check if file is in dist/
    if [[ "$file" == dist/* ]]; then
      continue
    fi
    
    # Check if file is in allowed exact list
    is_allowed=0
    for allowed in "${allowed_exact[@]}"; do
      if [[ "$file" == "$allowed" ]]; then
        is_allowed=1
        break
      fi
    done
    
    if [[ $is_allowed -eq 0 ]]; then
      echo "ERROR: Disallowed file in $pkg_dir package: $file" >&2
      exit 1
    fi
  done <<< "$file_list"
  
  echo "  $pkg_dir pack hygiene: OK"
done

echo "All packages passed package hygiene checks."
