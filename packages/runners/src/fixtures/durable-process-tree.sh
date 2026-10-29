#!/bin/sh

state_dir=$1
mode=$2
payload=${3-}
delay=${4-0}

wait_for_file() {
  path=$1
  remaining=200
  while [ ! -f "$path" ] && [ "$remaining" -gt 0 ]; do
    sleep 0.01
    remaining=$((remaining - 1))
  done
  [ -f "$path" ]
}

if [ "$mode" = "grandchild-natural" ]; then
  printf '%s\n' "$$" >"$state_dir/grandchild.pid"
  sleep "$delay"
  printf 'grandchild-completed\n' >"$state_dir/grandchild.completed"
  exit 0
fi

if [ "$mode" = "grandchild-wait" ]; then
  printf '%s\n' "$$" >"$state_dir/grandchild.pid"
  on_grandchild_signal() {
    printf 'grandchild-terminated\n' >"$state_dir/grandchild.terminated"
    exit 143
  }
  trap on_grandchild_signal TERM INT HUP
  while :; do sleep 1; done
fi

if [ "$mode" = "grandchild-stubborn" ]; then
  printf '%s\n' "$$" >"$state_dir/grandchild.pid"
  trap '' TERM INT HUP
  while :; do sleep 1; done
fi

mkdir -p "$state_dir"
printf '%s\n' "$$" >"$state_dir/child.pid"
printf '%s' "$payload" >"$state_dir/payload.txt"

if [ "$mode" = "natural" ]; then
  /bin/sh "$0" "$state_dir" grandchild-natural "" "$delay" &
  grandchild=$!
  wait_for_file "$state_dir/grandchild.pid"
  wait "$grandchild"
  printf 'result'
  printf 'warning' >&2
  printf 'child-completed\n' >"$state_dir/child.completed"
  exit 7
fi

grandchild_mode=grandchild-wait
if [ "$mode" = "stubborn" ]; then grandchild_mode=grandchild-stubborn; fi
/bin/sh "$0" "$state_dir" "$grandchild_mode" &
grandchild=$!
wait_for_file "$state_dir/grandchild.pid"

if [ "$mode" = "linger" ]; then
  exit 0
fi

if [ "$mode" = "stubborn" ]; then
  trap '' TERM INT HUP
  printf 'ready\n' >"$state_dir/ready"
  wait "$grandchild"
fi

on_child_signal() {
  printf 'child-terminated\n' >"$state_dir/child.terminated"
  wait "$grandchild" 2>/dev/null || true
  exit 143
}
trap on_child_signal TERM INT HUP
printf 'ready\n' >"$state_dir/ready"
wait "$grandchild"
