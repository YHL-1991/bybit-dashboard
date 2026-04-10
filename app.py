import asyncio
import json
from pathlib import Path

import uvicorn
import websockets
from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.responses import HTMLResponse
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates
from starlette.requests import Request

import bybit_api
from liquidation import estimate_liquidation_levels
from auto_trader import (
    init_trader, trader_instance, auto_trade_enabled, auto_trade_config,
    trade_log, execute_signal_trade, BybitTrader
)
import auto_trader

app = FastAPI(title="Bybit Futures Dashboard")

BASE_DIR = Path(__file__).parent
app.mount("/static", StaticFiles(directory=BASE_DIR / "static"), name="static")
templates = Jinja2Templates(directory=BASE_DIR / "templates")

SYMBOLS = [
    "BTCUSDT", "ETHUSDT", "SOLUSDT", "XRPUSDT", "DOGEUSDT",
    "BNBUSDT", "ADAUSDT", "AVAXUSDT", "DOTUSDT", "LINKUSDT",
    "SUIUSDT", "PEPEUSDT", "WIFUSDT", "ARBUSDT", "OPUSDT",
    "RAVEUSDT",
]

import time as _time


@app.get("/", response_class=HTMLResponse)
async def index(request: Request):
    return templates.TemplateResponse("index.html", {"request": request, "symbols": SYMBOLS})


@app.get("/api/orderbook/{symbol}")
async def api_orderbook(symbol: str):
    return await bybit_api.get_orderbook(symbol, limit=200)


@app.get("/api/ratio/{symbol}")
async def api_ratio(symbol: str, period: str = "1h"):
    return {"list": await bybit_api.get_long_short_ratio(symbol, period=period)}


@app.get("/api/open-interest/{symbol}")
async def api_open_interest(symbol: str, interval: str = "1h"):
    return {"list": await bybit_api.get_open_interest(symbol, interval=interval)}


@app.get("/api/tickers/{symbol}")
async def api_tickers(symbol: str):
    return await bybit_api.get_tickers(symbol)


@app.get("/api/kline/{symbol}")
async def api_kline(symbol: str, interval: str = "60", limit: int = 500):
    data = await bybit_api.get_kline(symbol, interval=interval, limit=limit)
    candles = []
    for c in reversed(data):
        candles.append({
            "time": int(c[0]) // 1000,
            "open": float(c[1]),
            "high": float(c[2]),
            "low": float(c[3]),
            "close": float(c[4]),
            "volume": float(c[5]),
            "turnover": float(c[6]),
        })
    return candles


@app.get("/api/cme-gaps/{symbol}")
async def api_cme_gaps(symbol: str):
    """CME 갭 감지: 시간봉에서 금요일 21:00 UTC 종가 vs 일요일 22:00 UTC 시가"""
    from datetime import datetime, timezone
    data = await bybit_api.get_kline(symbol, interval="60", limit=500)
    candles = []
    for c in reversed(data):
        ts = int(c[0]) // 1000
        candles.append({"time": ts, "open": float(c[1]), "high": float(c[2]),
                        "low": float(c[3]), "close": float(c[4])})

    # 금요일 21:00 UTC = CME 종장, 일요일 22:00 UTC = CME 개장
    friday_closes = {}
    sunday_opens = {}
    for c in candles:
        dt = datetime.fromtimestamp(c["time"], tz=timezone.utc)
        week_key = dt.isocalendar()[1]  # 주차
        if dt.weekday() == 4 and dt.hour == 21:  # 금요일 21시
            friday_closes[week_key] = c
        if dt.weekday() == 6 and dt.hour == 22:  # 일요일 22시
            sunday_opens[week_key + 1] = c  # 다음주 기준

    gaps = []
    for wk, sun in sunday_opens.items():
        fri = friday_closes.get(wk - 1) or friday_closes.get(wk)
        if not fri:
            continue
        gap = sun["open"] - fri["close"]
        gap_pct = gap / fri["close"] * 100
        if abs(gap_pct) >= 0.05:
            filled = False
            for c in candles:
                if c["time"] > sun["time"]:
                    if gap > 0 and c["low"] <= fri["close"]:
                        filled = True; break
                    if gap < 0 and c["high"] >= fri["close"]:
                        filled = True; break
            gaps.append({
                "time": sun["time"],
                "gap_open": sun["open"],
                "prev_close": fri["close"],
                "gap": round(gap, 2),
                "gap_pct": round(gap_pct, 2),
                "filled": filled,
            })
    return gaps[-5:]  # 최근 5개


@app.get("/api/liquidation/{symbol}")
async def api_liquidation(symbol: str):
    ticker, oi_list, ob = await asyncio.gather(
        bybit_api.get_tickers(symbol),
        bybit_api.get_open_interest(symbol, interval="1h", limit=1),
        bybit_api.get_orderbook(symbol, limit=200),
    )
    current_price = float(ticker.get("lastPrice", 0))
    oi_value = float(oi_list[0]["openInterest"]) * current_price if oi_list else 0
    bids = ob.get("b", [])
    asks = ob.get("a", [])
    return estimate_liquidation_levels(current_price, oi_value, bids, asks)


@app.get("/api/fear-greed")
async def api_fear_greed():
    return await bybit_api.get_fear_greed_index()


@app.get("/api/volume-alerts")
async def api_volume_alerts():
    """
    거래량 급증 감지 (15분봉 기준):
    1) 24h 가격변동 ±15% 이상인 코인
    2) 최근 15분봉 거래량이 직전 5개 15분봉 평균 대비 3배 이상
    3) 24h 가격변동 ±30% 이상이면 무조건 알림
    """
    alerts = []
    try:
        all_tickers = await bybit_api.get_all_tickers()
        # 거래량 급증 감지 대상: 주요 코인 + 변동 큰 코인
        candidates = []
        for t in all_tickers:
            sym = t["symbol"]
            if not sym.endswith("USDT"):
                continue
            price_chg = abs(float(t.get("price24hPcnt", 0)) * 100)
            turnover = float(t.get("turnover24h", 0))
            # 거래대금 100만$ 이상 또는 24h 변동 10% 이상
            if turnover > 1_000_000 or price_chg > 10:
                candidates.append(t)

        # 상위 50개만 15분봉 조회 (API 부하 제한)
        candidates.sort(key=lambda x: float(x.get("turnover24h", 0)), reverse=True)
        check_list = candidates[:50]

        for t in check_list:
            sym = t["symbol"]
            price = float(t.get("lastPrice", 0))
            price_chg = float(t.get("price24hPcnt", 0)) * 100
            turnover = float(t.get("turnover24h", 0))

            alert_reasons = []
            score = 0

            # 1) 24h 가격 급등/급락 (±15% 이상)
            if abs(price_chg) >= 15:
                alert_reasons.append(f"24h {'급등' if price_chg > 0 else '급락'} {price_chg:+.1f}%")
                score += abs(price_chg)

            # 2) 15분봉 거래량 급증 감지
            try:
                kline = await bybit_api.get_kline(sym, interval="15", limit=6)
                if len(kline) >= 6:
                    # kline은 최신이 먼저 → [0]=현재봉, [1~5]=이전 5개봉
                    cur_vol = float(kline[0][5])
                    prev_vols = [float(k[5]) for k in kline[1:6]]
                    avg_prev = sum(prev_vols) / len(prev_vols) if prev_vols else 0
                    if avg_prev > 0 and cur_vol > avg_prev * 3:
                        ratio = cur_vol / avg_prev
                        alert_reasons.append(f"15분봉 거래량 {ratio:.1f}배 급증")
                        score += ratio * 20
            except Exception:
                pass

            # 3) 24h 가격변동 ±30% 이상이면 무조건
            if abs(price_chg) >= 30:
                score += 100

            if score > 0 and alert_reasons:
                alerts.append({
                    "symbol": sym,
                    "reasons": alert_reasons,
                    "score": round(score, 1),
                    "price": price,
                    "price_change": round(price_chg, 2),
                    "volume": float(t.get("volume24h", 0)),
                    "turnover": turnover,
                })
    except Exception:
        pass
    alerts.sort(key=lambda x: x["score"], reverse=True)
    return alerts[:15]


@app.post("/api/trader/connect")
async def api_trader_connect(request: Request):
    """API 키로 트레이더 연결"""
    body = await request.json()
    key = body.get("api_key", "")
    secret = body.get("api_secret", "")
    testnet = body.get("testnet", True)
    if not key or not secret:
        return {"status": "error", "message": "API Key/Secret 필요"}
    trader = init_trader(key, secret, testnet)
    try:
        balance = await trader.get_wallet_balance()
        return {"status": "connected", "testnet": testnet, "balance": balance}
    except Exception as e:
        return {"status": "error", "message": str(e)}


@app.post("/api/trader/toggle")
async def api_trader_toggle(request: Request):
    """자동매매 ON/OFF"""
    body = await request.json()
    auto_trader.auto_trade_enabled = body.get("enabled", False)
    return {"enabled": auto_trader.auto_trade_enabled}


@app.post("/api/trader/config")
async def api_trader_config(request: Request):
    """자동매매 설정 변경"""
    body = await request.json()
    for k, v in body.items():
        if k in auto_trader.auto_trade_config:
            auto_trader.auto_trade_config[k] = v
    return {"config": auto_trader.auto_trade_config}


@app.post("/api/trader/execute")
async def api_trader_execute(request: Request):
    """수동 주문 실행"""
    body = await request.json()
    if not auto_trader.trader_instance:
        return {"status": "error", "message": "트레이더 미연결"}
    return await auto_trader.trader_instance.place_order(**body)


@app.get("/api/trader/positions")
async def api_trader_positions():
    if not auto_trader.trader_instance:
        return {"status": "error", "message": "미연결"}
    return await auto_trader.trader_instance.get_positions()


@app.get("/api/trader/balance")
async def api_trader_balance():
    if not auto_trader.trader_instance:
        return {"status": "error", "message": "미연결"}
    return await auto_trader.trader_instance.get_wallet_balance()


@app.get("/api/trader/log")
async def api_trader_log():
    return {"log": auto_trader.trade_log, "enabled": auto_trader.auto_trade_enabled,
            "config": auto_trader.auto_trade_config}


@app.post("/api/trader/signal-trade")
async def api_signal_trade(request: Request):
    """매매 신호 기반 자동 주문"""
    body = await request.json()
    return await execute_signal_trade(
        body.get("direction", ""),
        body.get("score", 0),
        body.get("price", 0),
    )


@app.websocket("/ws/{symbol}")
async def ws_orderbook(websocket: WebSocket, symbol: str):
    """오더북 + 실시간 청산 내역 프록시"""
    await websocket.accept()
    try:
        async with websockets.connect(bybit_api.WS_URL, ping_interval=20) as bybit_ws:
            await bybit_ws.send(json.dumps({
                "op": "subscribe",
                "args": [f"orderbook.200.{symbol}", f"liquidation.{symbol}", f"publicTrade.{symbol}"]
            }))
            async for msg in bybit_ws:
                data = json.loads(msg)
                if "data" in data:
                    await websocket.send_json(data)
    except (WebSocketDisconnect, Exception):
        pass


if __name__ == "__main__":
    import os
    port = int(os.environ.get("PORT", 8000))
    uvicorn.run("app:app", host="0.0.0.0", port=port, reload=True)
