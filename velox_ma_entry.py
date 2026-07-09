"""
VELOX 이평선 타점 엔진 — 타점은 무조건 7/15/20/100/200/400 이평선 기준.
- 이평선 배열(정배열/역배열)로 추세 판정
- 눌림목/지지·저항 반등으로 타점 확정
- 방향은 velox_engine.generate_signal과 교차확인
- 익절/손절: TP +2% / SL -1% (나반존자) + 구조적 손절(진입 이평선 이탈) 병기

사용: python3 velox_ma_entry.py BTCUSDT 60      (60=60분봉, D=일봉)
"""
import sys
import velox_engine as ve

MAP = [7, 15, 20, 100, 200, 400]

def sma_last(d, p):
    if len(d) < p:
        return None
    return sum(c["close"] for c in d[-p:]) / p

def sma_series(d, p):
    """직전봉 값도 필요 → 마지막 2개 SMA 반환 (prev, cur)."""
    if len(d) < p + 1:
        return None, (sma_last(d, p) if len(d) >= p else None)
    prev = sum(c["close"] for c in d[-p-1:-1]) / p
    cur = sum(c["close"] for c in d[-p:]) / p
    return prev, cur

def ma_entry(d):
    price = d[-1]["close"]
    c, prev = d[-1], d[-2]
    mas = {}
    slopes = {}
    for p in MAP:
        pr, cu = sma_series(d, p)
        mas[p] = cu
        slopes[p] = (None if (pr is None or cu is None) else ("상승" if cu > pr else "하락"))

    avail = [p for p in MAP if mas[p] is not None]

    # 배열 점수: price>MA7>MA15>MA20>MA100>MA200>MA400 순서 충족 개수
    order = [price] + [mas[p] for p in MAP]
    bull = bear = 0; total = 0
    for i in range(len(order) - 1):
        a, b = order[i], order[i + 1]
        if a is None or b is None:
            continue
        total += 1
        if a > b: bull += 1
        else: bear += 1

    if total and bull >= total - 1: regime = "정배열(강세 추세)"
    elif total and bear >= total - 1: regime = "역배열(약세 추세)"
    else: regime = "혼조(추세 불명확)"

    # 지지(아래 가장 가까운 MA) / 저항(위 가장 가까운 MA)
    below = [(p, mas[p]) for p in avail if mas[p] is not None and mas[p] <= price]
    above = [(p, mas[p]) for p in avail if mas[p] is not None and mas[p] > price]
    support = max(below, key=lambda x: x[1]) if below else None      # price 바로 아래 MA
    resist = min(above, key=lambda x: x[1]) if above else None       # price 바로 위 MA

    # 타점 판정
    verdict = None; entry = None; reason = []
    bull_trend = regime.startswith("정배열")
    bear_trend = regime.startswith("역배열")

    # 롱 타점: 상승추세 + 상승중인 지지 이평선에 눌림목 접근/반등
    if support:
        sp, sv = support
        dist = (price - sv) / sv * 100
        touched_up = (c["low"] <= sv <= c["close"]) and c["close"] > c["open"]  # MA 찍고 반등
        near = 0 <= dist <= 1.5
        if bull_trend and slopes.get(sp) == "상승" and (touched_up or near):
            verdict = f"롱 타점 (MA{sp} 눌림목 지지)"
            entry = sv
            reason.append(f"상승추세 + 상승 MA{sp}({sv:,.4f})에 {'반등 확인' if touched_up else f'근접 {dist:+.2f}%'}")
    # 숏 타점: 하락추세 + 하락중인 저항 이평선에서 거부
    if resist:
        rp, rv = resist
        dist = (rv - price) / price * 100
        touched_dn = (c["high"] >= rv >= c["close"]) and c["close"] < c["open"]  # MA 찍고 거부
        near = 0 <= dist <= 1.5
        if bear_trend and slopes.get(rp) == "하락" and (touched_dn or near):
            verdict = f"숏 타점 (MA{rp} 저항 거부)"
            entry = rv
            reason.append(f"하락추세 + 하락 MA{rp}({rv:,.4f})에서 {'거부 확인' if touched_dn else f'근접 {dist:+.2f}%'}")

    # 이평선 교차(단기 7 vs 중기 20)
    pr7, cu7 = sma_series(d, 7); pr20, cu20 = sma_series(d, 20)
    cross = None
    if None not in (pr7, cu7, pr20, cu20):
        if pr7 <= pr20 and cu7 > cu20: cross = "골든크로스(MA7>MA20)"
        if pr7 >= pr20 and cu7 < cu20: cross = "데드크로스(MA7<MA20)"

    return {"price": price, "mas": mas, "slopes": slopes, "regime": regime,
            "support": support, "resist": resist, "verdict": verdict,
            "entry": entry, "reason": reason, "cross": cross, "avail": avail}

def run(symbol, interval="60"):
    d = ve.fetch_klines(symbol, interval)
    m = ma_entry(d)
    sig = ve.generate_signal(d)
    price = m["price"]
    tf = "일봉" if interval.upper() == "D" else f"{interval}분봉"
    print(f"═══ VELOX 이평선 타점  |  {symbol}  {tf}  |  현재가 {price:,.4f} ═══")
    print(f"방향(신호엔진): {sig['direction']} (순 {sig['net']:+d})")
    print(f"이평선 배열   : {m['regime']}")
    print("이평선 현황   :")
    for p in MAP:
        v = m["mas"][p]
        if v is None:
            print(f"   MA{p:<4}: 데이터부족(캔들 {len(d)}개)")
        else:
            pos = "위" if price >= v else "아래"
            print(f"   MA{p:<4}: {v:,.4f}  (현재가 {pos}, 기울기 {m['slopes'][p]})")
    if m["support"]:
        sp, sv = m["support"]; print(f"가장 가까운 지지: MA{sp} = {sv:,.4f}  ({(price-sv)/sv*100:+.2f}%)")
    if m["resist"]:
        rp, rv = m["resist"]; print(f"가장 가까운 저항: MA{rp} = {rv:,.4f}  ({(rv-price)/price*100:+.2f}%)")
    if m["cross"]:
        print(f"교차신호      : {m['cross']}")
    print("─" * 40)
    if m["verdict"]:
        e = m["entry"]
        is_long = "롱" in m["verdict"]
        tp = e * (1.02 if is_long else 0.98)
        sl_fix = e * (0.99 if is_long else 1.01)
        print(f"★ 타점: {m['verdict']}")
        print(f"   진입가 : {e:,.4f}")
        print(f"   익절(TP +2%) : {tp:,.4f}   |   손절(SL -1%) : {sl_fix:,.4f}  [나반존자]")
        # 구조적 손절 = 진입 이평선 바로 아래/위 다음 이평선
        print(f"   근거: {', '.join(m['reason'])}")
        agree = ("LONG" in sig["direction"] and is_long) or ("SHORT" in sig["direction"] and not is_long)
        print(f"   방향일치: {'✔ 신호엔진과 일치' if agree else '✘ 신호엔진과 불일치 — 관망 권장'}")
    else:
        print("★ 타점: 없음. 이평선 지지/저항 눌림목 조건 미충족 → 대기.")
        if m["support"] and m["resist"]:
            sp, sv = m["support"]; rp, rv = m["resist"]
            print(f"   감시: 위 MA{rp}({rv:,.4f}) 돌파 or 아래 MA{sp}({sv:,.4f}) 지지반등 시 재평가")
    return m, sig

if __name__ == "__main__":
    sym = sys.argv[1] if len(sys.argv) > 1 else "BTCUSDT"
    itv = sys.argv[2] if len(sys.argv) > 2 else "60"
    run(sym.upper(), itv)
