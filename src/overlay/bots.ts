// ボットの種類から次の手を決める（画面・部屋のどちらからも使う）
//   search：探索＋評価関数（search.ts・value.json）．value.json は既定のルールで学習したもの（ほかのルールでも動くが，強さは落ちる）
//   それ以外：型ごとの買い方を持つ以前のボット（bot.ts の OPRESETS）

import { OAction, OState, goalNeed } from './engine';
import { OPRESETS, SEARCH_BOT, chooseOverlayAction } from './bot';
import { SearchOpts, chooseSearchAction } from './search';
import { ValueJson, ValueModel } from './value';
import valueJson from './value.json';

let model: ValueModel | null = null;
const opts = new Map<number, SearchOpts>();
/** 探索ボットの設定（budget：1回の判断で読む葉の数の目安．大きいほど強いが遅い） */
function searchOpts(budget: number): SearchOpts {
  let o = opts.get(budget);
  if (!o) {
    model ??= new ValueModel(valueJson as unknown as ValueJson);
    opts.set(budget, o = { model, objective: 'win', budget });
  }
  return o;
}

export function botAction(s: OState, botType: string | undefined, budget = 800): OAction {
  // 目標を達成しないと終われないルールでは，目標を狙えない以前のボットは使わない
  if (botType === SEARCH_BOT || goalNeed(s.rules) > 0) return chooseSearchAction(s, searchOpts(budget));
  return chooseOverlayAction(s, OPRESETS[botType ?? 'light'] ?? OPRESETS.light);
}
