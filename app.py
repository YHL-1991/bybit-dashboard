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
    "RAVEUSDT", "ENJUSDT", "ARIAUSDT", "DRIFTUSDT", "BLESSUSDT", "MYXUSDT",
    "INUSDT", "BIOUSDT", "CHZUSDT", "ORDIUSDT", "BASEDUSDT",
    "SIRENUSDT", "SOONUSDT", "SIGNUSDT", "HIGHUSDT", "PORTALUSDT", "ALICEUSDT",
    "CHIPUSDT", "METUSDT", "SEIUSDT", "HUSDT",
    "BSBUSDT", "KATUSDT", "MOVRUSDT", "SPKUSDT", "ORCAUSDT",
]

STOCKS = [
    ("STK:174900.KQ", "앱클론 (KOSDAQ:174900)"),
    ("STK:TSLA", "테슬라 (NASDAQ:TSLA)"),
    ("STK:005930.KS", "삼성전자 (KRX:005930)"),
    ("STK:006400.KS", "삼성SDI (KRX:006400)"),
    ("STK:005380.KS", "현대차 (KRX:005380)"),
    ("STK:001450.KS", "현대해상 (KRX:001450)"),
    ("STK:009830.KS", "한화솔루션 (KRX:009830)"),
    ("STK:010060.KS", "OCI홀딩스 (KRX:010060)"),
    ("STK:322000.KS", "HD현대에너지솔루션 (KRX:322000)"),
    ("STK:011930.KS", "신성이엔지 (KRX:011930)"),
]

import time as _time
import httpx as _httpx

YAHOO_HEADERS = {"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36"}


_stock_cache: dict = {}


@app.get("/api/stock/chart/{symbol}")
async def api_stock_chart(symbol: str, range: str = "2y", interval: str = "1h"):
    """Yahoo Finance 차트 프록시 (캐시 적용)"""
    now = _time.time()
    key = f"{symbol}|{range}|{interval}"
    # TTL: ticker(2d/1d)=10s, 인트라데이(1m~4h)=30s, 일봉+=120s
    if range == "2d":
        ttl = 10
    elif interval in ("1m", "5m", "15m", "30m", "1h", "4h"):
        ttl = 30
    else:
        ttl = 120

    cached = _stock_cache.get(key)
    if cached and now - cached["ts"] < ttl:
        return cached["data"]

    url = f"https://query1.finance.yahoo.com/v8/finance/chart/{symbol}"
    try:
        async with _httpx.AsyncClient(timeout=15.0, headers=YAHOO_HEADERS, follow_redirects=True) as c:
            r = await c.get(url, params={"range": range, "interval": interval})
            data = r.json()
            # 간단한 LRU: 200개 초과 시 오래된 것 정리
            if len(_stock_cache) > 200:
                oldest = min(_stock_cache, key=lambda k: _stock_cache[k]["ts"])
                _stock_cache.pop(oldest, None)
            _stock_cache[key] = {"data": data, "ts": now}
            return data
    except Exception as e:
        # 실패 시 기존 캐시라도 반환
        if cached:
            return cached["data"]
        return {"error": str(e)}


_kimchi_cache = {"data": None, "ts": 0}
_etherscan_cache = {"data": None, "ts": 0}


@app.get("/api/etherscan")
async def api_etherscan():
    """ETH 온체인 데이터: 가스(Beaconcha.in/Blocknative), 가격(CoinGecko), 블록(RPC), 공급량"""
    now = _time.time()
    if _etherscan_cache["data"] and now - _etherscan_cache["ts"] < 30:
        return _etherscan_cache["data"]

    rpc_endpoints = [
        "https://cloudflare-eth.com",
        "https://eth.llamarpc.com",
        "https://rpc.ankr.com/eth",
    ]

    try:
        async with _httpx.AsyncClient(timeout=10.0, follow_redirects=True, headers={"User-Agent": "Mozilla/5.0"}) as c:
            price_task = c.get("https://api.coingecko.com/api/v3/simple/price",
                  params={"ids":"ethereum,bitcoin","vs_currencies":"usd,btc"})
            coin_task = c.get("https://api.coingecko.com/api/v3/coins/ethereum",
                  params={"localization":"false","tickers":"false","market_data":"true","community_data":"false","developer_data":"false"})
            # Owlracle 무료 가스 API
            gas_task = c.get("https://api.owlracle.info/v4/eth/gas")

            results = await asyncio.gather(
                price_task, coin_task, gas_task,
                return_exceptions=True,
            )
            price_r, coin_r, gas_r = results

            # 블록 번호 - RPC 순차 시도
            block_num = 0
            for rpc in rpc_endpoints:
                try:
                    r = await c.post(rpc, json={
                        "jsonrpc":"2.0","method":"eth_blockNumber","params":[],"id":1
                    })
                    res = r.json().get("result")
                    if res:
                        block_num = int(res, 16)
                        break
                except Exception:
                    continue

            # ── 가스 (Owlracle) ──
            gas = {"safe":0, "propose":0, "fast":0, "base_fee":0}
            try:
                if not isinstance(gas_r, Exception):
                    gj = gas_r.json()
                    speeds = gj.get("speeds", [])
                    base = gj.get("baseFee", 0) or 0
                    if len(speeds) >= 4:
                        gas = {
                            "safe": round(speeds[0].get("gasPrice", 0), 1),
                            "propose": round(speeds[1].get("gasPrice", 0), 1),
                            "fast": round(speeds[3].get("gasPrice", 0), 1),
                            "base_fee": round(base, 2),
                        }
            except Exception:
                pass

            # Fallback: RPC eth_gasPrice
            if gas["propose"] == 0:
                for rpc in rpc_endpoints:
                    try:
                        r = await c.post(rpc, json={
                            "jsonrpc":"2.0","method":"eth_gasPrice","params":[],"id":1
                        })
                        res = r.json().get("result")
                        if res:
                            gwei = int(res, 16) / 1e9
                            gas = {
                                "safe": round(gwei * 0.85, 1),
                                "propose": round(gwei, 1),
                                "fast": round(gwei * 1.2, 1),
                                "base_fee": round(gwei * 0.75, 1),
                            }
                            break
                    except Exception:
                        continue

            # ── ETH 가격 ──
            eth_usd = 0; eth_btc = 0; btc_usd = 0
            try:
                if not isinstance(price_r, Exception):
                    pj = price_r.json()
                    eth_usd = pj.get("ethereum", {}).get("usd", 0) or 0
                    eth_btc = pj.get("ethereum", {}).get("btc", 0) or 0
                    btc_usd = pj.get("bitcoin", {}).get("usd", 0) or 0
            except Exception:
                pass
            # price 실패시 coin 엔드포인트에서 가격 추출
            if eth_usd == 0:
                try:
                    if not isinstance(coin_r, Exception):
                        md = coin_r.json().get("market_data", {})
                        eth_usd = md.get("current_price", {}).get("usd", 0) or 0
                        eth_btc = md.get("current_price", {}).get("btc", 0) or 0
                except Exception:
                    pass

            # ── 공급량 / 마켓캡 ──
            total_supply = 0; market_cap = 0; ath = 0; atl = 0; change_24h = 0
            try:
                if not isinstance(coin_r, Exception):
                    md = coin_r.json().get("market_data", {})
                    total_supply = md.get("circulating_supply", 0) or 0
                    market_cap = md.get("market_cap", {}).get("usd", 0) or 0
                    ath = md.get("ath", {}).get("usd", 0) or 0
                    atl = md.get("atl", {}).get("usd", 0) or 0
                    change_24h = md.get("price_change_percentage_24h", 0) or 0
            except Exception:
                pass

            result = {
                "gas": gas,
                "eth_price_usd": float(eth_usd),
                "eth_btc": float(eth_btc),
                "btc_price_usd": float(btc_usd),
                "block_number": block_num,
                "supply": {
                    "total": round(total_supply, 2),
                    "market_cap": market_cap,
                    "ath_usd": ath,
                    "atl_usd": atl,
                    "change_24h": round(change_24h, 2),
                },
                "ts": int(now),
            }
            _etherscan_cache["data"] = result
            _etherscan_cache["ts"] = now
            return result
    except Exception as e:
        return {"error": str(e), "gas": {}, "eth_price_usd": 0}


# 주요 CEX/DEX 지갑 주소 (Etherscan 라벨 기반)
KNOWN_ADDRESSES = {
    "0x28c6c06298d514db089934071355e5743bf21d60": "Binance 14",
    "0x21a31ee1afc51d94c2efccaa2092ad1028285549": "Binance 15",
    "0xdfd5293d8e347dfe59e90efd55b2956a1343963d": "Binance 16",
    "0x56eddb7aa87536c09ccc2793473599fd21a8b17f": "Binance 17",
    "0x9696f59e4d72e237be84ffd425dcad154bf96976": "Binance 18",
    "0x4d9ff38c0e06c23bdb99e153bee3c0d57b96fa17": "Binance 19",
    "0x564286362092d8e7936f0549571a803b203aaced": "Binance 2",
    "0xf977814e90da44bfa03b6295a0616a897441acec": "Binance 8",
    "0x5a52e96bacdabb82fd05763e25335261b270efcb": "Binance 20",
    "0x73f5ebe90f27b46ea12e5795d16c4b408b19cc6f": "Binance 21",
    "0x8894e0a0c962cb723c1976a4421c95949be2d4e3": "Binance 22",
    "0x07e3a30cdbd3d90f5a3ddd1b3d7e6bdaa81e088b": "Binance 23",
    "0x77696bb39917c91a0c3908d577d5e322095425ca": "Binance 25",
    "0x46340b20830761efd32832a74d7169b29feb9758": "Crypto.com",
    "0x71660c4005ba85c37ccec55d0c4493e66fe775d3": "Coinbase 1",
    "0x503828976d22510aad0201ac7ec88293211d23da": "Coinbase 2",
    "0xddfabcdc4d8ffc6d5beaf154f18b778f892a0740": "Coinbase 3",
    "0x3cd751e6b0078be393132286c442345e5dc49699": "Coinbase 4",
    "0xb5d85cbf7cb3ee0d56b3bb207d5fc4b82f43f511": "Coinbase 5",
    "0xeb2629a2734e272bcc07bda959863f316f4bd4cf": "Coinbase 6",
    "0x77134cbc06cb00b66f4c7e623d5fdbf6777635ec": "Bitget",
    "0xe93381fb4c4f14bda253907b18fad305d799241a": "Bitget 2",
    "0x0d0707963952f2fba59dd06f2b425ace40b492fe": "Gate.io",
    "0x1c4b70a3968436b9a0a9cf5205c787eb81bb558c": "Gate.io 2",
    "0x2910543af39aba0cd09dbb2d50200b3e800a63d2": "Kraken 1",
    "0xe853c56864a2ebe4576a807d26fdc4a0ada51919": "Kraken 2",
    "0x43984d578803891dfa9706bdeee6078d80cfc79e": "Kraken 3",
    "0xa83b11093c858c86321fbc4c20fe82cdbd58e09e": "Kraken 4",
    "0x267be1c1d684f78cb4f6a176c4911b741e4ffdc0": "Kraken 5",
    "0xfa52274dd61e1643d2205169732f29114bc240b3": "Kraken 6",
    "0x53d284357ec70ce289d6d64134dfac8e511c8a3d": "Kraken 7",
    "0x267be1c1d684f78cb4f6a176c4911b741e4ffdc0": "Kraken",
    "0xe92d1a43df510f82c66382592a047d288f85226f": "Bitfinex",
    "0x742d35cc6634c0532925a3b844bc454e4438f44e": "Bitfinex 2",
    "0x876eabf441b2ee5b5b0554fd502a8e0600950cfa": "Bitfinex 3",
    "0xfbb1b73c4f0bda4f67dca266ce6ef42f520fbb98": "Bittrex",
    "0x66f820a414680b5bcda5eeca5dea238543f42054": "OKEx",
    "0x5041ed759dd4afc3a72b8192c143f72f4724081a": "OKEx 2",
    "0x68424b7cf0ea26d9f4bbd8c18a61bb7ea42b74d9": "OKEx 3",
    "0x236f9f97e0e62388479bf9e5ba4889e46b0273c3": "OKEx 4",
    "0xbf94f0ac752c739f623c463b5210a7fb2cbb420b": "OKX Hot",
    "0x2c8fbb630289363ac80705a1a61273f76fd5a161": "OKX",
    "0x15f6de304023226c80ab6d79036d38b91c7cce81": "CoinEx",
    "0x0211f3cedbef3143223d3acf0e589747933e8527": "CoinEx 2",
    "0x2b5634c42055806a59e9107ed44d43c426e58258": "KuCoin 1",
    "0x689c56aef474df92d44a1b70850f808488f9769c": "KuCoin 2",
    "0xa1d8d972560c2f8144af871db508f0b0b10a3fbf": "KuCoin 3",
    "0xd6216fc19db775df9774a6e33526131da7d19a2c": "KuCoin 4",
    "0x88d34944cf554e9cccf4a24292d891f620e9c94f": "Upbit",
    "0xc6cde7c39eb2f0f0095f41570af89efc2c1ea828": "Upbit 2",
    "0x390de26d772d2e2005c6d1d24afc902bae37a4bb": "Upbit 3",
    "0x2d2f460e7e1715971cf9c9616fd3d7c7c237b6bb": "Upbit 4",
    "0x7ef35bb398e0416b81b019fea395219b65c52164": "Bybit",
    "0xf89d7b9c864f589bbf53a82105107622b35eaa40": "Bybit 2",
    "0xee5b5b923ffce93a870b3104b7ca09c3db80047a": "Bybit 3",
    # DEX / DeFi
    "0x1f9840a85d5af5bf1d1762f925bdaddc4201f984": "Uniswap",
    "0x7a250d5630b4cf539739df2c5dacb4c659f2488d": "Uniswap V2 Router",
    "0xe592427a0aece92de3edee1f18e0157c05861564": "Uniswap V3 Router",
    "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48": "USDC",
    "0xdac17f958d2ee523a2206206994597c13d831ec7": "USDT",
}


_eth_flow_cache = {"data": None, "ts": 0}


def _short_addr(addr: str) -> str:
    if not addr or len(addr) < 10:
        return addr or "-"
    return f"{addr[:6]}...{addr[-4:]}"


def _tag_address(addr: str) -> str:
    if not addr:
        return "-"
    lower = addr.lower()
    return KNOWN_ADDRESSES.get(lower, _short_addr(addr))


@app.get("/api/eth-flow")
async def api_eth_flow():
    """ETH 최신 블록 트랜잭션 흐름 + 거래소 입출금 태깅"""
    now = _time.time()
    if _eth_flow_cache["data"] and now - _eth_flow_cache["ts"] < 15:
        return _eth_flow_cache["data"]

    rpc_endpoints = [
        "https://cloudflare-eth.com",
        "https://eth.llamarpc.com",
        "https://rpc.ankr.com/eth",
    ]

    try:
        block_data = None
        async with _httpx.AsyncClient(timeout=10.0) as c:
            for rpc in rpc_endpoints:
                try:
                    r = await c.post(rpc, json={
                        "jsonrpc": "2.0",
                        "method": "eth_getBlockByNumber",
                        "params": ["latest", True],
                        "id": 1,
                    })
                    j = r.json()
                    if j.get("result"):
                        block_data = j["result"]
                        break
                except Exception:
                    continue

        if not block_data:
            return {"error": "all RPC failed", "txs": [], "flow": {}}

        block_num = int(block_data.get("number", "0x0"), 16)
        txs_raw = block_data.get("transactions", [])

        txs = []
        cex_inflow_eth = 0.0
        cex_outflow_eth = 0.0
        total_eth = 0.0
        whale_txs = []

        for t in txs_raw[:50]:  # 최대 50개
            try:
                value_eth = int(t.get("value", "0x0"), 16) / 1e18
            except Exception:
                value_eth = 0
            if value_eth < 0.01:  # 노이즈 제거
                continue

            from_addr = (t.get("from") or "").lower()
            to_addr = (t.get("to") or "").lower()
            from_label = _tag_address(from_addr)
            to_label = _tag_address(to_addr)
            from_is_cex = from_addr in KNOWN_ADDRESSES and "Uniswap" not in from_label and "USD" not in from_label
            to_is_cex = to_addr in KNOWN_ADDRESSES and "Uniswap" not in to_label and "USD" not in to_label

            if to_is_cex and not from_is_cex:
                cex_inflow_eth += value_eth  # 거래소 입금 = 매도 압력
            elif from_is_cex and not to_is_cex:
                cex_outflow_eth += value_eth  # 거래소 출금 = 매수 의사
            total_eth += value_eth

            tx_info = {
                "hash": t.get("hash", ""),
                "block": block_num,
                "from": from_addr,
                "from_label": from_label,
                "to": to_addr,
                "to_label": to_label,
                "value_eth": round(value_eth, 4),
                "is_cex_inflow": to_is_cex and not from_is_cex,
                "is_cex_outflow": from_is_cex and not to_is_cex,
            }
            txs.append(tx_info)
            if value_eth >= 100:
                whale_txs.append(tx_info)

        # 최신순 + 큰 금액 우선
        txs.sort(key=lambda x: x["value_eth"], reverse=True)
        result = {
            "block_number": block_num,
            "timestamp": int(block_data.get("timestamp", "0x0"), 16),
            "total_txs": len(txs_raw),
            "shown_txs": len(txs),
            "txs": txs[:15],  # 상위 15개만
            "whales": whale_txs[:5],
            "flow": {
                "cex_inflow_eth": round(cex_inflow_eth, 2),
                "cex_outflow_eth": round(cex_outflow_eth, 2),
                "net_flow_eth": round(cex_outflow_eth - cex_inflow_eth, 2),
                "total_eth": round(total_eth, 2),
            },
            "ts": int(now),
        }
        _eth_flow_cache["data"] = result
        _eth_flow_cache["ts"] = now
        return result
    except Exception as e:
        return {"error": str(e), "txs": [], "flow": {}}


@app.get("/api/kimchi-premium")
async def api_kimchi_premium():
    """김치프리미엄: 업비트(KRW) vs Bybit(USD) 가격 차이"""
    now = _time.time()
    if _kimchi_cache["data"] and now - _kimchi_cache["ts"] < 10:
        return _kimchi_cache["data"]
    try:
        async with _httpx.AsyncClient(timeout=10.0) as c:
            # 업비트 시세 + 환율 동시 조회
            upbit_r, fx_r = await asyncio.gather(
                c.get("https://api.upbit.com/v1/ticker", params={
                    "markets": ",".join(f"KRW-{s.replace('USDT','')}" for s in SYMBOLS
                                        if s.replace('USDT','') not in ('BNB','WIF','RAVE','ENJ','ARIA'))
                }),
                c.get("https://cdn.jsdelivr.net/npm/@fawazahmed0/currency-api@latest/v1/currencies/usd.json"),
            )
            upbit = upbit_r.json()
            fx = fx_r.json()
            usd_krw = fx.get("usd", {}).get("krw", 1400)

            result = {"usd_krw": usd_krw, "coins": {}}
            for t in upbit:
                coin = t["market"].replace("KRW-", "")
                krw_price = t["trade_price"]
                usd_equiv = krw_price / usd_krw
                result["coins"][coin] = {
                    "krw": krw_price,
                    "usd_equiv": round(usd_equiv, 4),
                    "change_rate": round(t.get("signed_change_rate", 0) * 100, 2),
                }
            _kimchi_cache["data"] = result
            _kimchi_cache["ts"] = now
            return result
    except Exception as e:
        return {"error": str(e), "usd_krw": 0, "coins": {}}


@app.get("/api/debug")
async def api_debug():
    """API 연결 디버그 - 각 Bybit 도메인 테스트"""
    import httpx as _httpx
    results = {}
    for url in ["https://api.bybit.com", "https://api.bytick.com"]:
        try:
            async with _httpx.AsyncClient(timeout=10.0, headers={"User-Agent": "Mozilla/5.0"}, follow_redirects=True) as c:
                r = await c.get(f"{url}/v5/market/tickers", params={"category": "linear", "symbol": "BTCUSDT"})
                results[url] = {"status": r.status_code, "body_preview": r.text[:300]}
        except Exception as e:
            results[url] = {"error": str(e)}
    return results


@app.get("/", response_class=HTMLResponse)
async def index(request: Request):
    return templates.TemplateResponse("index.html", {"request": request, "symbols": SYMBOLS, "stocks": STOCKS})


@app.get("/api/orderbook/{symbol}")
async def api_orderbook(symbol: str):
    try:
        return await bybit_api.get_orderbook(symbol, limit=200)
    except Exception as e:
        return {"error": str(e), "b": [], "a": []}


@app.get("/api/ratio/{symbol}")
async def api_ratio(symbol: str, period: str = "1h"):
    try:
        return {"list": await bybit_api.get_long_short_ratio(symbol, period=period)}
    except Exception as e:
        return {"list": [], "error": str(e)}


@app.get("/api/open-interest/{symbol}")
async def api_open_interest(symbol: str, interval: str = "1h"):
    try:
        return {"list": await bybit_api.get_open_interest(symbol, interval=interval)}
    except Exception as e:
        return {"list": [], "error": str(e)}


@app.get("/api/tickers/{symbol}")
async def api_tickers(symbol: str):
    try:
        return await bybit_api.get_tickers(symbol)
    except Exception as e:
        return {"error": str(e)}


@app.get("/api/kline/{symbol}")
async def api_kline(symbol: str, interval: str = "60", limit: int = 500):
    try:
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
    except Exception as e:
        return {"error": str(e), "candles": []}


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
    try:
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
    except Exception as e:
        return {"levels": [], "error": str(e)}


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
