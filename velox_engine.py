"""
VELOX 신호엔진 — 파이썬 이식본 (static/app.js generateTradeSignal 충실 재현)
Bybit 실시간 60분봉을 받아 롱/숏 방향·점수·근거·타점(진입조건 충족도)·추천진입가를 산출.

사용:  python3 velox_engine.py BTCUSDT 60
원본 로직: generateTradeSignal + 보조지표/패턴 함수 (app.js)
익절/손절 기본값: TP +2% / SL -1% (auto_trader.py auto_trade_config)  ← "1절익절·욕심금지"
"""
import sys, json, math, urllib.request

# ───────── 데이터 ─────────
def fetch_klines(symbol, interval="60", limit=1000):
    url = (f"https://api.bybit.com/v5/market/kline?category=linear"
           f"&symbol={symbol}&interval={interval}&limit={limit}")
    req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
    data = json.load(urllib.request.urlopen(req, timeout=15))
    if data.get("retCode") != 0:
        raise RuntimeError(f"Bybit error: {data.get('retMsg')}")
    rows = data["result"]["list"]          # 최신이 먼저
    rows = rows[::-1]                       # 오래된→최신 (app.js와 동일)
    return [{"time": int(r[0])//1000, "open": float(r[1]), "high": float(r[2]),
             "low": float(r[3]), "close": float(r[4]), "volume": float(r[5])} for r in rows]

# ───────── 지표 ─────────
def calcSMA(d, p):
    r = []
    for i in range(len(d)):
        if i < p-1: continue
        s = sum(d[j]["close"] for j in range(i-p+1, i+1))
        r.append({"time": d[i]["time"], "value": s/p})
    return r

def calcEMA(arr, p):
    r = []
    if len(arr) < p: return r
    e = sum(arr[:p])/p; r.append(e); k = 2/(p+1)
    for i in range(p, len(arr)):
        e = arr[i]*k + e*(1-k); r.append(e)
    return r

def calcRSI(d, p=14):
    r = []
    if len(d) < p+1: return r
    g = l = 0
    for i in range(1, p+1):
        df = d[i]["close"]-d[i-1]["close"]
        if df > 0: g += df
        else: l -= df
    ag, al = g/p, l/p
    r.append({"time": d[p]["time"], "value": 100 if al == 0 else 100-(100/(1+ag/al))})
    for i in range(p+1, len(d)):
        df = d[i]["close"]-d[i-1]["close"]
        ag = (ag*(p-1)+(df if df > 0 else 0))/p
        al = (al*(p-1)+(-df if df < 0 else 0))/p
        r.append({"time": d[i]["time"], "value": 100 if al == 0 else 100-(100/(1+ag/al))})
    return r

def calcMACD(d, f=12, s=26, sig=9):
    cl = [x["close"] for x in d]
    ef, es = calcEMA(cl, f), calcEMA(cl, s)
    ml = []; o = s-f
    for i in range(len(es)):
        ml.append(ef[i+o]-es[i])
    sl = calcEMA(ml, sig)
    hist = []; si, so = s-1, sig-1
    for i in range(len(sl)):
        idx = si+so+i
        if idx >= len(d): break
        m, sv = ml[i+so], sl[i]
        hist.append({"time": d[idx]["time"], "value": m-sv})
    return {"hist": hist}

def calcCCI(d, p=20):
    if len(d) < p: return None
    last = d[-p:]
    tps = [(c["high"]+c["low"]+c["close"])/3 for c in last]
    mean = sum(tps)/p
    md = sum(abs(x-mean) for x in tps)/p
    return 0 if md == 0 else (tps[-1]-mean)/(0.015*md)

def calcWilliamsR(d, p=14):
    if len(d) < p: return None
    last = d[-p:]
    hh = max(c["high"] for c in last); ll = min(c["low"] for c in last)
    close = d[-1]["close"]
    return -50 if hh == ll else ((hh-close)/(hh-ll))*-100

def calcATR(d, p=14):
    if len(d) < p+1: return None
    trs = []
    for i in range(1, len(d)):
        tr = max(d[i]["high"]-d[i]["low"], abs(d[i]["high"]-d[i-1]["close"]),
                 abs(d[i]["low"]-d[i-1]["close"]))
        trs.append(tr)
    atr = sum(trs[:p])/p
    for i in range(p, len(trs)):
        atr = (atr*(p-1)+trs[i])/p
    return atr

# ───────── 패턴/구조 ─────────
def findPivots(d, l=5, r=5):
    h, lo = [], []
    for i in range(l, len(d)-r):
        ih = il = True
        for j in range(i-l, i+r+1):
            if j == i: continue
            if d[j]["high"] >= d[i]["high"]: ih = False
            if d[j]["low"] <= d[i]["low"]: il = False
        if ih: h.append({"idx": i, "price": d[i]["high"], "time": d[i]["time"]})
        if il: lo.append({"idx": i, "price": d[i]["low"], "time": d[i]["time"]})
    return h, lo

def detectChartPatterns(d):
    p = []
    if len(d) < 30: return p
    highs, lows = findPivots(d, 5, 5)
    price = d[-1]["close"]
    if len(lows) >= 2:
        l1, l2 = lows[-2], lows[-1]
        if abs(l1["price"]-l2["price"])/l1["price"] < 0.02 and 5 <= l2["idx"]-l1["idx"] <= 40:
            p.append(("더블 바텀", "long", 80))
    if len(highs) >= 2:
        h1, h2 = highs[-2], highs[-1]
        if abs(h1["price"]-h2["price"])/h1["price"] < 0.02 and 5 <= h2["idx"]-h1["idx"] <= 40:
            p.append(("더블 톱", "short", 80))
    if len(highs) >= 2 and len(lows) >= 2:
        if highs[-1]["price"] > highs[-2]["price"] and lows[-1]["price"] > lows[-2]["price"]:
            p.append(("HH & HL (상승구조)", "long", 60))
        if highs[-1]["price"] < highs[-2]["price"] and lows[-1]["price"] < lows[-2]["price"]:
            p.append(("LH & LL (하락구조)", "short", 60))
    if len(highs) >= 3 and len(lows) >= 3:
        if abs(highs[-1]["price"]-highs[-3]["price"])/highs[-1]["price"] < 0.01 and lows[-1]["price"] > lows[-3]["price"]:
            p.append(("상승 삼각형", "long", 70))
        if abs(lows[-1]["price"]-lows[-3]["price"])/lows[-1]["price"] < 0.01 and highs[-1]["price"] < highs[-3]["price"]:
            p.append(("하강 삼각형", "short", 70))
    if len(d) >= 20:
        imp = d[-20:-10]; flag = d[-10:]
        impRise = (imp[-1]["close"]-imp[0]["close"])/imp[0]["close"]
        flagDip = (flag[-1]["close"]-flag[0]["close"])/flag[0]["close"]
        if impRise > 0.03 and -0.02 < flagDip < 0: p.append(("불 플래그", "long", 65))
        impFall = (imp[-1]["close"]-imp[0]["close"])/imp[0]["close"]
        flagB = (flag[-1]["close"]-flag[0]["close"])/flag[0]["close"]
        if impFall < -0.03 and 0 < flagB < 0.02: p.append(("베어 플래그", "short", 65))
    if len(d) >= 10:
        seg = d[-10:]; mid = len(seg)//2
        fh, sh = seg[:mid], seg[mid:]
        drop = (fh[-1]["low"]-fh[0]["close"])/fh[0]["close"]
        rise = (sh[-1]["close"]-sh[0]["low"])/sh[0]["low"]
        if drop < -0.03 and rise > 0.03: p.append(("V-반전(강세)", "long", 55))
    if len(d) >= 50:
        pH = max(c["high"] for c in d[-50:-5]); pL = min(c["low"] for c in d[-50:-5])
        if price > pH: p.append(("저항선 돌파", "long", 70))
        if price < pL: p.append(("지지선 붕괴", "short", 70))
    return p

def detectRSIDivergence(d, rsi):
    sig = []
    if len(rsi) < 20: return sig
    lookback = min(30, len(rsi)-1)
    i = len(rsi)-1
    while i >= len(rsi)-lookback and i >= 1:
        t = rsi[i]["time"]
        pIdx = next((k for k, c in enumerate(d) if c["time"] == t), -1)
        if pIdx < 10: i -= 1; continue
        prevP = d[max(0, pIdx-15):pIdx]; prevR = rsi[max(0, i-15):i]
        if prevP and prevR:
            prevLow = min(c["low"] for c in prevP); prevRsiLow = min(r["value"] for r in prevR)
            if d[pIdx]["low"] <= prevLow*1.001 and rsi[i]["value"] > prevRsiLow+2:
                sig.append(("bullish_div", 75)); break
            prevHigh = max(c["high"] for c in prevP); prevRsiHigh = max(r["value"] for r in prevR)
            if d[pIdx]["high"] >= prevHigh*0.999 and rsi[i]["value"] < prevRsiHigh-2:
                sig.append(("bearish_div", 75)); break
        i -= 1
    return sig

def detectLiquiditySweep(d, lookback=20):
    sw = []
    for i in range(lookback, len(d)):
        pH = max(c["high"] for c in d[i-lookback:i]); pL = min(c["low"] for c in d[i-lookback:i])
        if d[i]["high"] > pH and d[i]["close"] < pH and d[i]["close"] < d[i]["open"]:
            sw.append(("bearish_sweep", d[i]["time"]))
        if d[i]["low"] < pL and d[i]["close"] > pL and d[i]["close"] > d[i]["open"]:
            sw.append(("bullish_sweep", d[i]["time"]))
    return sw[-3:]

def detectWyckoff(d):
    if len(d) < 25: return []
    sig = []
    volMA = sum(c["volume"] for c in d[-20:])/20
    spreadMA = sum(c["high"]-c["low"] for c in d[-20:])/20
    last = d[-1]; spread = last["high"]-last["low"]
    cp = (last["close"]-last["low"])/max(spread, 0.0001)
    if last["volume"] > volMA*1.5 and spread < spreadMA*0.7 and cp > 0.7:
        sig.append(("wyckoff_spring", 60))
    if last["volume"] > volMA*1.5 and spread < spreadMA*0.7 and cp < 0.3:
        sig.append(("wyckoff_upthrust", 60))
    return sig

def detectFVG(d):
    f = []
    for i in range(2, len(d)):
        if d[i]["low"] > d[i-2]["high"]:
            f.append(("bullish_fvg", d[i]["low"], d[i-2]["high"]))
        if d[i]["high"] < d[i-2]["low"]:
            f.append(("bearish_fvg", d[i-2]["low"], d[i]["high"]))
    return f[-3:]

# ───────── 추천 진입가(ATR) ─────────
def predictPriceRange(d, horizon=6):
    if len(d) < 30: return None
    price = d[-1]["close"]; atr = calcATR(d, 14)
    if not atr: return None
    chg = []
    for i in range(max(1, len(d)-10), len(d)):
        if d[i-1]["close"] > 0: chg.append((d[i]["close"]-d[i-1]["close"])/d[i-1]["close"])
    avgMom = sum(chg)/len(chg) if chg else 0
    ema20 = calcEMA([x["close"] for x in d], 20); dirBias = 0
    if len(ema20) >= 10 and ema20[-10] > 0:
        dirBias = (ema20[-1]-ema20[-10])/ema20[-10]
    projShift = (avgMom+dirBias)/2*horizon*0.6
    center = price*(1+projShift); volBand = atr*math.sqrt(horizon)
    totalMag = abs(avgMom)+abs(dirBias); upProb = 50
    if totalMag > 0:
        bull = (max(0, avgMom)+max(0, dirBias))/(totalMag+0.0001)
        upProb = round(50+(bull-0.5)*60)
    upProb = max(20, min(80, upProb))
    return {"center": center, "upper": center+volBand, "lower": center-volBand,
            "upProb": upProb, "atr": atr, "price": price}

# ───────── 메인 신호 ─────────
def generate_signal(d):
    price = d[-1]["close"]
    longS = shortS = 0; reasons = []
    for name, typ, st in detectChartPatterns(d):
        if typ == "long": longS += st
        else: shortS += st
        reasons.append(f"[{'L' if typ=='long' else 'S'}] {name} +{st}")
    rsi = calcRSI(d, 14)
    if rsi:
        rv = rsi[-1]["value"]
        if rv < 30: longS += 40; reasons.append(f"RSI 과매도({rv:.0f}) +40L")
        elif rv < 40: longS += 15; reasons.append(f"RSI 약세({rv:.0f}) +15L")
        elif rv > 70: shortS += 40; reasons.append(f"RSI 과매수({rv:.0f}) +40S")
        elif rv > 60: shortS += 15; reasons.append(f"RSI 과열({rv:.0f}) +15S")
    macd = calcMACD(d)
    if len(macd["hist"]) >= 2:
        h1, h2 = macd["hist"][-2]["value"], macd["hist"][-1]["value"]
        if h1 < 0 and h2 > 0: longS += 50; reasons.append("MACD 골든크로스 +50L")
        if h1 > 0 and h2 < 0: shortS += 50; reasons.append("MACD 데드크로스 +50S")
        if h2 > 0 and h2 > h1: longS += 10; reasons.append("MACD 히스토그램↑ +10L")
        if h2 < 0 and h2 < h1: shortS += 10; reasons.append("MACD 히스토그램↓ +10S")
    ma7, ma20, ma100 = calcSMA(d, 7), calcSMA(d, 20), calcSMA(d, 100)
    if ma7 and ma20 and ma100:
        m7, m20, m100 = ma7[-1]["value"], ma20[-1]["value"], ma100[-1]["value"]
        if price > m7 > m20 > m100: longS += 30; reasons.append("MA 정배열 +30L")
        if price < m7 < m20 < m100: shortS += 30; reasons.append("MA 역배열 +30S")
    if len(d) >= 20:
        avgVol = sum(c["volume"] for c in d[-20:-1])/19; lastVol = d[-1]["volume"]
        if lastVol > avgVol*1.5:
            if d[-1]["close"] > d[-1]["open"]: longS += 20; reasons.append("거래량급증+양봉 +20L")
            else: shortS += 20; reasons.append("거래량급증+음봉 +20S")
    cci = calcCCI(d, 20)
    if cci is not None:
        if cci < -100: longS += 15; reasons.append("CCI 과매도 +15L")
        if cci > 100: shortS += 15; reasons.append("CCI 과매수 +15S")
    wr = calcWilliamsR(d, 14)
    if wr is not None:
        if wr < -80: longS += 15; reasons.append("W%R 과매도 +15L")
        if wr > -20: shortS += 15; reasons.append("W%R 과매수 +15S")
    for typ, st in detectRSIDivergence(d, rsi):
        if typ == "bullish_div": longS += st; reasons.append("RSI 상승다이버전스 +75L")
        else: shortS += st; reasons.append("RSI 하락다이버전스 +75S")
    sw = detectLiquiditySweep(d, 20)
    if sw:
        typ, t = sw[-1]
        if typ == "bullish_sweep" and d[-1]["time"]-t < 86400*3:
            longS += 50; reasons.append("저점 유동성스윕 +50L")
        if typ == "bearish_sweep" and d[-1]["time"]-t < 86400*3:
            shortS += 50; reasons.append("고점 유동성스윕 +50S")
    for typ, st in detectWyckoff(d):
        if typ == "wyckoff_spring": longS += st; reasons.append("와이코프 스프링 +60L")
        else: shortS += st; reasons.append("와이코프 업스러스트 +60S")
    fvg = detectFVG(d)
    if fvg:
        typ, top, bot = fvg[-1]
        if typ == "bullish_fvg" and bot <= price <= top: longS += 40; reasons.append("상승 FVG 진입 +40L")
        if typ == "bearish_fvg" and bot <= price <= top: shortS += 40; reasons.append("하락 FVG 진입 +40S")

    net = longS-shortS
    if net > 50: direction = "LONG 추천"
    elif net < -50: direction = "SHORT 추천"
    elif net > 20: direction = "약한 LONG"
    elif net < -20: direction = "약한 SHORT"
    else: direction = "관망"
    return {"price": price, "long": longS, "short": shortS, "net": net,
            "direction": direction, "reasons": reasons}

# ───────── 타점(최신봉 진입조건 충족도) ─────────
def entry_confluence(d):
    rsi = calcRSI(d, 14); macd = calcMACD(d)
    ma7d, ma20d = calcSMA(d, 7), calcSMA(d, 20)
    c, prev = d[-1], d[-2]
    def at(series, t): return next((x for x in series if x["time"] == t), None)
    ri, riPrev = at(rsi, c["time"]), at(rsi, prev["time"])
    mi, miPrev = at(macd["hist"], c["time"]), at(macd["hist"], prev["time"])
    m7, m20 = at(ma7d, c["time"]), at(ma20d, c["time"])
    body = abs(c["close"]-c["open"])
    lC = sC = 0; ld = []; sd = []
    if ri and riPrev:
        if ri["value"] < 40 and ri["value"] > riPrev["value"]: lC += 1; ld.append("RSI<40 반등")
        if ri["value"] > 60 and ri["value"] < riPrev["value"]: sC += 1; sd.append("RSI>60 하락")
    if c["close"] > c["open"]: lC += 1; ld.append("양봉")
    else: sC += 1; sd.append("음봉")
    if prev["close"] < prev["open"]: lC += 1; ld.append("직전 음봉")
    if prev["close"] > prev["open"]: sC += 1; sd.append("직전 양봉")
    if c["volume"] > prev["volume"]*1.2: lC += 1; sC += 1; ld.append("거래량↑"); sd.append("거래량↑")
    if mi and miPrev:
        if mi["value"] > miPrev["value"]: lC += 1; ld.append("MACD히스토↑")
        if mi["value"] < miPrev["value"]: sC += 1; sd.append("MACD히스토↓")
    if m7:
        if c["close"] > m7["value"]: lC += 1; ld.append("MA7 위")
        if c["close"] < m7["value"]: sC += 1; sd.append("MA7 아래")
    lowerWick = min(c["open"], c["close"])-c["low"]; upperWick = c["high"]-max(c["open"], c["close"])
    if lowerWick > body*1.5 and c["close"] > c["open"]: lC += 1; ld.append("해머형 아래꼬리")
    if upperWick > body*1.5 and c["close"] < c["open"]: sC += 1; sd.append("슈팅스타 위꼬리")
    if m20:
        if c["low"] < m20["value"] and c["close"] > m20["value"]: lC += 1; ld.append("MA20 지지반등")
        if c["high"] > m20["value"] and c["close"] < m20["value"]: sC += 1; sd.append("MA20 저항거부")
    label = None
    if lC >= 4 and sC < 3: label = "강롱 타점" if lC >= 5 else "롱 타점"
    elif sC >= 4 and lC < 3: label = "강숏 타점" if sC >= 5 else "숏 타점"
    return {"longConf": lC, "shortConf": sC, "label": label,
            "longDetail": ld, "shortDetail": sd}

def run(symbol, interval="60"):
    d = fetch_klines(symbol, interval)
    sig = generate_signal(d)
    ent = entry_confluence(d)
    pr = predictPriceRange(d, 6)
    price = sig["price"]
    # 방향 기준 TP/SL (TP +2% / SL -1%)
    long_tp, long_sl = price*1.02, price*0.99
    short_tp, short_sl = price*0.98, price*1.01
    print(f"═══ VELOX 신호  |  {symbol}  {interval}m  |  현재가 {price:,.4f} ═══")
    print(f"방향   : {sig['direction']}   (롱 {sig['long']} / 숏 {sig['short']} / 순 {sig['net']:+d})")
    print(f"타점   : 최신봉 롱조건 {ent['longConf']}/8, 숏조건 {ent['shortConf']}/8"
          + (f"  →  ★ {ent['label']}" if ent['label'] else "  →  타점 미충족(관망)"))
    if pr:
        print(f"추천진입 : 눌림목 중심 {pr['lower']:,.4f} ~ {pr['center']:,.4f}  "
              f"(ATR {pr['atr']:,.4f}, 상승확률 {pr['upProb']}%)")
    print(f"익절/손절: LONG시 TP {long_tp:,.4f}(+2%) / SL {long_sl:,.4f}(-1%)   "
          f"SHORT시 TP {short_tp:,.4f}(-2%) / SL {short_sl:,.4f}(+1%)")
    print("근거   :")
    for r in sig["reasons"]:
        print("   -", r)
    if ent["label"]:
        det = ent["longDetail"] if "롱" in ent["label"] else ent["shortDetail"]
        print("타점근거:", ", ".join(det))
    return sig, ent, pr

if __name__ == "__main__":
    sym = sys.argv[1] if len(sys.argv) > 1 else "BTCUSDT"
    itv = sys.argv[2] if len(sys.argv) > 2 else "60"
    run(sym.upper(), itv)
