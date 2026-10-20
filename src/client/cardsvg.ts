// カードの絵（印刷用 HTML と同じデザイン）．色は CSS の currentColor に従う

import { CARDS, CardKind, RULE } from '../engine/cards';

export function cardSVG(kind: CardKind, opts: { showName?: boolean } = {}): string {
  const c = CARDS[kind];
  const cut = 12;
  let s = `<svg viewBox="0 0 100 100" xmlns="http://www.w3.org/2000/svg" class="card-svg" aria-label="${c.name}">`;
  s += `<path d="M${cut},0 L100,0 L100,100 L0,100 L0,${cut} Z" class="card-bg"/>`;
  s += `<circle cx="86" cy="14" r="9" fill="none" stroke="currentColor" stroke-width="1.6"/>`;
  s += `<text x="86" y="18.5" font-size="13" text-anchor="middle" font-weight="700" fill="currentColor">${c.cost}</text>`;
  for (const [dr, dc] of c.moves) {
    if (dr === 0 && dc === 1) s += `<path d="M78,42 L96,50 L78,58 Z" fill="currentColor"/><rect x="66" y="47" width="13" height="6" fill="currentColor"/>`;
    if (dr === 1 && dc === 0) s += `<path d="M42,78 L50,96 L58,78 Z" fill="currentColor"/><rect x="47" y="66" width="6" height="13" fill="currentColor"/>`;
    // 2マス先：矢じりを2つ重ねる
    if (dr === 0 && dc === 2) s += `<path d="M70,42 L84,50 L70,58 Z M82,42 L96,50 L82,58 Z" fill="currentColor"/><rect x="60" y="47" width="11" height="6" fill="currentColor"/>`;
    if (dr === 2 && dc === 0) s += `<path d="M42,70 L50,84 L58,70 Z M42,82 L50,96 L58,82 Z" fill="currentColor"/><rect x="47" y="60" width="6" height="11" fill="currentColor"/>`;
    // 斜め（右下）
    if (dr === 1 && dc === 1) s += `<path d="M95,95 L80,92 L92,80 Z" fill="currentColor"/><path d="M70,70 L87,87" stroke="currentColor" stroke-width="6"/>`;
  }
  const icons: ('x' | 'p')[] = [...Array(c.x).fill('x'), ...Array(c.draw).fill('p')];
  const w = 18, gap = 3, total = icons.length * w + (icons.length - 1) * gap;
  let x0 = 40 - total / 2;
  const cy = 42;
  for (const ic of icons) {
    const cx = x0 + w / 2;
    if (ic === 'x') {
      s += `<path d="M${cx - 7},${cy - 7} L${cx + 7},${cy + 7} M${cx + 7},${cy - 7} L${cx - 7},${cy + 7}" stroke="currentColor" stroke-width="4" stroke-linecap="round"/>`;
    } else {
      s += `<path d="M${cx},${cy - 8} L${cx},${cy + 8} M${cx - 8},${cy} L${cx + 8},${cy}" stroke="currentColor" stroke-width="4" stroke-linecap="round"/>`;
    }
    x0 += w + gap;
  }
  if (c.goal) {
    s += `<text x="40" y="54" font-size="34" text-anchor="middle" font-weight="700" fill="currentColor">∞</text>`;
  }
  // 試作カードの効果は文字で示す
  const label = c.cutter ? '段ボールにも置ける' : c.bonus ? `排除で${1 + c.bonus}枚分` : c.sell ? `排除で購入力+${c.sell}` : '';
  if (label) s += `<text x="40" y="30" font-size="8" text-anchor="middle" fill="currentColor">${label}</text>`;
  if (c.selfRemove) {
    // 使い捨て：右下に小さなゴミ箱．手番の終わりに自分で消える
    s += `<path d="M62,60 L76,60 L74,76 L64,76 Z M60,58 L78,58" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linejoin="round"/>`;
  }
  if (c.bulky) {
    // 粗大ごみ：大きな箱
    s += `<rect x="22" y="28" width="38" height="30" rx="2" fill="none" stroke="currentColor" stroke-width="3" opacity="0.6"/>`
      + `<path d="M22,38 L60,38 M41,28 L41,38" stroke="currentColor" stroke-width="3" opacity="0.6"/>`;
  }
  if (opts.showName !== false) {
    s += `<text x="7" y="93" font-size="10" fill="currentColor" opacity="0.7">${c.name}</text>`;
  }
  return s + `</svg>`;
}

/** カードの効果の説明文 */
export function cardHelp(kind: CardKind): string {
  const c = CARDS[kind];
  const parts: string[] = [];
  const arrows = c.moves.map(([dr, dc]) => ({ '0,1': '→', '1,0': '↓', '1,1': '↘', '0,2': '⇒（2つ右）', '2,0': '⇓（2つ下）' } as Record<string, string>)[`${dr},${dc}`]).join('');
  parts.push(arrows ? `矢印 ${arrows}` : '矢印なし（行き止まり）');
  if (c.x) parts.push(`排除力+${c.x}`);
  if (c.draw) parts.push(`置いたとき${c.draw}枚引く`);
  if (c.goal) parts.push('置くと排除力無制限（持ち運べるゴミ捨て場）');
  if (c.selfRemove) parts.push('使い捨て：手番の終わりに排除力を使わずに排除される');
  if (c.cutter) parts.push('矢印の先がまだ開いていない段ボールでも置ける');
  if (c.bonus) parts.push(`排除すると${1 + c.bonus}枚分に数える（段ボールが早く開く）`);
  if (c.sell) parts.push(`排除すると，その手番の購入力+${c.sell}`);
  if (c.bulky) parts.push(RULE.bulky === 'double' ? '排除するのに排除力を2使う' : 'ゴミ捨て場かゴミ収集車を置いた手番にしか排除できない');
  return `${c.name}（コスト${c.cost}）：${parts.join('，')}`;
}
