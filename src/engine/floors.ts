// 個人ボードの間取り．
//   S  スタート（左上，→を持つ）
//   .  置けるマス
//   #  柱（ずっと置けない）
//   n  段ボール：排除した枚数の累計が n 以上になると置けるようになる（片付けると床が広がる）
//   G  ゴミ捨て場：ここにカードを置くと捨欲が無制限．Gn なら n 枚排除するまで置けない

export interface Floor {
  name: string;
  label: string;
  rows: number;
  cols: number;
  walls: string[];
  locks: Record<string, number>;
  goal: string;
  /** 行ごとの捨欲の目盛り（省略時は行番号そのまま） */
  rowValues?: number[];
  /** 列ごとの物欲の目盛り（省略時は列番号そのまま） */
  colValues?: number[];
}

/** その行まで届いたときの捨欲 */
export const rowValue = (f: Floor, r: number) => f.rowValues?.[r] ?? r;
/** その列まで届いたときの物欲 */
export const colValue = (f: Floor, c: number) => f.colValues?.[c] ?? c;

export function parseFloor(
  name: string, label: string, lines: string[], scale: { rowValues?: number[]; colValues?: number[] } = {},
): Floor {
  const rows = lines.length;
  const grid = lines.map(l => l.trim().split(/\s+/));
  const cols = grid[0].length;
  const floor: Floor = { name, label, rows, cols, walls: [], locks: {}, goal: `${rows - 1},${cols - 1}` };
  grid.forEach((row, r) => {
    if (row.length !== cols) throw new Error(`${name}: ${r}行目の列数が違います`);
    row.forEach((tok, c) => {
      const key = `${r},${c}`;
      if (tok === '#') floor.walls.push(key);
      else if (/^\d+$/.test(tok)) floor.locks[key] = Number(tok);
      else if (/^G\d*$/.test(tok)) {
        floor.goal = key;
        if (tok.length > 1) floor.locks[key] = Number(tok.slice(1));
      } else if (tok !== '.' && tok !== 'S') throw new Error(`${name}: 不明な記号 ${tok}`);
    });
  });
  if (grid[0][0] !== 'S') throw new Error(`${name}: 左上は S にしてください`);
  if (scale.rowValues) {
    if (scale.rowValues.length !== rows) throw new Error(`${name}: 捨欲の目盛りは${rows}個必要です`);
    floor.rowValues = scale.rowValues;
  }
  if (scale.colValues) {
    if (scale.colValues.length !== cols) throw new Error(`${name}: 物欲の目盛りは${cols}個必要です`);
    floor.colValues = scale.colValues;
  }
  return floor;
}

export type CellState = 'open' | 'wall' | 'locked';

export function cellState(floor: Floor, key: string, removed: number): CellState {
  if (floor.walls.includes(key)) return 'wall';
  const need = floor.locks[key];
  if (need !== undefined && removed < need) return 'locked';
  return 'open';
}

// 実際に効くのは，序盤に届く左上 3×3 の柱の位置と，段ボールが開く枚数（training/floor-lab.ts で確認）．
// 柱を増やしすぎると＋で伸ばす連鎖がふさがれ，「何も買わない」が強くなる．
export const FLOORS: Record<string, Floor> = {
  // ワンルーム：基本．2列目3行目の柱で↓をまっすぐ伸ばせない．4枚で4列目（コスト3が買える），6枚で5列目
  grow: parseFloor('grow', 'ワンルーム（基本）', [
    'S . . 4 6',
    '. . . 4 6',
    '. # . 4 6',
    '4 4 4 # 6',
    '6 6 6 6 G',
  ]),
  // やさしい部屋：左上に柱がないので↓をまっすぐ伸ばせる．短い（入門向け）
  intro: parseFloor('intro', 'やさしい部屋（入門）', [
    'S . . 4 6',
    '. . . 4 6',
    '. . . 4 6',
    '4 4 4 # 6',
    '6 6 6 6 G',
  ]),
  // 狭い部屋：最初は上2行だけ．序盤は捨欲を出しにくく，4枚消すと一気に広がる
  narrow: parseFloor('narrow', '狭い部屋（序盤が苦しい）', [
    'S . . 4 6',
    '. . . 4 6',
    '4 # 4 4 6',
    '4 4 4 # 6',
    '6 6 6 6 G',
  ]),
  // 横長の部屋：右に長い．ゴミ捨て場は遠いが，右へ伸ばす余地が大きい
  wide: parseFloor('wide', '横長の部屋', [
    'S . . 4 6 6',
    '. . . 4 6 6',
    '. # . # 6 6',
    '4 4 4 4 6 G',
  ]),
  // 廊下のある部屋：デッキ構築向け．左下が柱で，下の行へは右に進んでからでないと入れない．
  // 捨欲が上がりにくいので，＋で引いて長くつなげるデッキを組まないと勝てない（training/floor-train.ts で確認）
  hall: parseFloor('hall', '廊下のある部屋（構築向け）', [
    'S . . . 4 6',
    '# . . . 4 6',
    '# # # . 4 6',
    '# # # # 6 6',
    '# # # # 6 G',
  ]),

  // ---- 比較用 ----
  basic: parseFloor('basic', '旧：4×4', [
    'S . . .',
    '. . . .',
    '. . . .',
    '. . . G',
  ]),
};

/** 画面で選べるおすすめの間取り（先頭が既定） */
export const RECOMMENDED_FLOORS = ['grow', 'intro', 'narrow', 'wide', 'hall'];

export const DEFAULT_FLOOR = 'grow';
