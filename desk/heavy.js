// Reading the GPU job queue's lines (the `heavy` command, see docs/analysis-desk.md).
// The queue prints one line when a job is taken (HEAVY_ADMIT) and one when it starts waiting or
// its reason for waiting changes (HEAVY_WAIT), on stderr and in its log:
//   HEAVY_WAIT <label>: 2 job(s) ahead in the queue      -> 3rd in line
//   HEAVY_WAIT <label>: all 1 slots busy: ...            -> front of the line, waiting for the GPU
//   HEAVY_WAIT <label>: 1 running; gpu 83%+83% -> ...    -> front of the line, waiting for headroom
//   HEAVY_ADMIT <label> slot.1: ...                       -> running now
// A wait for the same reason is not printed again, so "2 ahead" stays on screen while the jobs in
// front leave. queuePosition() reads the queue's directory for the current place instead.

const WAIT = /HEAVY_WAIT (\S+): (.*)$/;
const ADMIT = /HEAVY_ADMIT (\S+) /;
const AHEAD = /^(\d+) job\(s\) ahead in the queue/;

// { type: "wait", label, waitPos, why } | { type: "admit", label } | null for any other line
export function parseHeavyLine(line) {
  const admit = ADMIT.exec(line);
  if (admit) return { type: "admit", label: admit[1] };
  const wait = WAIT.exec(line);
  if (!wait) return null;
  const ahead = AHEAD.exec(wait[2]);
  return { type: "wait", label: wait[1], waitPos: ahead ? Number(ahead[1]) + 1 : 1, why: wait[2] };
}

// The queue directory holds one ticket per waiting job, named "<enqueue ms, 15 digits>-<pid>-<label>"
// (label with characters other than [\w.-] turned into "_"); sorted names are the line. Returns the
// 1-based place of the label's ticket, or null when it is not in the line (admitted or not queued yet).
export function queuePosition(names, label) {
  const safe = label.replace(/[^\w.-]/g, "_");
  const i = [...names].sort().findIndex((n) => /^\d{15}-\d+-/.test(n) && n.replace(/^\d{15}-\d+-/, "") === safe);
  return i === -1 ? null : i + 1;
}
