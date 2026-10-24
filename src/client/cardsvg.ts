// カードの絵．色は CSS の currentColor に従う（レベルの色は CSS の .lv0〜.lv3）
//   右上の丸：取得コスト　左上の帯：レベル　右下：排除コスト

import { CARDS, CardKind } from '../engine/cards';

export function cardSVG(kind: CardKind, opts: { showName?: boolean } = {}): string {
  const c = CARDS[kind];
  const cut = 12;
  let s = `<svg viewBox="0 0 100 100" xmlns="http://www.w3.org/2000/svg" class="card-svg lv${c.level}" aria-label="${c.name}">`;
  s += `<path d="M${cut},0 L100,0 L100,100 L0,100 L0,${cut} Z" class="card-bg"/>`;
  // レベル（色の帯と数字）
  s += `<path d="M${cut},0 L40,0 L40,14 L0,14 L0,${cut} Z" class="card-level"/>`;
  s += `<text x="24" y="11" font-size="10" text-anchor="middle" font-weight="700" class="card-level-text">Lv${c.level}</text>`;
  // 取得コスト
  s += `<circle cx="86" cy="14" r="9" fill="none" stroke="currentColor" stroke-width="1.6"/>`;
  s += `<text x="86" y="18.5" font-size="13" text-anchor="middle" font-weight="700" fill="currentColor">${c.cost}</text>`;
  // 排除コスト
  s += `<text x="95" y="95" font-size="10" text-anchor="end" fill="currentColor" opacity="0.75">捨${c.removeCost}</text>`;
  for (const [dr, dc] of c.moves) {
    if (dr === 0 && dc === 1) s += `<path d="M78,42 L96,50 L78,58 Z" fill="currentColor"/><rect x="66" y="47" width="13" height="6" fill="currentColor"/>`;
    if (dr === 1 && dc === 0) s += `<path d="M42,78 L50,96 L58,78 Z" fill="currentColor"/><rect x="47" y="66" width="6" height="13" fill="currentColor"/>`;
    if (dr === -1 && dc === 0) s += `<path d="M42,34 L50,18 L58,34 Z" fill="currentColor"/><rect x="47" y="33" width="6" height="11" fill="currentColor"/>`;
  }
  const w = 18, gap = 3, total = c.draw * w + (c.draw - 1) * gap;
  let x0 = 32 - total / 2;
  const cy = 54;
  for (let i = 0; i < c.draw; i++) {
    const cx = x0 + w / 2;
    s += `<path d="M${cx},${cy - 8} L${cx},${cy + 8} M${cx - 8},${cy} L${cx + 8},${cy}" stroke="currentColor" stroke-width="4" stroke-linecap="round"/>`;
    x0 += w + gap;
  }
  if (c.selfRemove) {
    // 使い捨て：右下に小さなゴミ箱．手番の終わりに自分で消える
    s += `<path d="M64,64 L76,64 L74,78 L66,78 Z M62,62 L78,62" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linejoin="round"/>`;
  }
  if (c.bulky) {
    // 粗大ごみ：大きな箱
    s += `<rect x="22" y="32" width="38" height="30" rx="2" fill="none" stroke="currentColor" stroke-width="3" opacity="0.6"/>`
      + `<path d="M22,42 L60,42 M41,32 L41,42" stroke="currentColor" stroke-width="3" opacity="0.6"/>`;
  }
  if (opts.showName !== false) {
    s += `<text x="5" y="95" font-size="10" fill="currentColor" opacity="0.75">${c.name}</text>`;
  }
  return s + `</svg>`;
}

/** カードの効果の説明文 */
export function cardHelp(kind: CardKind): string {
  const c = CARDS[kind];
  const parts: string[] = [];
  const arrows = c.moves.map(([dr, dc]) => ({ '0,1': '→', '1,0': '↓', '-1,0': '↑' } as Record<string, string>)[`${dr},${dc}`]).join('');
  parts.push(arrows ? `矢印 ${arrows}` : '矢印なし（行き止まり）');
  if (c.draw) parts.push(`置いたとき${c.draw}枚引く`);
  if (c.selfRemove) parts.push('使い捨て：手番の終わりに，排除コストを払わずに排除される');
  return `${c.name}（レベル${c.level}・取得${c.cost}・排除${c.removeCost}）：${parts.join('，')}`;
}
