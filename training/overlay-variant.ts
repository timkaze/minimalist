// 実験用：タイルの値を環境変数で一時的に変える（対戦・学習データ作成のどのプロセスにも効くよう，overlay-arena.ts と overlay-gen.ts が読み込む）
//   OV_TILES='{"BIGDAY":{"cost":6},"ROOMBA":{"cost":6,"buyNeed":2}}'
import { OKind, TILES, TileDef } from '../src/overlay/tiles';

const raw = process.env.OV_TILES;
if (raw) {
  for (const [k, v] of Object.entries(JSON.parse(raw) as Record<string, Partial<TileDef>>)) {
    if (!TILES[k as OKind]) throw new Error(`OV_TILES：タイル ${k} はありません`);
    Object.assign(TILES[k as OKind], v);
  }
}
