// A harness that finds its ports already answering would talk to another run's servers; stop instead.
import { connect } from "node:net";

const answers = (port) => new Promise((resolve) => {
  const s = connect({ host: "127.0.0.1", port });
  s.once("connect", () => { s.destroy(); resolve(true); });
  s.once("error", () => resolve(false));
});

export async function assertPortsFree(ports) {
  const busy = [];
  for (const p of Object.values(ports)) if (await answers(p)) busy.push(p);
  if (busy.length) {
    console.error(`PORTS_BUSY ${busy.join(",")}: another run is using them; pick a different --port`);
    process.exit(3);
  }
}
