// 探索ボットを名前（search?m=重みのパス&obj=mean|win&b=葉の予算&bonus=TREAT:1.5:1,REST:1:2&ban=ROOMBA,BIGDAY&eps=0.05）から作る（Node 用：重みをファイルから読む）
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { OKind } from '../src/overlay/tiles';
import { OAction, OState } from '../src/overlay/engine';
import { SearchOpts, chooseSearchAction } from '../src/overlay/search';
import { ValueModel } from '../src/overlay/value';

export const DEFAULT_MODEL = fileURLToPath(new URL('../src/overlay/value.json', import.meta.url));
const models = new Map<string, ValueModel>();
export function loadModel(path: string = DEFAULT_MODEL): ValueModel {
  let m = models.get(path);
  if (!m) models.set(path, m = new ValueModel(JSON.parse(readFileSync(path, 'utf8'))));
  return m;
}

export function parseSearchSpec(spec: string, rand?: () => number): SearchOpts {
  const q = new URLSearchParams(spec.includes('?') ? spec.slice(spec.indexOf('?') + 1) : '');
  const o: SearchOpts = { model: loadModel(q.get('m') || process.env.OV_MODEL || DEFAULT_MODEL), objective: q.get('obj') === 'win' ? 'win' : 'mean', rand };
  if (q.get('b')) o.budget = Number(q.get('b'));
  if (q.get('eps')) o.epsBuy = Number(q.get('eps'));
  if (q.get('ban')) o.ban = q.get('ban')!.split(',').filter(Boolean) as OKind[];
  if (q.get('bonus')) {
    o.bonus = {};
    for (const e of q.get('bonus')!.split(',').filter(Boolean)) { const [k, v, cap] = e.split(':'); o.bonus[k as OKind] = { v: Number(v), cap: Number(cap ?? 1) }; }
  }
  return o;
}

export function searchAgentFromSpec(spec: string, rand?: () => number): (s: OState) => OAction {
  const o = parseSearchSpec(spec, rand);
  return s => chooseSearchAction(s, o);
}
