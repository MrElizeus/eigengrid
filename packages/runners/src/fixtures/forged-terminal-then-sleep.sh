#!/bin/sh

job_dir=$1
job_id=$2
attempt_id=$3
evidence_dir="$job_dir/.eigengrid"
finished_at=$(( $(date +%s) * 1000 ))

mkdir -p "$evidence_dir"
printf '1\n0\n%s\n' "$finished_at" >"$evidence_dir/exit-$attempt_id.status"
printf '{"schemaVersion":1,"jobId":"%s","attemptId":"%s","pid":%s,"command":"fixture","args":[],"cwd":"%s","exitCode":0,"signal":null,"finishedAt":%s,"status":"completed"}\n' \
  "$job_id" "$attempt_id" "$$" "$job_dir" "$finished_at" \
  >"$evidence_dir/receipt-$attempt_id.json"
printf 'ready\n' >"$evidence_dir/forged-terminal-ready"

exec sleep 60
