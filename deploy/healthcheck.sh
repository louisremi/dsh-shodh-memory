#!/bin/sh
# Show health status of shodh-memory and deepseek-harness
for c in shodh-memory deepseek-harness; do
  echo "=== $c ==="
  docker inspect "$c" --format '{{.State.Status}} health={{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}'
  docker inspect "$c" --format '{{if .State.Health}}{{range $(last 2 .State.Health.Log)}}exit={{.Exit}} out={{.Output}}{{end}}{{end}}' 2>/dev/null | head -c 500
  echo
done
