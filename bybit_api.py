import httpx
import json
import asyncio
import websockets
from typing import Optional

BASE_URL = "https://api.bybit.com"
WS_URL = "wss://stream.bybit.com/v5/public/linear"
FEAR_GREED_URL = "https://api.alternative.me/fng/?limit=1"

# 공유 httpx 클라이언트 설정
TIMEOUT = httpx.Timeout(15.0, connect=10.0)
HEADERS = {"User-Agent": "BybitDashboard/1.0"}


def _get_client():
    return httpx.AsyncClient(timeout=TIMEOUT, headers=HEADERS)


async def get_orderbook(symbol: str = "BTCUSDT", limit: int = 200) -> dict:
    async with _get_client() as client:
        resp = await client.get(
            f"{BASE_URL}/v5/market/orderbook",
            params={"category": "linear", "symbol": symbol, "limit": limit},
        )
        data = resp.json()
        if data["retCode"] != 0:
            raise Exception(f"Bybit API error: {data['retMsg']}")
        return data["result"]


async def get_long_short_ratio(symbol: str = "BTCUSDT", period: str = "1h", limit: int = 50) -> list:
    async with _get_client() as client:
        resp = await client.get(
            f"{BASE_URL}/v5/market/account-ratio",
            params={"category": "linear", "symbol": symbol, "period": period, "limit": limit},
        )
        data = resp.json()
        if data["retCode"] != 0:
            raise Exception(f"Bybit API error: {data['retMsg']}")
        return data["result"]["list"]


async def get_open_interest(symbol: str = "BTCUSDT", interval: str = "1h", limit: int = 50) -> list:
    async with _get_client() as client:
        resp = await client.get(
            f"{BASE_URL}/v5/market/open-interest",
            params={"category": "linear", "symbol": symbol, "intervalTime": interval, "limit": limit},
        )
        data = resp.json()
        if data["retCode"] != 0:
            raise Exception(f"Bybit API error: {data['retMsg']}")
        return data["result"]["list"]


async def get_tickers(symbol: str = "BTCUSDT") -> dict:
    async with _get_client() as client:
        resp = await client.get(
            f"{BASE_URL}/v5/market/tickers",
            params={"category": "linear", "symbol": symbol},
        )
        data = resp.json()
        if data["retCode"] != 0:
            raise Exception(f"Bybit API error: {data['retMsg']}")
        items = data["result"]["list"]
        return items[0] if items else {}


async def get_kline(symbol: str = "BTCUSDT", interval: str = "60", limit: int = 500) -> list:
    async with _get_client() as client:
        resp = await client.get(
            f"{BASE_URL}/v5/market/kline",
            params={"category": "linear", "symbol": symbol, "interval": interval, "limit": limit},
        )
        data = resp.json()
        if data["retCode"] != 0:
            raise Exception(f"Bybit API error: {data['retMsg']}")
        return data["result"]["list"]


async def get_all_tickers() -> list:
    async with _get_client() as client:
        resp = await client.get(
            f"{BASE_URL}/v5/market/tickers",
            params={"category": "linear"},
        )
        data = resp.json()
        if data["retCode"] != 0:
            raise Exception(f"Bybit API error: {data['retMsg']}")
        return data["result"]["list"]


async def get_fear_greed_index() -> dict:
    try:
        async with _get_client() as client:
            resp = await client.get(FEAR_GREED_URL, timeout=5.0)
            data = resp.json()
            if data.get("data"):
                d = data["data"][0]
                return {"value": int(d["value"]), "classification": d["value_classification"]}
    except Exception:
        pass
    return {"value": 50, "classification": "Neutral"}


async def subscribe_orderbook(symbol: str, callback):
    async with websockets.connect(WS_URL, ping_interval=20) as ws:
        sub_msg = {"op": "subscribe", "args": [f"orderbook.200.{symbol}"]}
        await ws.send(json.dumps(sub_msg))
        async for msg in ws:
            data = json.loads(msg)
            if "data" in data:
                await callback(data)
