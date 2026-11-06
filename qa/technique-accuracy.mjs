// Usage: bun qa/technique-accuracy.mjs [--evidence=<dir>] -- compute accuracy measurements and write accuracy.json/report.
// Reproducible measurements; finalized agent labels are inputs, never rewritten.
import { readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import assert from "node:assert/strict";
import { resolve } from "node:path";

const opt=(n,env,def)=>process.argv.find(a=>a.startsWith(`--${n}=`))?.slice(n.length+3)||process.env[env]||def;
const root=resolve(opt("evidence","EVIDENCE_DIR",resolve(import.meta.dir,"evidence")));
const read=name=>JSON.parse(readFileSync(`${root}/${name}`,"utf8"));
const baselineShots=read("shots.json"), baselineTruth=read("dataset-truth.json");
const shots=read("pose-on-shots.json"), truth=read("pose-on-truth.json"), poseRuns=read("pose-on-summary.json");
const gpt=read("labels-gpt.json"), claude=read("labels-claude.json").labels;
const hash=name=>createHash("sha256").update(readFileSync(`${root}/${name}`)).digest("hex");
const hashes=Object.fromEntries(["shots.json","dataset-truth.json","labels-gpt.json","labels-claude.json","pose-on-shots.json","pose-on-truth.json","pose-on-summary.json"].map(name=>[name,hash(name)]));
const byId=new Map(shots.map(s=>[s.id,s]));
const keys=["fore-attack","fore-defence","fore-serve","back-attack","back-defence","back-serve"];
const handKeys=["fore","back"], typeKeys=["serve","attack","defence"];
const keyOf=x=>x?.hand && x?.type && x.hand!=="unsure" && x.type!=="unsure" ? `${x.hand}-${x.type}` : null;
const ratio=(n,d)=>d ? n/d : null;
const pct=x=>x===null ? "측정 불가" : `${(x*100).toFixed(2)}%`;
const valueOf=(label,axis)=>axis==="key" ? keyOf(label) : label[axis];
function metrics(rows,axis,values) {
  return Object.fromEntries(values.map(key=>{
    const n=rows.filter(l=>valueOf(l,axis)===key).length;
    const predicted=rows.filter(l=>valueOf(byId.get(l.id).predicted,axis)===key);
    const tp=predicted.filter(l=>valueOf(l,axis)===key).length;
    return [key,{precision:n ? ratio(tp,predicted.length) : null,recall:ratio(tp,n),n,tp,fp:predicted.length-tp,fn:n-tp,predicted:predicted.length}];
  }));
}
function classify(rows) {
  return {hand:metrics(rows,"hand",handKeys),type:metrics(rows,"type",typeKeys),key:metrics(rows,"key",keys)};
}
const primary=classify(truth.labels);
const knownHand=truth.labels.filter(l=>byId.get(l.id).predicted.hand);
const correctHand=knownHand.filter(l=>byId.get(l.id).predicted.hand===l.hand).length;
const handFinding=`공개 데이터셋 정답 기준: 매칭 샷 ${truth.labels.length}개 중 hand 판정 ${knownHand.length}개, 일치 ${correctHand}개, 오판 ${knownHand.length-correctHand}개, 미분류 ${truth.labels.length-knownHand.length}개예요. 판정한 샷의 hand 정확도는 ${pct(ratio(correctHand,knownHand.length))}예요.`;
assert.equal(Object.values(primary.hand).reduce((a,b)=>a+b.n,0),truth.labels.length);
assert.equal(Object.values(primary.type).reduce((a,b)=>a+b.n,0),truth.labels.length);
assert.equal(Object.values(primary.key).reduce((a,b)=>a+b.n,0),truth.labels.length);
function detectionFor(input,withClassification) { return input.summary.map(s=>{
  const matched=input.labels.filter(l=>l.clip===s.clip);
  const missed=input.unmatchedAnnotations.filter(l=>l.clip===s.clip);
  const annotations=[...matched.map(l=>l.annotationT),...missed.map(l=>l.t)];
  // The upstream files specify event points, not exhaustive labelled intervals.
  // Declare a reproducible conservative outer window, including matching tolerance.
  const start=Math.max(0,Math.min(...annotations)-input.rules.maxDeltaSeconds);
  const end=Math.min(s.duration,Math.max(...annotations)+input.rules.maxDeltaSeconds);
  const unmatched=input.unmatchedDetections.filter(l=>l.clip===s.clip);
  const falseShots=unmatched.filter(l=>l.t>=start && l.t<=end);
  const outside=unmatched.filter(l=>l.t<start || l.t>end);
  const tp=matched.length, fp=falseShots.length, fn=missed.length;
  for(const m of matched)assert(m.detectedT>=start && m.detectedT<=end);
  assert.equal(tp+fp+outside.length,s.detected);
  assert.equal(tp+fn,s.annotated);
  return {clip:s.clip,start,end,tp,fp,fn,excludedOutside:outside.length,precision:ratio(tp,tp+fp),recall:ratio(tp,tp+fn),classification:withClassification ? classify(matched) : null};
}); }
const detection=detectionFor(truth,true);
const baselineDetection=detectionFor(baselineTruth,false);
const baselineTotals=baselineDetection.reduce((a,r)=>({tp:a.tp+r.tp,fp:a.fp+r.fp,fn:a.fn+r.fn,excludedOutside:a.excludedOutside+r.excludedOutside}),{tp:0,fp:0,fn:0,excludedOutside:0});
assert.deepEqual(baselineTotals,{tp:52,fp:49,fn:13,excludedOutside:5},"Preserve the original 49 false / 101 detected finding");
const total=detection.reduce((a,r)=>({tp:a.tp+r.tp,fp:a.fp+r.fp,fn:a.fn+r.fn,excludedOutside:a.excludedOutside+r.excludedOutside}),{tp:0,fp:0,fn:0,excludedOutside:0});
total.precision=ratio(total.tp,total.tp+total.fp);
total.recall=ratio(total.tp,total.tp+total.fn);
assert.equal(total.tp,truth.labels.length);
assert.equal(total.fn,truth.unmatchedAnnotations.length);
const commons=baselineShots.filter(s=>s.video.includes("/commons/"));
const agreement=commons.map(s=>{
  const a=gpt.find(x=>x.id===s.id),b=claude[s.id];
  assert(a && b,`Missing independent Commons label ${s.id}`);
  const handAgreement=a.hand===b.hand,typeAgreement=a.type===b.type;
  const hand=handAgreement && handKeys.includes(a.hand) ? a.hand : null;
  const type=typeAgreement && typeKeys.includes(a.type) ? a.type : null;
  return {id:s.id,gpt:a,claude:b,handAgreement,typeAgreement,exactAgreement:handAgreement&&typeAgreement,hand,type,status:hand&&type?"에이전트 합의 정답":"불확실"};
});
const accuracy=Object.fromEntries(keys.map(key=>{
  const {precision,recall,n}=primary.key[key];
  return [key,{precision,recall,n}];
}));
const table=(title,rows)=>[
  `### ${title}`,"","| 기술 | 정밀도 | 재현율 | n | TP | FP | FN | 예측 수 |",
  "| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |",
  ...Object.entries(rows).map(([key,r])=>`| ${key} | ${pct(r.precision)} | ${pct(r.recall)} | ${r.n} | ${r.tp} | ${r.fp} | ${r.fn} | ${r.predicted} |`),"",
].join("\n");
const rawAgreement=axis=>agreement.filter(a=>a[axis]).length;
const concreteHand=agreement.filter(a=>a.hand).length,concreteType=agreement.filter(a=>a.type).length;
const concreteFull=agreement.filter(a=>a.hand&&a.type).length;
const distinctSourceEvents=new Set(truth.labels.map(l=>`${l.sourceVideo}:${l.annotationFrame}`)).size;
const incompleteSection=[
  "### 미실행·미완료 클립","",
  "완료된 pose-on 결과는 4개뿐이에요. 아래 3개 클립은 측정하지 않았으며, 0개 검출이나 정확도 0%로 해석하지 않아요. 모두 dataset-truth.json의 주석 대상이 아니므로 아래 공개 데이터셋 정답 기준 분류·검출 분모에 들어가지 않아요. lead hold에 따라 pose·브라우저 재실행은 하지 않았어요.","",
  "| 클립 | 상태 | 사유 |","| --- | --- | --- |",
  "| portrait_game | 측정 안 함(실행 미완료) | 1200초 후 시간 초과 |",
  "| landscape_game | 미실행 | portrait_game 시간 초과로 중단, lead hold |",
  "| training_480 | 미실행 | portrait_game 시간 초과로 중단, lead hold |","",
  "pose-resume.log의 오류 원문:","",
  "```text","error: Pose evaluation timed out: portrait_game","      at <anonymous> (qa/technique-pose.mjs:63:39)","```","",
].join("\n");
const markdown=[
  "# 기술 정확도를 측정했어요","",
  "## 공개 데이터셋 정답 기준 · pose-on 재실행","",
  "qa/eval.js를 수정하지 않고 pose=1, poseModel=lite, poseEvery=1, numPoses=2, step=1, procWidth=640으로 실행했어요. 로컬 재현 환경에서는 CPU delegate를 사용했어요. 공 검출, pose gate, 선수 배정, strokeSide와 샷 종류 판정은 모두 실제 Pipeline 경로예요.",
  "",
  `Extended OpenTTGames와 시간·side가 일치한 ${truth.labels.length}개 검출 샷을 분류 평가에 사용했어요. 원본 이벤트는 ${distinctSourceEvents}개예요. test_2_head와 test_2_portrait가 같은 원본 이벤트를 공유하므로, 합산은 실행별 참고 수치이며 독립 영상 표본 수로 해석하지 않아요.`,
  "",
  "분류의 n은 매칭된 샷 가운데 해당 정답 기술의 개수예요. 정밀도는 TP/(TP+FP), 재현율은 TP/(TP+FN)이에요. null 예측은 미분류이며, 정답 클래스의 FN에 포함해요. 분모가 0이거나 해당 정답 n=0이면 JSON에는 null, 표에는 ‘측정 불가’를 적어요. n=0에는 정밀도·재현율을 주장하지 않아요.",
  "",
  "분류 평가는 검출에 성공한 매칭 샷에 조건부인 수치예요. 검출 누락은 아래 샷 검출 재현율로 따로 측정하며, 분류 표에 중복으로 더하지 않아요. 매칭되지 않은 검출은 분류 정답을 임의로 붙이지 않아요.",
  "",
  `매칭된 ${truth.labels.length}개 샷 가운데 hand 예측이 있는 샷은 ${truth.labels.filter(l=>byId.get(l.id).predicted.hand).length}개예요. 포즈를 얻지 못한 샷은 여전히 미분류예요. n=0인 기술에는 성능을 주장하지 않아요.`,
  "",handFinding,
  "",
  "| 클립 | 처리 프레임 | 포즈 있는 프레임 | 두 선수 포즈 프레임 | 검출 샷 | hand 판정 샷 |",
  "| --- | ---: | ---: | ---: | ---: | ---: |",
  ...poseRuns.map(r=>`| ${r.clip} | ${r.frames} | ${r.framesAnyPose} | ${r.framesBothPoses} | ${r.shots} | ${r.knownHand} |`),
  "",incompleteSection,
  table("손 기술",primary.hand),table("샷 종류",primary.type),table("6종 결합 기술",primary.key),
  "### 샷 검출","",
  "원본에는 단일 프레임 이벤트만 있고 명시적인 주석 구간은 없어요. 이 보고서에서는 각 평가 클립의 첫 stroke부터 마지막 stroke까지를 바깥 구간으로 잡고, 기존 매칭 허용 오차인 0.15초를 양끝에 더해요(클립 범위로 제한해요). 구간 안 미매칭 검출은 모두 거짓 샷 FP로 세고, 구간 밖 미매칭 검출은 제외해요. 구간 안 이벤트 사이 공백도 평가 구간에 포함해요. 실제로 주석이 빠진 동작이 있다면 거짓 샷이 과대 집계될 수 있어요.",
  "",
  "| 클립 | 평가 구간(초) | TP | 거짓 샷 FP | 누락 FN | 구간 밖 제외 | 정밀도 | 재현율 |",
  "| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |",
  ...detection.map(r=>`| ${r.clip} | ${r.start.toFixed(6)}–${r.end.toFixed(6)} | ${r.tp} | ${r.fp} | ${r.fn} | ${r.excludedOutside} | ${pct(r.precision)} | ${pct(r.recall)} |`),
  `| 합산 참고(중복 포함) | 각 클립 구간 | ${total.tp} | ${total.fp} | ${total.fn} | ${total.excludedOutside} | ${pct(total.precision)} | ${pct(total.recall)} |`,"",
  "이전 pose-off 실행의 test_2_head-001은 sourceT=1.642초로 고정된 주석 평가 구간 안에 있어요. 별도 에이전트 파일의 ‘주석 구간 전’ 설명과 달리, 이전 결과에서 FP로 계산했어요. Commons 평가로 옮기거나 에이전트 라벨로 데이터셋 정답을 덮어쓰지 않아요.",
  "",
  "### 클립별 분류 수치","",
  ...detection.flatMap(r=>[`#### ${r.clip}`,"",table("손 기술",r.classification.hand),table("샷 종류",r.classification.type),table("6종 결합 기술",r.classification.key)]),
  "## 이전 pose-off 실행: 샷 검출 발견을 유지해요","",
  "다음 표는 이전 실행이며 현재 pose-on 분류 정확도가 아니에요. 주석 구간 안 검출 101개 중 거짓 샷은 49개였어요(TP 52, FP 49, FN 13). 이 발견을 새 pose 실행 결과로 숨기거나 제거하지 않아요. 주석 구간 밖 미매칭 검출 5개는 이전에도 제외했어요.",
  "",
  "| 이전 클립 | TP | 거짓 샷 FP | 누락 FN | 구간 밖 제외 | 정밀도 | 재현율 |",
  "| --- | ---: | ---: | ---: | ---: | ---: | ---: |",
  ...baselineDetection.map(r=>`| ${r.clip} | ${r.tp} | ${r.fp} | ${r.fn} | ${r.excludedOutside} | ${pct(r.precision)} | ${pct(r.recall)} |`),
  `| 이전 합산(중복 포함) | 52 | 49 | 13 | 5 | ${pct(52/101)} | ${pct(52/65)} |`,"",
  "## Commons: 이전 독립 표시의 에이전트 합의 정답","",
  "아래 비교는 기존 shots.json의 같은 프레임 쌍에만 적용해요. 새 pose-on 검출에 과거 표시를 시간 확인 없이 옮기지 않아요.",
  "",
  `독립 표시가 모두 있는 Commons 샷 ${agreement.length}개만 비교했어요. GPT 표시는 먼저 확정했고, 이 측정 단계에서만 Claude 표시를 읽었어요. 원래 표시 파일은 바꾸지 않았어요.`,
  "",
  `원시 일치율은 hand ${rawAgreement("handAgreement")}/${agreement.length} (${pct(ratio(rawAgreement("handAgreement"),agreement.length))}), type ${rawAgreement("typeAgreement")}/${agreement.length} (${pct(ratio(rawAgreement("typeAgreement"),agreement.length))}), hand와 type 전체 ${rawAgreement("exactAgreement")}/${agreement.length} (${pct(ratio(rawAgreement("exactAgreement"),agreement.length))})예요. 이 원시 수치에는 양쪽의 unsure 일치도 포함돼요.`,
  "",
  `구체적인 값에 합의한 정답은 hand ${concreteHand}개, type ${concreteType}개, 6종 결합 ${concreteFull}개예요. unsure끼리 같아도 기술 정답으로 채택하지 않고 불확실로 남겨요. 따라서 이번 Commons 자료로 모델 정밀도·재현율을 계산할 수 없어요.`,
  "",
  "| 샷 | GPT hand/type | Claude hand/type | hand 원시 일치 | type 원시 일치 | 채택 결과 |",
  "| --- | --- | --- | --- | --- | --- |",
  ...agreement.map(a=>`| ${a.id} | ${a.gpt.hand}/${a.gpt.type} | ${a.claude.hand}/${a.claude.type} | ${a.handAgreement?"일치":"불일치"} | ${a.typeAgreement?"일치":"불일치"} | ${a.status} |`),"",
  "Claude에만 있는 test_2_head-001은 Commons 클립이 아니며 GPT 독립 표시도 없어서 합의율 분모에 넣지 않아요. 주석 기반 결과와 에이전트 비교 결과를 섞지 않아요.",
  "",
  "## 출처와 재현 방법","",
  `주석 저장소는 https://github.com/moamal01/table_tennis_data 이고 커밋은 ${truth.source.commit}예요. 라이선스는 ${truth.source.license}예요. 주석 파일 해시는 dataset-truth.json에 있어요.`,
  "",
  "serve → serve, loop/flick → attack, block/push/lob → defence로 매핑해요. side는 left → near, right → far이며, 120 fps 원본 프레임과 sourceT를 사용해요. 같은 side·0.15초 이내에서 가까운 쌍부터 일대일 매칭한 기존 결과를 그대로 평가해요.",
  "",
  "accuracy.json은 pose-on 공개 데이터셋 기준의 6개 키만 담고, 각 값은 {precision, recall, n}이에요. Commons 합의 수치를 이 파일에 추가하지 않아요. 이 측정에서 이미지 캡처를 새로 만들거나 배포하지 않았어요.",
  "",
  "```sh","cd <repo>","bun qa/technique-accuracy.mjs","```","",
  "입력 SHA-256:","",
  ...Object.entries(hashes).map(([name,digest])=>`- ${name}: \`${digest}\``),"",
].join("\n");
writeFileSync(`${root}/accuracy.json`,JSON.stringify(accuracy,null,2)+"\n");
writeFileSync(`${root}/accuracy.md`,markdown);
writeFileSync(new URL("./technique-accuracy.md",import.meta.url),markdown);
const countSection=[
  "<!-- pose-on-counts -->","",
  "## Pose-on 기술별 표본 수","",
  "공개 데이터셋 정답 기준: 이 표는 qa/eval.js, pose=1, poseModel=lite로 다시 검출하고 기존 dataset-truth.json의 주석에 재매칭한 최신 결과예요. 정확도는 accuracy.md, 기계용 6종 값은 accuracy.json에 있어요.",
  "",
  "| 기술 | 매칭 정답 n | 해당 키 예측 수 | TP |",
  "| --- | ---: | ---: | ---: |",
  ...keys.map(key=>`| ${key} | ${primary.key[key].n} | ${primary.key[key].predicted} | ${primary.key[key].tp} |`),"",
  `전체 매칭 ${truth.labels.length}개 중 hand 예측 ${truth.labels.filter(l=>byId.get(l.id).predicted.hand).length}개예요. 위 예측 수는 같은 정답 행 안의 수가 아니라 해당 클래스로 예측한 총수예요. n=0에는 성능을 주장하지 않아요.`,
  "",handFinding,
  "",
  `최신 pose-on 검출은 주석 구간 안 TP ${total.tp}, 거짓 샷 FP ${total.fp}, 누락 FN ${total.fn}예요. 이전 pose-off 발견인 거짓 샷 49/101개는 accuracy.md의 이전 실행 섹션에 그대로 남겨요.`,
  "",incompleteSection,
].join("\n");
for(const file of [`${root}/labels.md`,new URL("./technique-labels.md",import.meta.url)]) {
  const existing=readFileSync(file,"utf8").split("\n<!-- pose-on-counts -->")[0].trimEnd();
  writeFileSync(file,`${existing}\n\n${countSection}`);
}
for(const [name,before] of Object.entries(hashes))assert.equal(hash(name),before,`${name} must remain unchanged`);
assert.deepEqual(Object.keys(accuracy),keys);
for(const row of Object.values(accuracy))assert.deepEqual(Object.keys(row),["precision","recall","n"]);
console.log(JSON.stringify({primary,shotDetection:{clips:detection.map(({classification,...r})=>r),total},commons:{n:agreement.length,handRawAgreement:rawAgreement("handAgreement"),typeRawAgreement:rawAgreement("typeAgreement"),jointRawAgreement:rawAgreement("exactAgreement"),concreteFull},accuracy},null,2));
console.log("ACCURACY_PASS inputs unchanged, metric totals consistent, six-key JSON schema verified");
