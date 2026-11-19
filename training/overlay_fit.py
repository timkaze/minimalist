#!/usr/bin/env python3
"""オーバーレイ版の評価関数 V を自己対戦で学習する（PyTorch）．

  ~/.venvs/dm-sim/bin/python training/overlay_fit.py --iters 6 --games 3000

流れ（方策反復）：
  0. 既存のボット同士の対戦から最初の V を当てはめる（--init に重みを渡せばそこから）
  1. 探索＋V のボットで自己対戦してデータを作る（training/overlay-gen.ts を並列に）
  2. 直近 --window 回ぶんのデータで V を当てはめ直す
  3. 既存の最強（aiFree）との2人戦で強さを見る
V は「あと何手番で片付け終わるか」の分布（BINS 区間）を出す多層パーセプトロン．重みは JSON にして TypeScript 側（src/overlay/value.ts）で使う．
"""
import argparse, json, os, subprocess, sys, time
from pathlib import Path
import numpy as np
import torch
import torch.nn as nn

ROOT = Path(__file__).resolve().parent.parent
TSX = str(ROOT / 'node_modules/.bin/tsx')
BINS = 40
FEAT_VERSION = 2

# 名前の無い古い重み（版1，特徴量 71 個）の並び
_K1 = 'WANT DOUBT JUNK HES DOWN BR BREATH SWING UP2 RUSH CALM DOWN2 LIGHT DRAG MEMO FREE REST TREAT CLEAN'.split()
_P1 = 'ROOMBA BIGDAY BAG COMPASS KODAWARI'.split()
_M1 = 'DOWN BR BREATH SWING UP2 RUSH CALM DOWN2 LIGHT DRAG MEMO FREE REST TREAT CLEAN'.split() + _P1
V1_NAMES = [f'bag:{k}' for k in _K1] + [f'disc:{k}' for k in _K1] + [f'perm:{k}' for k in _P1] + ['chips', 'removed', 'light', 'own', 'weight', 'bagn'] + [f'stock:{k}' for k in _M1] + ['gacha', 'players']


def adapt(init: Path, names, out: Path) -> Path:
    """特徴量の並びが違う重みを，名前で対応づけて今の並びに直す（新しい特徴量の重みは 0）．自己対戦の最初の方策として使う"""
    j = json.loads(init.read_text())
    old = j.get('names') or V1_NAMES
    if old == names:
        return init
    l0 = j['layers'][0]
    w = np.array(l0['w']).reshape(l0['out'], l0['in'])
    idx = {n: i for i, n in enumerate(old)}
    nw = np.zeros((l0['out'], len(names)))
    for i, n in enumerate(names):
        if n in idx:
            nw[:, i] = w[:, idx[n]]
    l0['in'] = len(names)
    l0['w'] = [round(float(v), 6) for v in nw.reshape(-1)]
    j.update(feat=len(names), names=names, version=FEAT_VERSION)
    out.write_text(json.dumps(j))
    return out


def node_env():
    env = dict(os.environ)
    nvm = Path.home() / '.nvm/versions/node'
    if nvm.exists():
        vs = sorted(nvm.iterdir())
        if vs:
            env['PATH'] = f"{vs[-1] / 'bin'}:{env['PATH']}"
    return env


ENV = node_env()
# 1プロセスが使うメモリの上限（袋が大きくなりすぎた局面で探索が膨らんでも，PC 全体を巻き込まないように）
ENV.setdefault('NODE_OPTIONS', '--max-old-space-size=1200')


def gen(out_dir: Path, mode: str, model, games: int, jobs: int, seed: int, budget: int, rules: str):
    out_dir.mkdir(parents=True, exist_ok=True)
    per = max(1, games // jobs)
    procs = []
    for j in range(jobs):
        env = dict(ENV, GEN_GAMES=str(per), GEN_SEED=str(seed * 1000 + j), GEN_MODE=mode, GEN_OUT=str(out_dir / f'{j}.bin'), GEN_BUDGET=str(budget), GEN_RULES=rules)
        if model:
            env['GEN_MODEL'] = str(model)
        procs.append(subprocess.Popen([TSX, 'training/overlay-gen.ts'], cwd=ROOT, env=env, stdout=subprocess.PIPE, text=True))
    tracks = stuck = 0
    for p in procs:
        out, _ = p.communicate()
        if p.returncode != 0:
            sys.exit('データ作成に失敗')
        r = json.loads(out.strip().splitlines()[-1])
        tracks += r['tracks']
        stuck += r['stuck']
    return stuck / max(1, tracks)


def load(dirs, nfeat):
    parts = [np.fromfile(f, dtype=np.float32).reshape(-1, nfeat + 1) for d in dirs for f in sorted(Path(d).glob('*.bin'))]
    a = np.concatenate(parts)
    return a[:, 1:], a[:, 0].astype(np.int64)


def fit(x, t, hidden: int, epochs: int, device, init=None):
    n = len(x)
    rng = np.random.default_rng(0)
    idx = rng.permutation(n)
    nval = max(1000, n // 20)
    va, tr = idx[:nval], idx[nval:]
    mu, sd = x[tr].mean(0), x[tr].std(0)
    sd[sd < 1e-6] = 1.0
    X = torch.tensor((x - mu) / sd, device=device)
    Y = torch.tensor(np.clip(t, 1, BINS) - 1, device=device)
    net = nn.Sequential(nn.Linear(x.shape[1], hidden), nn.ReLU(), nn.Linear(hidden, hidden), nn.ReLU(), nn.Linear(hidden, BINS)).to(device)
    opt = torch.optim.AdamW(net.parameters(), lr=2e-3, weight_decay=1e-4)
    steps = epochs * (len(tr) // 4096 + 1)
    sched = torch.optim.lr_scheduler.OneCycleLR(opt, max_lr=3e-3, total_steps=steps)
    tr_t, va_t = torch.tensor(tr, device=device), torch.tensor(va, device=device)
    loss_fn = nn.CrossEntropyLoss()
    for ep in range(epochs):
        perm = tr_t[torch.randperm(len(tr_t), device=device)]
        for i in range(0, len(perm), 4096):
            b = perm[i:i + 4096]
            opt.zero_grad()
            loss_fn(net(X[b]), Y[b]).backward()
            opt.step()
            sched.step()
    with torch.no_grad():
        lo = net(X[va_t])
        ce = loss_fn(lo, Y[va_t]).item()
        pm = (torch.softmax(lo, 1) * torch.arange(1, BINS + 1, device=device)).sum(1)
        mae = (pm - (Y[va_t] + 1)).abs().mean().item()
        base = ((Y[va_t] + 1).float() - (Y[tr_t] + 1).float().mean()).abs().mean().item()
    # 入力の標準化を1層目に畳み込む（TypeScript 側は生の特徴量を入れる）
    layers = []
    lin = [m for m in net if isinstance(m, nn.Linear)]
    for i, m in enumerate(lin):
        w, b = m.weight.detach().cpu().numpy().astype(np.float64), m.bias.detach().cpu().numpy().astype(np.float64)
        if i == 0:
            b = b - w @ (mu / sd)
            w = w / sd
        layers.append({'in': w.shape[1], 'out': w.shape[0], 'w': [round(float(v), 6) for v in w.reshape(-1)], 'b': [round(float(v), 6) for v in b]})
    return layers, ce, mae, base


def duel(model: Path, games: int, opp: str, budget: int, rules: str):
    env = dict(ENV, SOLO='1', RULES=rules)
    r = subprocess.run([TSX, 'training/overlay-duel.ts', f'search?m={model}&b={budget}', opp, str(games)], cwd=ROOT, env=env, capture_output=True, text=True)
    return (r.stdout + r.stderr).strip()


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--iters', type=int, default=6)
    ap.add_argument('--games', type=int, default=3000, help='1回の反復で作る試合数')
    ap.add_argument('--jobs', type=int, default=14)
    ap.add_argument('--window', type=int, default=3, help='学習に使う直近の反復の数')
    ap.add_argument('--hidden', type=int, default=64)
    ap.add_argument('--epochs', type=int, default=30)
    ap.add_argument('--budget', type=int, default=200, help='データ作成のときの探索の葉の予算')
    ap.add_argument('--eval-games', type=int, default=400)
    ap.add_argument('--eval-opp', default='aiFree')
    ap.add_argument('--rules', default='{}', help='ルール（JSON）')
    ap.add_argument('--tag', default='default')
    ap.add_argument('--init', default='', help='最初の重み（省略すると既存のボットの対戦から当てはめる）')
    ap.add_argument('--out', default='src/overlay/value.json')
    ap.add_argument('--seed', type=int, default=1)
    ap.add_argument('--adapt', default='', help='この重みを今の特徴量の並びに直して --out に書くだけ')
    ap.add_argument('--refit', nargs='*', default=None, help='自己対戦をせず，指定したデータのフォルダ（data_*）だけで当てはめ直す')
    a = ap.parse_args()

    run = ROOT / 'training/overlay-runs' / f'fit_{a.tag}'
    run.mkdir(parents=True, exist_ok=True)
    device = 'cuda' if torch.cuda.is_available() else 'cpu'
    names = json.loads(subprocess.run([TSX, '-e', "import('./src/overlay/value.ts').then(m => console.log(JSON.stringify(m.featNames())))"], cwd=ROOT, env=ENV, capture_output=True, text=True).stdout.strip())
    nfeat = len(names)
    print(f'特徴量 {nfeat}，装置 {device}，出力 {run}', flush=True)

    def save(layers, path: Path, note: str):
        path.write_text(json.dumps({'version': FEAT_VERSION, 'feat': nfeat, 'bins': BINS, 'names': names, 'rules': json.loads(a.rules), 'note': note, 'layers': layers}))

    if a.adapt:
        (ROOT / a.out).write_text(adapt(Path(a.adapt), names, run / 'value_adapt.json').read_text())
        print(f'保存 {ROOT / a.out}')
        return
    if a.refit is not None:
        # 反復ごとの当てはめは，直近のデータに無い局面（終わらない持ち物など）を忘れて強さがぶれる．最後に広い範囲のデータでまとめて当てはめる
        x, t = load(a.refit, nfeat)
        layers, ce, mae, base = fit(x, t, a.hidden, a.epochs, device)
        model = run / 'value_refit.json'
        save(layers, model, f'refit {a.tag} {len(x)} rows')
        print(f'[refit] データ {len(x)}行  検証 CE {ce:.3f}  手番数の誤差 {mae:.2f}（平均で当てた場合 {base:.2f}）', flush=True)
        if a.eval_games:
            print('    ' + duel(model, a.eval_games, a.eval_opp, max(a.budget, 600), a.rules).replace('\n', '\n    '), flush=True)
        (ROOT / a.out).write_text(model.read_text())
        print(f'保存 {ROOT / a.out}')
        return
    model = adapt(Path(a.init), names, run / 'value_init.json') if a.init else None
    dirs = []
    t0 = time.time()
    for it in range(0 if not model else 1, a.iters + 1):
        d = run / f'data_{it}'
        t1 = time.time()
        stuck = gen(d, 'old' if it == 0 else 'search', model, a.games, a.jobs, a.seed * 100 + it, a.budget, a.rules)
        dirs.append(d)
        use = dirs[-a.window:] if it > 0 else dirs
        if it > 0 and dirs[0].name == 'data_0':
            use = [x for x in use if x.name != 'data_0'] or use
        x, t = load(use, nfeat)
        t2 = time.time()
        layers, ce, mae, base = fit(x, t, a.hidden, a.epochs, device)
        model = run / f'value_{it}.json'
        save(layers, model, f'fit {a.tag} iter {it}')
        t3 = time.time()
        print(f'[{it}] データ {len(x)}行（作成 {t2 - t1:.0f}秒，終わらなかった人 {100 * stuck:.1f}%）学習 {t3 - t2:.0f}秒  検証 CE {ce:.3f}  手番数の誤差 {mae:.2f}（平均で当てた場合 {base:.2f}）', flush=True)
        if a.eval_games:
            print('    ' + duel(model, a.eval_games, a.eval_opp, max(a.budget, 600), a.rules).replace('\n', '\n    '), flush=True)
    out = ROOT / a.out
    out.write_text(model.read_text())
    print(f'保存 {out}（計 {time.time() - t0:.0f}秒）')


if __name__ == '__main__':
    main()
