"""
VELOX 룰 백테스트 — "OI증가 + 고래비율↑ + 가격상승" 검증
────────────────────────────────────────────────────────
과거 데이터(전부 Binance 선물):
  - 가격: /fapi/v1/klines
  - OI:   /futures/data/openInterestHist
  - 고래: /futures/data/topLongShortPositionRatio  (상위 트레이더 포지션 L/S)
  - 개미: /futures/data/globalLongShortAccountRatio (전체 계정 L/S)

룰(LONG 연속형, 강세 추종):
  (a) OI[i] > OI[i-oi_lb]           (신규 자금 유입)
  (b) 고래 L/S[i] >= whale_min       (선택: 상승중 조건)
  (c) close[i] > close[i-px_lb] AND 현재봉 양봉
  (d) 선택: 고래 - 개미 gap >= gap_min

청산: TP +tp% / SL = ATR*atr_mult (오늘 교훈: 노이즈 안쪽 고정손절 금지)
룩어헤드 차단: 진입=다음봉 시가, 청산=이후봉 고저.

벤치마크: 같은 구간 buy&hold. 룰 수익이 이걸 못 넘으면 룰은 무의미.

사용: python3 velox_rule_backtest.py HMSTRUSDT --whale-min 1.2 --tp 2 --atr-mult 1.5
"""
import urllib.request, json, argparse, math

BINANCE = "https://fapi.binance.com"


def _get(path, params):
    q = "&".join(f"{k}={v}" for k, v in params.items())
    r = urllib.request.Request(f"{BINANCE}{path}?{q}", headers={"User-Agent": "Mozilla/5.0"})
    return json.load(urllib.request.urlopen(r, timeout=20))


def hourkey(ms):
    return int(ms) // 1000 // 3600 * 3600


def fetch_klines(sym, interval="1h", limit=1000):
    rows = _get("/fapi/v1/klines", {"symbol": sym, "interval": interval, "limit": limit})
    return [{"t": int(r[0]) // 1000, "open": float(r[1]), "high": float(r[2]),
             "low": float(r[3]), "close": float(r[4]), "vol": float(r[5])} for r in rows]


def fetch_series(path, sym, key, period="1h", limit=500):
    rows = _get(path, {"symbol": sym, "period": period, "limit": limit})
    return {hourkey(r["timestamp"]): float(r[key]) for r in rows}


def calc_atr(d, i, p=14):
    if i < p:
        return None
    trs = []
    for j in range(i - p + 1, i + 1):
        trs.append(max(d[j]["high"] - d[j]["low"],
                       abs(d[j]["high"] - d[j - 1]["close"]),
                       abs(d[j]["low"] - d[j - 1]["close"])))
    return sum(trs) / p


def run(sym, oi_lb, whale_min, whale_rising, px_lb, gap_min,
        tp, atr_mult, sl_fixed, max_hold, fee, lev):
    d = fetch_klines(sym, "1h", 1000)
    oi = fetch_series("/futures/data/openInterestHist", sym, "sumOpenInterest")
    whale = fetch_series("/futures/data/topLongShortPositionRatio", sym, "longShortRatio")
    retail = fetch_series("/futures/data/globalLongShortAccountRatio", sym, "longShortRatio")

    def OI(i): return oi.get(hourkey(d[i]["t"] * 1000))
    def WH(i): return whale.get(hourkey(d[i]["t"] * 1000))
    def RE(i): return retail.get(hourkey(d[i]["t"] * 1000))

    # 데이터 정렬 커버리지
    covered = [i for i in range(len(d)) if OI(i) and WH(i)]
    if not covered:
        print("정렬 데이터 없음(과거 OI/고래 보존기간 초과).")
        return
    start = max(covered[0], max(oi_lb, px_lb, 15))
    end = len(d) - 1

    trades = []
    i = start
    fires = 0
    while i < end:
        oi_now, oi_prev = OI(i), OI(i - oi_lb)
        wh_now = WH(i)
        wh_prev = WH(i - 1)
        if not (oi_now and oi_prev and wh_now):
            i += 1; continue
        cond_oi = oi_now > oi_prev
        cond_whale = wh_now >= whale_min and (not whale_rising or (wh_prev and wh_now > wh_prev))
        cond_px = d[i]["close"] > d[i - px_lb]["close"] and d[i]["close"] > d[i]["open"]
        cond_gap = True
        if gap_min is not None:
            re_now = RE(i)
            cond_gap = re_now is not None and (wh_now - re_now) >= gap_min
        if not (cond_oi and cond_whale and cond_px and cond_gap):
            i += 1; continue
        fires += 1

        entry = d[i + 1]["open"]
        atr = calc_atr(d, i, 14)
        sl_dist = (atr_mult * atr / entry * 100) if (atr_mult and atr) else sl_fixed
        tp_px = entry * (1 + tp / 100)
        sl_px = entry * (1 - sl_dist / 100)
        outcome, ex_i, ex_px = None, None, None
        for j in range(i + 1, min(i + 1 + max_hold, len(d))):
            if d[j]["low"] <= sl_px:
                outcome, ex_px, ex_i = "loss", sl_px, j; break
            if d[j]["high"] >= tp_px:
                outcome, ex_px, ex_i = "win", tp_px, j; break
        if outcome is None:
            ex_i = min(i + max_hold, len(d) - 1); ex_px = d[ex_i]["close"]
            outcome = "win" if ex_px >= entry else "loss"
        pnl = (ex_px - entry) / entry * 100 - fee
        trades.append({"pnl": pnl, "outcome": outcome, "bars": ex_i - i})
        i = ex_i

    # 통계
    span = (d[end]["t"] - d[start]["t"]) / 86400
    bh = (d[end]["close"] - d[start]["close"]) / d[start]["close"] * 100
    print(f"═══ 룰 백테스트 | {sym} 1h | 검증구간 {span:.0f}일 ═══")
    print(f"룰: OI↑({oi_lb}봉) + 고래≥{whale_min}"
          + ("(상승중)" if whale_rising else "")
          + f" + 가격↑({px_lb}봉)양봉"
          + (f" + 고래-개미갭≥{gap_min}" if gap_min is not None else ""))
    print(f"청산: TP +{tp}% / SL " + (f"ATR×{atr_mult}" if atr_mult else f"{sl_fixed}%")
          + f" | 수수료 {fee}%")
    print(f"벤치마크(구간 buy&hold): {bh:+.1f}%")
    print("─" * 46)
    if not trades:
        print(f"신호 발생 {fires}회, 거래 0. 룰이 너무 빡빡하거나 데이터 부족.")
        return
    n = len(trades)
    wins = [t for t in trades if t["pnl"] > 0]
    wr = len(wins) / n * 100
    avg_w = sum(t["pnl"] for t in wins) / len(wins) if wins else 0
    losses = [t for t in trades if t["pnl"] <= 0]
    avg_l = sum(t["pnl"] for t in losses) / len(losses) if losses else 0
    exp = sum(t["pnl"] for t in trades) / n
    gw = sum(t["pnl"] for t in wins); gl = abs(sum(t["pnl"] for t in losses))
    pf = gw / gl if gl else float("inf")
    eq = 1.0; peak = 1.0; mdd = 0.0; blown = False
    for t in trades:
        eq *= (1 + t["pnl"] / 100 * lev)
        if eq <= 0: blown = True; eq = 0; break
        peak = max(peak, eq); mdd = max(mdd, (peak - eq) / peak * 100)
    print(f"거래수        : {n}   (신호 {fires}회 중)")
    print(f"승률          : {wr:.1f}%")
    print(f"평균수익/손실 : +{avg_w:.2f}% / {avg_l:.2f}%")
    print(f"손익비(PF)    : {pf:.2f}")
    print(f"기대손익/거래 : {exp:+.3f}%   ← 0 넘으면 엣지 있음")
    print(f"룰 누적손익(무레버리지 단리): {sum(t['pnl'] for t in trades):+.1f}%  vs buy&hold {bh:+.1f}%")
    print(f"레버리지 {lev}x: " + ("★파산★" if blown else f"{eq:.2f}배  MDD {mdd:.1f}%"))


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("symbol")
    ap.add_argument("--oi-lb", type=int, default=3)
    ap.add_argument("--whale-min", type=float, default=1.2)
    ap.add_argument("--whale-rising", action="store_true")
    ap.add_argument("--px-lb", type=int, default=3)
    ap.add_argument("--gap-min", type=float, default=None)
    ap.add_argument("--tp", type=float, default=2.0)
    ap.add_argument("--atr-mult", type=float, default=1.5)
    ap.add_argument("--sl-fixed", type=float, default=1.0)
    ap.add_argument("--max-hold", type=int, default=48)
    ap.add_argument("--fee", type=float, default=0.11)
    ap.add_argument("--lev", type=float, default=5.0)
    a = ap.parse_args()
    run(a.symbol.upper(), a.oi_lb, a.whale_min, a.whale_rising, a.px_lb,
        a.gap_min, a.tp, a.atr_mult, a.sl_fixed, a.max_hold, a.fee, a.lev)
