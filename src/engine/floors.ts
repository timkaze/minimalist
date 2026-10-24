// 個人ボード（test ブランチ：レベル版）．
//   縦：行ごとのレベル（上が＋＝物欲，下が−＝捨てたい気持ち）．レベル0の行の左の枠外にスタートがあり，→を持つ
//   横：列ごとの支払える額（右ほど多く払える）
//   マス：.  置ける  #  柱（置けない．カスタムで使う）

export interface Floor {
  name: string;
  label: string;
  rows: number;
  cols: number;
  walls: string[];
  /** 行ごとのレベル（−3〜3） */
  levels: number[];
  /** 列ごとの支払える額 */
  budgets: number[];
  /** スタートのある行（レベル0の最初の行）．スタートは枠の外で，この行の0列目を指す */
  startRow: number;
}

export const LEVEL_RANGE = 3;

export function parseFloor(name: string, label: string, lines: string[], levels: number[], budgets?: number[]): Floor {
  const grid = lines.map(l => l.trim().split(/\s+/));
  const rows = grid.length, cols = grid[0].length;
  const floor: Floor = {
    name, label, rows, cols, walls: [], levels: [...levels],
    budgets: budgets ? [...budgets] : Array.from({ length: cols }, (_, c) => c + 1),
    startRow: levels.indexOf(0),
  };
  if (levels.length !== rows) throw new Error(`${name}: レベルは${rows}個必要です`);
  if (floor.budgets.length !== cols) throw new Error(`${name}: 支払える額は${cols}個必要です`);
  if (floor.startRow < 0) throw new Error(`${name}: レベル0の行が必要です`);
  grid.forEach((row, r) => {
    if (row.length !== cols) throw new Error(`${name}: ${r}行目の列数が違います`);
    row.forEach((tok, c) => {
      if (tok === '#') floor.walls.push(`${r},${c}`);
      else if (tok !== '.') throw new Error(`${name}: 不明な記号 ${tok}`);
    });
  });
  if (floor.walls.includes(`${floor.startRow},0`)) throw new Error(`${name}: スタートの右のマスは柱にできません`);
  return floor;
}

const open = (rows: number, cols: number) => Array.from({ length: rows }, () => Array(cols).fill('.').join(' '));

export const FLOORS: Record<string, Floor> = {
  // 標準：レベル 3,2,2,1,0,−1,−2,−2,−3 の9行 × 支払い1〜8の8列
  standard: parseFloor('standard', '標準（9行×8列）', open(9, 8), [3, 2, 2, 1, 0, -1, -2, -2, -3]),
  // 小さい部屋：レベル2まで．入門・短時間向け
  small: parseFloor('small', '小さい部屋（7行×6列・レベル2まで）', open(7, 6), [2, 2, 1, 0, -1, -2, -2]),
};

/** 画面で選べるおすすめの間取り（先頭が既定） */
export const RECOMMENDED_FLOORS = ['standard', 'small'];

export const DEFAULT_FLOOR = 'standard';

export const isWall = (floor: Floor, key: string) => floor.walls.includes(key);

// ---- カスタムの間取り（テストプレイ用．開始画面で作る） ----

/** カスタムの間取りの中身 */
export interface FloorSpec { rows: string[]; levels: number[]; budgets: number[] }

export const CUSTOM_LIMITS = { minSize: 2, maxRows: 11, maxCols: 10, maxBudget: 12 };

/** 送られてきたカスタムの間取りを確かめて Floor にする．おかしければ理由を投げる */
export function floorFromSpec(spec: unknown): Floor {
  const { minSize, maxRows, maxCols, maxBudget } = CUSTOM_LIMITS;
  const sp = spec as FloorSpec;
  if (!sp || !Array.isArray(sp.rows) || sp.rows.some(r => typeof r !== 'string')) throw new Error('間取りの形式が正しくありません');
  const rows = sp.rows.length, cols = sp.rows[0]?.trim().split(/\s+/).length ?? 0;
  if (rows < minSize || rows > maxRows || cols < minSize || cols > maxCols) {
    throw new Error(`間取りの大きさは${minSize}〜${maxRows}行・${minSize}〜${maxCols}列にしてください`);
  }
  const ints = (v: unknown, n: number, lo: number, hi: number) =>
    Array.isArray(v) && v.length === n && v.every(x => Number.isInteger(x) && x >= lo && x <= hi);
  if (!ints(sp.levels, rows, -LEVEL_RANGE, LEVEL_RANGE)) throw new Error(`レベルは−${LEVEL_RANGE}〜${LEVEL_RANGE}の整数を${rows}個にしてください`);
  if (!ints(sp.budgets, cols, 0, maxBudget)) throw new Error(`支払える額は0〜${maxBudget}の整数を${cols}個にしてください`);
  if (!sp.levels.includes(0)) throw new Error('スタートを置くため，レベル0の行を1つ以上作ってください');
  return parseFloor('custom', 'カスタム', sp.rows, sp.levels, sp.budgets);
}

/** 間取りを FloorSpec に戻す（既存の間取りをもとにカスタムを作るとき） */
export function floorToSpec(f: Floor): FloorSpec {
  const rows: string[] = [];
  for (let r = 0; r < f.rows; r++) {
    rows.push(Array.from({ length: f.cols }, (_, c) => (f.walls.includes(`${r},${c}`) ? '#' : '.')).join(' '));
  }
  return { rows, levels: [...f.levels], budgets: [...f.budgets] };
}
