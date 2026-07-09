"""
VELOX 시장 스캐너 — api_volume_alerts 로직 재현 + 신호엔진 결합.
거래량/변동 급증 코인을 추린 뒤 velox_engine으로 방향·타점을 붙여 한 판에 출력.
사용: python3 velox_scan.py [상위N=6]
"""
import sys, json, urllib.request
import velox_engine as ve

def get_all_tickers():
    url = "https://api.bybit.com/v5/market/tickers?category=linear"
    req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
    return json.load(urllib.request.urlopen(req, timeout=15))["result"]["list"]

def scan(topN=6):
    tickers = get_all_tickers()
    cands = []
    for t in tickers:
        sym = t["symbol"]
        if not sym.endswith("USDT"): continue
        try:
            chg = abs(float(t.get("price24hPcnt", 0))*100)
            turn = float(t.get("turnover24h", 0))
        except: continue
        if turn > 1_000_000 or chg > 10:
            cands.append(t)
    cands.sort(key=lambda x: float(x.get("turnover24h", 0)), reverse=True)
    scored = []
    for t in cands[:50]:
        sym = t["symbol"]
        chg = float(t.get("price24hPcnt", 0))*100
        score = 0; reasons = []
        if abs(chg) >= 15:
            reasons.append(f"24h {chg:+.1f}%"); score += abs(chg)
        try:
            k = ve.fetch_klines(sym, "15", 6)
            if len(k) >= 6:
                cur = k[-1]["volume"]; prev = [x["volume"] for x in k[-6:-1]]
                avg = sum(prev)/len(prev) if prev else 0
                if avg > 0 and cur > avg*3:
                    ratio = cur/avg; reasons.append(f"15m거래량 {ratio:.1f}배"); score += ratio*20
        except: pass
        if abs(chg) >= 30: score += 100
        if score > 0 and reasons:
            scored.append({"symbol": sym, "score": round(score, 1), "chg": round(chg, 2), "reasons": reasons})
    scored.sort(key=lambda x: x["score"], reverse=True)
    top = scored[:topN]
    print(f"═══ VELOX 스캔  |  급증 후보 {len(scored)}개 중 상위 {len(top)} ═══\n")
    for c in top:
        sym = c["symbol"]
        try:
            d = ve.fetch_klines(sym, "60")
            sig = ve.generate_signal(d); ent = ve.entry_confluence(d)
        except Exception as e:
            print(f"  {sym}: 신호산출 실패 {e}"); continue
        conflict = ""
        dl = "LONG" in sig["direction"]; el = ent["label"] and "롱" in ent["label"]
        es = ent["label"] and "숏" in ent["label"]
        if (dl and es) or (("SHORT" in sig["direction"]) and el):
            conflict = "  ⚠️방향-타점 충돌"
        tp = "미충족" if not ent["label"] else ent["label"]
        print(f"[{sym}]  스캔점수 {c['score']}  ({', '.join(c['reasons'])})")
        print(f"   현재가 {sig['price']:,.4f}  |  방향 {sig['direction']} (순 {sig['net']:+d})  |  타점 {tp}{conflict}")
        print(f"   진입조건 롱 {ent['longConf']}/8 · 숏 {ent['shortConf']}/8")
        print()

if __name__ == "__main__":
    n = int(sys.argv[1]) if len(sys.argv) > 1 else 6
    scan(n)
