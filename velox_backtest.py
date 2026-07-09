"""
VELOX 백테스트 하네스 v1
────────────────────────────────────────────────────────
velox_engine.generate_signal(d) 를 과거 봉마다 그대로 재생 →
실제 신호로 진입/청산 시뮬레이션 → 기대값(승률·손익비·기대손익) 측정.

원칙(룩어헤드 차단):
  - 신호는 d[:i+1] 까지만 사용 (현재봉=i).
  - 진입은 신호봉 '다음봉 시가'(d[i+1].open) — 종가에 미리 못 산다.
  - 청산은 진입 이후 봉의 고저로만 판정.
  - 같은 봉에서 TP·SL 동시 도달 시 → SL 우선(보수적).
  - 포지션 겹침 방지: 청산 봉 이후부터 다음 신호 탐색.

한계(정직하게):
  - generate_signal 은 '가격/보조지표'만 쓴다. 대시보드의 고래갭·OI·펀딩·L/S는
    안 들어간다. 즉 이건 '가격 신호' 부분집합의 검증이다. (그 자체로도 충분히 중요)

사용:
  python3 velox_backtest.py HMSTRUSDT 60
  python3 velox_backtest.py HMSTRUSDT 60 --tp 2 --sl 1
  python3 velox_backtest.py HMSTRUSDT 60 --atr-stop 1.5   (SL을 ATR*1.5로)
  python3 velox_backtest.py HMSTRUSDT 60 --weak           (약한 신호도 포함)
  python3 velox_backtest.py HMSTRUSDT 60 --lev 10         (레버리지 자산곡선)
"""
import sys, argparse
from velox_engine import fetch_klines, generate_signal, calcATR


def backtest(d, tp_pct, sl_pct, warmup, mode, max_hold, atr_stop_mult, fee_pct):
    trades = []
    n = len(d)
    i = warmup
    while i < n - 1:
        window = d[:i + 1]
        sig = generate_signal(window)
        direction = sig["direction"]
        side = None
        if mode == "strong":
            if direction == "LONG 추천":
                side = "long"
            elif direction == "SHORT 추천":
                side = "short"
        else:  # weak 포함
            if "LONG" in direction:
                side = "long"
            elif "SHORT" in direction:
                side = "short"
        if side is None:
            i += 1
            continue

        entry = d[i + 1]["open"]
        # 손절폭: 고정% 또는 ATR 배수
        if atr_stop_mult:
            atr = calcATR(window, 14) or 0
            sl_dist = (atr_stop_mult * atr / entry * 100) if entry else sl_pct
        else:
            sl_dist = sl_pct

        if side == "long":
            tp = entry * (1 + tp_pct / 100)
            sl = entry * (1 - sl_dist / 100)
        else:
            tp = entry * (1 - tp_pct / 100)
            sl = entry * (1 + sl_dist / 100)

        outcome = None
        exit_i = None
        exit_price = None
        for j in range(i + 1, min(i + 1 + max_hold, n)):
            hi, lo = d[j]["high"], d[j]["low"]
            if side == "long":
                hit_sl, hit_tp = lo <= sl, hi >= tp
            else:
                hit_sl, hit_tp = hi >= sl, lo <= tp
            if hit_sl:  # 동시도달 포함 → SL 우선
                outcome, exit_price, exit_i = "loss", sl, j
                break
            if hit_tp:
                outcome, exit_price, exit_i = "win", tp, j
                break
        if outcome is None:  # 시간 손절(보유한도 종가)
            exit_i = min(i + max_hold, n - 1)
            exit_price = d[exit_i]["close"]
            if side == "long":
                outcome = "win" if exit_price >= entry else "loss"
            else:
                outcome = "win" if exit_price <= entry else "loss"

        if side == "long":
            pnl = (exit_price - entry) / entry * 100
        else:
            pnl = (entry - exit_price) / entry * 100
        pnl -= fee_pct  # 왕복 수수료

        trades.append({
            "i": i, "side": side, "entry": entry, "exit": exit_price,
            "pnl": pnl, "outcome": outcome, "bars": exit_i - i, "sl_dist": sl_dist,
        })
        i = exit_i  # 청산 이후부터 다음 신호
    return trades


def stats(trades, lev):
    if not trades:
        return "신호/거래 없음."
    n = len(trades)
    wins = [t for t in trades if t["pnl"] > 0]
    losses = [t for t in trades if t["pnl"] <= 0]
    wr = len(wins) / n * 100
    avg_w = sum(t["pnl"] for t in wins) / len(wins) if wins else 0
    avg_l = sum(t["pnl"] for t in losses) / len(losses) if losses else 0
    exp = sum(t["pnl"] for t in trades) / n
    gross_w = sum(t["pnl"] for t in wins)
    gross_l = abs(sum(t["pnl"] for t in losses))
    pf = gross_w / gross_l if gross_l else float("inf")

    # 최대 연속 손실
    mcl = cur = 0
    for t in trades:
        if t["pnl"] <= 0:
            cur += 1; mcl = max(mcl, cur)
        else:
            cur = 0

    # 레버리지 자산곡선 (복리, 청산=자산 -100% 이하면 파산)
    eq = 1.0
    peak = 1.0
    maxdd = 0.0
    blown = False
    for t in trades:
        eq *= (1 + t["pnl"] / 100 * lev)
        if eq <= 0:
            blown = True; eq = 0; break
        peak = max(peak, eq)
        maxdd = max(maxdd, (peak - eq) / peak * 100)
    total_ret = (eq - 1) * 100

    avg_bars = sum(t["bars"] for t in trades) / n
    long_n = sum(1 for t in trades if t["side"] == "long")
    short_n = n - long_n

    out = []
    out.append(f"거래수        : {n}   (롱 {long_n} / 숏 {short_n})")
    out.append(f"승률          : {wr:.1f}%   ({len(wins)}승 {len(losses)}패)")
    out.append(f"평균수익/손실 : +{avg_w:.2f}% / {avg_l:.2f}%   (수수료 반영)")
    out.append(f"손익비(PF)    : {pf:.2f}   (1.0 미만=마이너스 시스템)")
    out.append(f"기대손익/거래 : {exp:+.3f}%   ← 이 한 줄이 시스템의 생사")
    out.append(f"최대연속손실  : {mcl}회")
    out.append(f"평균보유      : {avg_bars:.1f}봉")
    out.append(f"── 레버리지 {lev}x 복리 자산곡선 ──")
    if blown:
        out.append(f"자산          : ★파산(청산)★  중간에 -100% 도달")
    else:
        out.append(f"최종자산      : {eq:.2f}배  (총수익 {total_ret:+.1f}%)")
    out.append(f"최대낙폭(MDD) : {maxdd:.1f}%")
    return "\n".join(out)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("symbol")
    ap.add_argument("interval", nargs="?", default="60")
    ap.add_argument("--tp", type=float, default=2.0)
    ap.add_argument("--sl", type=float, default=1.0)
    ap.add_argument("--atr-stop", type=float, default=None, help="SL을 ATR*배수로 (예: 1.5)")
    ap.add_argument("--weak", action="store_true", help="약한 신호도 포함")
    ap.add_argument("--max-hold", type=int, default=48, help="최대 보유 봉수")
    ap.add_argument("--warmup", type=int, default=200)
    ap.add_argument("--fee", type=float, default=0.11, help="왕복 수수료%%(기본 0.11)")
    ap.add_argument("--lev", type=float, default=10.0)
    ap.add_argument("--limit", type=int, default=1000)
    args = ap.parse_args()

    d = fetch_klines(args.symbol.upper(), args.interval, args.limit)
    atr = calcATR(d, 14) or 0
    atr_pct = atr / d[-1]["close"] * 100 if d[-1]["close"] else 0
    span_days = (d[-1]["time"] - d[0]["time"]) / 86400

    mode = "weak" if args.weak else "strong"
    trades = backtest(d, args.tp, args.sl, args.warmup, mode,
                      args.max_hold, args.atr_stop, args.fee)

    print(f"═══ VELOX 백테스트 | {args.symbol.upper()} {args.interval}m | "
          f"{len(d)}봉 ≈ {span_days:.0f}일 ═══")
    stop_desc = f"ATR×{args.atr_stop}" if args.atr_stop else f"고정 {args.sl}%"
    print(f"규칙: TP +{args.tp}% / SL {stop_desc} | 신호: "
          f"{'추천+약한' if args.weak else '추천만'} | 수수료 {args.fee}%")
    print(f"코인 변동성: ATR {atr_pct:.2f}% / 봉   "
          f"← SL {args.sl}% 고정이면 {'★노이즈 안쪽(손절이 무의미)★' if atr_pct > args.sl else 'OK'}")
    print("─" * 50)
    print(stats(trades, args.lev))


if __name__ == "__main__":
    main()
