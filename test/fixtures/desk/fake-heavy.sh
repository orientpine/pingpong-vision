#!/usr/bin/env bash
# Stands in for the GPU job queue: `fake-heavy.sh <label> --mem SIZE -- <command ...>` prints two
# HEAVY_WAIT lines and a HEAVY_ADMIT line on stderr in the queue's format, then runs the command.
# With FAKE_HEAVY_GATE (a fifo) it waits for one line on it after each HEAVY_WAIT. The fifo is opened
# once, so a line written while the script is between two reads is not lost.
label=$1
shift 3
[ "$1" = "--" ] && shift
if [ -n "$FAKE_HEAVY_GATE" ]; then exec 3<"$FAKE_HEAVY_GATE"; fi
gate() { if [ -n "$FAKE_HEAVY_GATE" ]; then read -r _ <&3; fi; }
echo "HEAVY_WAIT $label: 2 job(s) ahead in the queue" >&2
gate
echo "HEAVY_WAIT $label: all 1 slots busy: slot.1 other-job (pid 1, 3m)" >&2
gate
echo "HEAVY_ADMIT $label slot.1: 0 heavy job(s) running, load 5 < 80" >&2
exec "$@"
