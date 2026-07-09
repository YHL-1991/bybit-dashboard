"""
VELOX 멀티타임프레임 엔진 (이 방의 메인 도구)
규칙: 일봉이 '방향'을 허가하고, 60분봉이 '타점(방아쇠)'을 당긴다. 둘이 어긋나면 관망.
- 일봉 MA 7/15/20/100/200/400 → 매크로 방향 게이트 (역추세 금지)
- 60분봉 MA 7/15/20 → 눌림목/거부 진입 타점
- 나반존자: TP +2% / SL -1% (60분 진입가 기준)
사용: python3 velox_mtf.py BTCUSDT
"""
import sys
import velox_engine as ve

def smas(d, periods):
    out = {}
    for p in periods:
        if len(d) >= p + 1:
            prev = sum(c["close"] for c in d[-p-1:-1]) / p
            cur = sum(c["close"] for c in d[-p:]) / p
            out[p] = (cur, "상승" if cur > prev else "하락")
        elif len(d) >= p:
            out[p] = (sum(c["close"] for c in d[-p:]) / p, "?")
        else:
            out[p] = (None, None)
    return out

def daily_gate(dd):
    """일봉 방향 게이트. 반환: (allowed, regime, detail)"""
    price = dd[-1]["close"]
    ma = smas(dd, [7, 15, 20, 100, 200, 400])
    macro = [ma[p][0] for p in (100, 200, 400) if ma[p][0] is not None]
    above = sum(1 for v in macro if price > v)
    below = sum(1 for v in macro if price < v)
    short_ma = [ma[p][0] for p in (7, 15, 20) if ma[p][0] is not None]
    short_up = sum(1 for v in short_ma if price > v)
    if macro and above == len(macro):
        allowed, regime = "LONG", "강세(100/200/400 일선 위)"
    elif macro and below == len(macro):
        allowed, regime = "SHORT", "약세(100/200/400 일선 아래)"
    else:
        # 매크로 혼조 → 단기 일선으로 미세 판정하되 '주의'
        if short_up >= 2:
            allowed, regime = "LONG?", f"혼조(매크로 {above}/{len(macro)} 위, 단기 반등)"
        else:
            allowed, regime = "SHORT?", f"혼조(매크로 {above}/{len(macro)} 위, 단기 약세)"
    return allowed, regime, ma

def entry_60m(d, allowed):
    """60분봉 MA7/15/20 기준 타점. daily가 허가한 방향만 방아쇠."""
    price = d[-1]["close"]; c = d[-1]
    ma = smas(d, [7, 15, 20])
    (m7, s7), (m15, s15), (m20, s20) = ma[7], ma[15], ma[20]
    if None in (m7, m15, m20):
        return None
    want_long = allowed.startswith("LONG")
    want_short = allowed.startswith("SHORT")
    trig = None; entry = None; why = []

    if want_long:
        # 상승 눌림목: 상승중인 MA7 또는 MA20에 저점 찍고 종가 회복, 또는 근접
        for p, (mv, sl) in ((7, (m7, s7)), (20, (m20, s20))):
            if sl != "상승":
                continue
            dist = (price - mv) / mv * 100
            touched = c["low"] <= mv <= c["close"] and c["close"] > c["open"]
            if touched or (0 <= dist <= 0.6):
                trig = f"롱 (MA{p} 눌림목 지지)"; entry = mv
                why.append(f"상승 MA{p}({mv:,.4f})에 {'반등확인' if touched else f'근접{dist:+.2f}%'}")
                break
    if want_short and trig is None:
        for p, (mv, sl) in ((7, (m7, s7)), (20, (m20, s20))):
            if sl != "하락":
                continue
            dist = (mv - price) / price * 100
            touched = c["high"] >= mv >= c["close"] and c["close"] < c["open"]
            if touched or (0 <= dist <= 0.6):
                trig = f"숏 (MA{p} 저항 거부)"; entry = mv
                why.append(f"하락 MA{p}({mv:,.4f})에서 {'거부확인' if touched else f'근접{dist:+.2f}%'}")
                break
    return {"ma": ma, "trig": trig, "entry": entry, "why": why, "price": price}

def run(symbol):
    dd = ve.fetch_klines(symbol, "D", 1000)
    hd = ve.fetch_klines(symbol, "60", 1000)
    allowed, regime, dma = daily_gate(dd)
    e = entry_60m(hd, allowed)
    sig = ve.generate_signal(hd)
    price = hd[-1]["close"]
    print(f"═══ VELOX MTF  |  {symbol}  |  현재가 {price:,.4f} ═══")
    print(f"[일봉 방향게이트] 허가방향: {allowed}   |   {regime}")
    dline = "   ".join(f"MA{p} {dma[p][0]:,.2f}({dma[p][1]})" if dma[p][0] else f"MA{p} n/a"
                       for p in (7, 15, 20, 100, 200, 400))
    print("   " + dline)
    print(f"[60분 신호엔진] {sig['direction']} (순 {sig['net']:+d})")
    if e:
        (m7, s7), (m15, s15), (m20, s20) = e["ma"][7], e["ma"][15], e["ma"][20]
        print(f"[60분 이평선] MA7 {m7:,.4f}({s7})  MA15 {m15:,.4f}({s15})  MA20 {m20:,.4f}({s20})")
    print("─" * 46)
    if not e or not e["trig"]:
        wait = "일봉이 " + ("롱 허가" if allowed.startswith("LONG") else "숏 허가" if allowed.startswith("SHORT") else "혼조")
        print(f"★ 결론: 관망.  {wait}이나 60분 타점(눌림목/거부) 미충족.")
        return
    is_long = e["trig"].startswith("롱")
    # 최종 게이트: 일봉 방향과 60분 타점 방향 일치 확인 (혼조 '?'는 경고)
    gate_ok = (allowed == "LONG" and is_long) or (allowed == "SHORT" and not is_long)
    gate_warn = allowed.endswith("?")
    ent = e["entry"]
    tp = ent * (1.02 if is_long else 0.98)
    sl = ent * (0.99 if is_long else 1.01)
    print(f"★ 타점: {e['trig']}")
    print(f"   진입가 {ent:,.4f}  |  TP {tp:,.4f}(+2%)  |  SL {sl:,.4f}(-1%)  [나반존자, 10x]")
    print(f"   근거: {', '.join(e['why'])}")
    if gate_ok:
        print("   판정: ✔ 일봉·60분 방향 일치 — 진입 유효")
    elif gate_warn:
        print("   판정: △ 일봉 매크로 혼조 — 소액/관망 권장")
    else:
        print("   판정: ✘ 일봉과 역방향 — 진입 금지(역추세)")

if __name__ == "__main__":
    sym = sys.argv[1] if len(sys.argv) > 1 else "BTCUSDT"
    run(sym.upper())
