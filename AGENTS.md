# Process safety

- Never launch an unbounded busy loop or hand-written CPU load in a shell command.
- Run CPU-contention checks through `scripts/under-cpu-load.sh`; its workers have explicit PIDs, signal cleanup, self-enforced wall-clock and kernel CPU limits, reduced priority, and leave one logical CPU free.
- For any other background process, capture each PID directly from `$!`, install `EXIT INT TERM HUP` cleanup, and give the child its own finite resource or wall-clock bound. Do not use `jobs -p` inside command substitution under zsh; it sees an empty job table.
- Before finishing a process-heavy task, verify that its recorded child PIDs are gone.
