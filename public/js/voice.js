// Spoken score call-outs with the phone's own speech engine (Web Speech, no network). iOS Safari
// speaks only after a first speak() inside a user tap, so unlock() runs on taps that come before
// play starts (camera start, settings).
import { SIDE_CALL, SIDE_PAIRS } from "./tournament.js";
import { EN, both } from "./i18n.js";

export function speak(text) {
  const synth = globalThis.speechSynthesis;
  if (!synth || !text || typeof SpeechSynthesisUtterance === "undefined") return false;
  synth.cancel();
  const u = new SpeechSynthesisUtterance(text);
  u.lang = EN ? "en-US" : "ko-KR";
  const ko = synth.getVoices().find((v) => (v.lang || "").toLowerCase().startsWith(EN ? "en" : "ko"));
  if (ko) u.voice = ko;
  u.rate = 1.05;
  synth.speak(u);
  return true;
}

let unlocked = false;
export function unlock() {
  if (unlocked) return;
  unlocked = speak(" ");
}

// What to say after a point. side is the winner's end colour, score / won are [blue end, red end].
export function pointCallout({ side, score, gameEnded, gameNo, won, matchOver, endChange }) {
  const who = SIDE_PAIRS[side];
  if (matchOver) return both(`${who.ko} 승리. 경기 끝`, `${who.en} wins. Match over`);
  if (gameEnded) return both(`${who.ko} ${gameNo}게임 승리. 게임 ${won[0]} 대 ${won[1]}. 엔드를 바꾸세요`, `${who.en} wins game ${gameNo}. Games ${won[0]}-${won[1]}. Change ends`);
  if (!score) return both(`${who.ko} 득점`, `Point ${who.en}`);
  const ko = `${SIDE_CALL[0].ko} ${score[0]}, ${SIDE_CALL[1].ko} ${score[1]}`;
  const en = `${SIDE_CALL[0].en} ${score[0]}, ${SIDE_CALL[1].en} ${score[1]}`;
  return endChange ? both(`${ko}. 엔드를 바꾸세요`, `${en}. Change ends`) : both(ko, en);
}

