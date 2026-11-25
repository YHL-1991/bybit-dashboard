#!/usr/bin/env python3
"""
진짜 CME 선물 갭 수집기.
Yahoo Finance 의 CME 비트코인/이더 선물(BTC=F, ETH=F) 시간봉을 받아서,
주말 휴장(금 종장 -> 일 개장) 구간의 실제 갭을 계산해 cme_gaps.json 으로 저장한다.

- 실선물 데이터는 주말에 봉이 아예 없으므로, 캔들 간 시간 간격이 벌어지는 지점이 "진짜 갭"이다.
  (24시간 도는 Bybit 가격으로 흉내 내던 옛 방식 + 서머타임 하드코딩을 완전히 대체한다.)
- GitHub Actions(= GitHub IP)에서 돌린다. Yahoo 는 GitHub IP 는 잘 응답하며,
  갭은 주말에 한 번만 바뀌므로 하루 몇 번만 받으면 충분하다.
- 표준 라이브러리만 사용(외부 pip 설치 불필요).
"""
import json, sys, time, urllib.request, urllib.error, urllib.parse, http.cookiejar
from datetime import datetime, timezone

UA = ("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
      "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36")

# Yahoo 선물 티커 -> 대시보드 심볼
SYMBOLS = {
    "BTC=F": "BTCUSDT",
    "ETH=F": "ETHUSDT",
}

WEEKEND_BREAK_MIN_HOURS = 6     # 일일 유지보수(약 2h)와 주말 휴장(약 49h)을 가르는 경계
MIN_GAP_PCT = 0.05             # 이보다 작은 갭은 무시
MAX_GAPS = 6                   # 심볼당 최근 갭 개수


def _opener():
    cj = http.cookiejar.CookieJar()
    op = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(cj))
    op.addheaders = [("User-Agent", UA), ("Accept", "application/json,text/plain,*/*")]
    return op


def _get(op, url, timeout=20):
    req = urllib.request.Request(url)
    with op.open(req, timeout=timeout) as r:
        return r.read().decode("utf-8", "replace")


def fetch_chart(op, yticker, interval="1h", rng="1mo"):
    """Yahoo v8 chart. 쿠키 핸드셰이크 + 백오프 재시도."""
    enc = urllib.parse.quote(yticker, safe="")
    chart = ("https://query1.finance.yahoo.com/v8/finance/chart/"
             f"{enc}?interval={interval}&range={rng}")
    last_err = None
    for attempt in range(4):
        try:
            if attempt == 0:
                # 쿠키 확보
                try:
                    _get(op, "https://fc.yahoo.com/", timeout=12)
                except Exception:
                    pass
                try:
                    _get(op, f"https://finance.yahoo.com/quote/{enc}", timeout=12)
                except Exception:
                    pass
            raw = _get(op, chart)
            if raw.strip().startswith("Too Many") or not raw.strip():
                raise RuntimeError("429/empty")
            data = json.loads(raw)
            err = data.get("chart", {}).get("error")
            if err:
                raise RuntimeError(f"chart error {err}")
            res = data["chart"]["result"][0]
            ts = res.get("timestamp") or []
            q = res["indicators"]["quote"][0]
            bars = []
            for i, t in enumerate(ts):
                o, h, l, c = q["open"][i], q["high"][i], q["low"][i], q["close"][i]
                if o is None or c is None or h is None or l is None:
                    continue
                bars.append({"time": int(t), "open": float(o), "high": float(h),
                             "low": float(l), "close": float(c)})
            if not bars:
                raise RuntimeError("no bars")
            return bars
        except Exception as e:
            last_err = e
            wait = 5 * (attempt + 1)
            print(f"  [{yticker}] try {attempt+1} failed: {e} -> wait {wait}s", file=sys.stderr)
            time.sleep(wait)
    raise RuntimeError(f"{yticker}: all retries failed ({last_err})")


def compute_gaps(bars, max_gaps=MAX_GAPS):
    """주말 휴장 갭 추출. 금요일 종가 vs 다음 세션(일/월) 시가."""
    bars = sorted((b for b in bars if b.get("open") and b.get("close")),
                  key=lambda b: b["time"])
    gaps = []
    for i in range(1, len(bars)):
        prev, nxt = bars[i - 1], bars[i]
        delta_h = (nxt["time"] - prev["time"]) / 3600.0
        if delta_h <= WEEKEND_BREAK_MIN_HOURS:
            continue  # 일일 유지보수 휴장/정상 봉
        if datetime.fromtimestamp(prev["time"], tz=timezone.utc).weekday() != 4:
            continue  # 금요일 종장만 (공휴일 휴장 등은 제외)
        if prev["close"] == 0:
            continue
        gap = nxt["open"] - prev["close"]
        gap_pct = gap / prev["close"] * 100
        if abs(gap_pct) < MIN_GAP_PCT:
            continue
        filled = False
        for c in bars[i:]:
            if gap > 0 and c["low"] <= prev["close"]:
                filled = True; break
            if gap < 0 and c["high"] >= prev["close"]:
                filled = True; break
        gaps.append({
            "time": nxt["time"],
            "gap_open": round(nxt["open"], 2),
            "prev_close": round(prev["close"], 2),
            "gap": round(gap, 2),
            "gap_pct": round(gap_pct, 2),
            "filled": filled,
        })
    return gaps[-max_gaps:]


def main():
    op = _opener()
    out = {
        "generated_at": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "source": "Yahoo Finance CME futures (BTC=F, ETH=F)",
        "gaps": {},
    }
    errors = {}
    for yt, sym in SYMBOLS.items():
        try:
            bars = fetch_chart(op, yt)
            g = compute_gaps(bars)
            out["gaps"][sym] = g
            print(f"{sym}: {len(bars)} bars, {len(g)} gaps "
                  f"(latest {'filled' if (g and g[-1]['filled']) else 'OPEN' if g else '-'})")
        except Exception as e:
            errors[sym] = str(e)
            out["gaps"][sym] = []
            print(f"{sym}: FAILED {e}", file=sys.stderr)
    if errors:
        out["errors"] = errors
    with open("cme_gaps.json", "w", encoding="utf-8") as f:
        json.dump(out, f, ensure_ascii=False, separators=(",", ":"))
    # 모든 심볼이 실패하면 비정상 종료(갭이 하나라도 있으면 성공)
    if errors and len(errors) == len(SYMBOLS):
        sys.exit(1)


if __name__ == "__main__":
    main()
