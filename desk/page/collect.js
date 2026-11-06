// Which rallies the desk page sends for one video, from the pipeline's events.
//   gallery  a long video: each rally rally.js finds (rallyStart .. rallyEnd) is one rally, as on the camera.
//   rally    a 다시 보기 original: the camera already cut it to one rally, so the whole clip is that one
//            rally. Every shot and bounce in the clip is kept and one rally is sent at the end, even when
//            rally.js never closes (the clip stops mid-play) or splits it (the ball was lost for a moment).
// RallyShots is passed in: the page loads it by URL (../js/), a test by file path.
export class DeskRallies {
  constructor(kind, RallyShots) {
    this.kind = kind === "rally" ? "rally" : "gallery";
    this.shots = new RallyShots();
    this.ended = [];
    this.open = false;
    this.all = [];
    this.bounces = [];
  }

  onEvent(e) {
    this.shots.onEvent(e);
    if (this.kind === "rally") {
      if ((e.type === "shot" || e.type === "shotUpdate") && !this.all.includes(e.shot)) this.all.push(e.shot);
      else if (e.type === "bounce" && e.bounce) this.bounces.push(e.bounce);
      return;
    }
    if (e.type === "rallyStart") this.open = true;
    else if (e.type === "rallyEnd") {
      this.open = false;
      this.ended.push({ startT: e.t - e.durationS, draft: this.shots.draft(e, 0), shots: this.shots.shots });
    }
  }

  // Frames before this one can be skipped on a resume. A rally clip is one rally, so it always restarts.
  resumable() {
    return this.kind === "gallery" && !this.open;
  }

  take() {
    return this.ended.splice(0);
  }

  // The end of the video. startT and endT are the clip's first and last analysed times in seconds.
  finish(startT, endT) {
    if (this.kind !== "rally" || !this.all.length) return this.take();
    this.shots.shots = this.all;
    const end = { t: endT, why: "clip", durationS: Math.max(0, endT - startT), bounces: this.bounces };
    return [{ startT, draft: this.shots.draft(end, 0), shots: this.all }];
  }
}
