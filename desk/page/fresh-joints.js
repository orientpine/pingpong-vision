// players.js landmarksAt returns the nearest joints a player was seen with, which can be seconds old when
// the player was not detected: on the labelled test_5 video the far player's forehand/backhand calls came
// from joints 1.3-14 s old (4 right, 5 wrong). A call needs joints seen this close to the shot.
export const MAX_JOINT_AGE_S = 0.2;

export function jointAge(lmHist, t) {
  let age = Infinity;
  for (const h of lmHist) age = Math.min(age, Math.abs(h.t - t));
  return age;
}
