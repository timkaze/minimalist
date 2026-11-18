#!/usr/bin/env bash
# ルールやタイルを変えた版を1つ調べる：V を学習し直し → 強いボット同士の指標 → まとめて買わない条件の勝率
#   training/overlay-exp.sh 名前 [反復数=4] [1反復の試合数=3000]
#   変え方は環境変数で：OV_TILES='{"BIGDAY":{"cost":6}}'（タイルの値） RULES='{"favBoard":true}'（ルール） SET='all+BACK,STACK'（市場）
#   INIT=最初の重み（既定 src/overlay/value.json．特徴量が合わなければ名前で対応づける） FULL=1 でタイルごとの狙い撃ちも回す
# 結果は training/overlay-runs/exp_名前/ に出る
set -euo pipefail
cd "$(dirname "$0")/.."
NAME=$1; ITERS=${2:-4}; GAMES=${3:-3000}
RULES=${RULES:-'{}'}; SET=${SET:-all}
PY=${PY:-$HOME/.venvs/dm-sim/bin/python}
[ -s "$HOME/.nvm/nvm.sh" ] && source "$HOME/.nvm/nvm.sh" >/dev/null
OUT=training/overlay-runs/exp_$NAME; mkdir -p "$OUT"
V=$PWD/$OUT/value.json
export RULES SET GEN_SET=$SET
echo "== $NAME: OV_TILES=${OV_TILES:-} RULES=$RULES SET=$SET" | tee "$OUT/log.txt"
$PY training/overlay_fit.py --iters "$ITERS" --games "$GAMES" --eval-games 0 --tag "exp_$NAME" --rules "$RULES" --init "${INIT:-src/overlay/value.json}" --out "$OUT/value_last.json" >> "$OUT/log.txt" 2>&1
$PY training/overlay_fit.py --tag "exp_$NAME" --rules "$RULES" --epochs 40 --eval-games 0 --refit training/overlay-runs/fit_exp_$NAME/data_* --out "$OUT/value.json" >> "$OUT/log.txt" 2>&1
POOL="search?m=$V&obj=win" LABEL="$NAME" OUT="$OUT/metrics.json" npx tsx training/overlay-metrics.ts "${METRIC_GAMES:-2000}" > "$OUT/metrics.md" 2>> "$OUT/log.txt"
PROBE_GROUPS=1 MODEL=$V OBJ=win npx tsx training/overlay-probe.ts 400 > "$OUT/probe.md" 2>> "$OUT/log.txt"
if [ -n "${FULL:-}" ]; then MODEL=$V OBJ=win npx tsx training/overlay-probe.ts 400 > "$OUT/probe_full.md" 2>> "$OUT/log.txt"; fi
echo "== done $NAME" | tee -a "$OUT/log.txt"
