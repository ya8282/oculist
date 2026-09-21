#!/bin/zsh
set -eu
setopt NO_BG_NICE

if (( $# < 4 )) || [[ $3 != -- ]] || [[ $1 != <-> ]] || [[ $2 != <-> ]] || (( $1 < 1 || $2 < 1 )); then
  print -u2 'usage: scripts/under-cpu-load.sh WORKERS CPU_SECONDS -- COMMAND [ARGS...]'
  exit 64
fi

workers=$1
cpu_seconds=$2
shift 3

cores=$(sysctl -n hw.logicalcpu 2>/dev/null || getconf _NPROCESSORS_ONLN 2>/dev/null || print 2)
max_workers=$(( cores > 1 ? cores - 1 : 1 ))
if (( workers > max_workers )); then
  print -u2 "workers must be <= $max_workers (one logical CPU stays free)"
  exit 64
fi

typeset -a worker_pids
cleanup() {
  trap - EXIT INT TERM HUP
  (( ${#worker_pids} )) || return
  kill ${worker_pids[@]} 2>/dev/null || true
  wait ${worker_pids[@]} 2>/dev/null || true
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM HUP

for (( i = 0; i < workers; i++ )); do
  (
    ulimit -H -t "$(( cpu_seconds + 1 ))"
    ulimit -S -t "$cpu_seconds"
    exec nice -n 10 /usr/bin/perl -e '$SIG{ALRM} = sub { exit 0 }; alarm shift; 1 while 1' "$cpu_seconds"
  ) &
  worker_pids+=($!)
done
print -u2 "cpu-load workers: ${worker_pids[*]}"

"$@"
