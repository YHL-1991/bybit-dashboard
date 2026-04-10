"""
자동매매 엔진
- 테스트넷 / 실거래 모드 지원
- 매매 신호 기반 자동 주문
- 포지션 관리 + 손절/익절
"""

import hmac
import hashlib
import time
import json
import httpx
from typing import Optional

# Bybit API 엔드포인트
MAINNET_URL = "https://api.bybit.com"
TESTNET_URL = "https://api-testnet.bybit.com"


class BybitTrader:
    def __init__(self, api_key: str, api_secret: str, testnet: bool = True):
        self.api_key = api_key
        self.api_secret = api_secret
        self.base_url = TESTNET_URL if testnet else MAINNET_URL
        self.testnet = testnet

    def _sign(self, params: dict) -> dict:
        """API 서명 생성"""
        timestamp = str(int(time.time() * 1000))
        recv_window = "5000"
        param_str = timestamp + self.api_key + recv_window

        if params:
            param_str += json.dumps(params, separators=(',', ':'))

        signature = hmac.new(
            self.api_secret.encode('utf-8'),
            param_str.encode('utf-8'),
            hashlib.sha256
        ).hexdigest()

        return {
            "X-BAPI-API-KEY": self.api_key,
            "X-BAPI-SIGN": signature,
            "X-BAPI-SIGN-TYPE": "2",
            "X-BAPI-TIMESTAMP": timestamp,
            "X-BAPI-RECV-WINDOW": recv_window,
            "Content-Type": "application/json",
        }

    async def _request(self, method: str, path: str, params: dict = None) -> dict:
        headers = self._sign(params or {})
        async with httpx.AsyncClient() as client:
            if method == "GET":
                resp = await client.get(f"{self.base_url}{path}", headers=headers, params=params)
            else:
                resp = await client.post(f"{self.base_url}{path}", headers=headers, json=params)
            return resp.json()

    async def get_wallet_balance(self) -> dict:
        """지갑 잔고 조회"""
        return await self._request("GET", "/v5/account/wallet-balance", {"accountType": "UNIFIED"})

    async def get_positions(self, symbol: str = None) -> dict:
        """포지션 조회"""
        params = {"category": "linear"}
        if symbol:
            params["symbol"] = symbol
        return await self._request("GET", "/v5/position/list", params)

    async def place_order(
        self,
        symbol: str,
        side: str,  # "Buy" or "Sell"
        qty: str,
        order_type: str = "Market",
        price: str = None,
        take_profit: str = None,
        stop_loss: str = None,
        leverage: str = None,
    ) -> dict:
        """주문 실행"""
        # 레버리지 설정
        if leverage:
            await self._request("POST", "/v5/position/set-leverage", {
                "category": "linear",
                "symbol": symbol,
                "buyLeverage": leverage,
                "sellLeverage": leverage,
            })

        params = {
            "category": "linear",
            "symbol": symbol,
            "side": side,
            "orderType": order_type,
            "qty": qty,
        }
        if price and order_type == "Limit":
            params["price"] = price
        if take_profit:
            params["takeProfit"] = take_profit
        if stop_loss:
            params["stopLoss"] = stop_loss

        return await self._request("POST", "/v5/order/create", params)

    async def close_position(self, symbol: str, side: str, qty: str) -> dict:
        """포지션 청산"""
        close_side = "Sell" if side == "Buy" else "Buy"
        return await self.place_order(symbol, close_side, qty, "Market")

    async def cancel_all_orders(self, symbol: str) -> dict:
        """모든 주문 취소"""
        return await self._request("POST", "/v5/order/cancel-all", {
            "category": "linear",
            "symbol": symbol,
        })

    async def get_order_history(self, symbol: str, limit: int = 20) -> dict:
        """주문 내역 조회"""
        return await self._request("GET", "/v5/order/history", {
            "category": "linear",
            "symbol": symbol,
            "limit": str(limit),
        })


# 전역 트레이더 인스턴스
trader_instance: Optional[BybitTrader] = None
auto_trade_enabled = False
auto_trade_config = {
    "symbol": "BTCUSDT",
    "leverage": "10",
    "qty_usdt": "50",  # 주문당 USDT 금액
    "tp_pct": 2.0,     # 익절 %
    "sl_pct": 1.0,     # 손절 %
    "min_score": 100,   # 최소 신호 점수
}
trade_log = []


def init_trader(api_key: str, api_secret: str, testnet: bool = True) -> BybitTrader:
    global trader_instance
    trader_instance = BybitTrader(api_key, api_secret, testnet)
    return trader_instance


async def execute_signal_trade(signal_direction: str, score: int, price: float) -> dict:
    """매매 신호에 따라 자동 주문 실행"""
    global trade_log
    if not trader_instance or not auto_trade_enabled:
        return {"status": "disabled"}

    cfg = auto_trade_config
    if abs(score) < cfg["min_score"]:
        return {"status": "score_too_low", "score": score}

    symbol = cfg["symbol"]
    qty_usdt = float(cfg["qty_usdt"])
    qty = str(round(qty_usdt / price, 6))
    leverage = cfg["leverage"]

    # 익절/손절 가격 계산
    tp_pct = cfg["tp_pct"] / 100
    sl_pct = cfg["sl_pct"] / 100

    if signal_direction == "LONG":
        side = "Buy"
        tp = str(round(price * (1 + tp_pct), 2))
        sl = str(round(price * (1 - sl_pct), 2))
    elif signal_direction == "SHORT":
        side = "Sell"
        tp = str(round(price * (1 - tp_pct), 2))
        sl = str(round(price * (1 + sl_pct), 2))
    else:
        return {"status": "no_signal"}

    try:
        result = await trader_instance.place_order(
            symbol=symbol,
            side=side,
            qty=qty,
            leverage=leverage,
            take_profit=tp,
            stop_loss=sl,
        )

        log_entry = {
            "time": time.strftime("%Y-%m-%d %H:%M:%S"),
            "symbol": symbol,
            "side": side,
            "qty": qty,
            "price": price,
            "tp": tp,
            "sl": sl,
            "score": score,
            "result": result.get("retMsg", "unknown"),
            "testnet": trader_instance.testnet,
        }
        trade_log.append(log_entry)
        if len(trade_log) > 100:
            trade_log = trade_log[-100:]

        return {"status": "executed", "order": log_entry, "response": result}
    except Exception as e:
        return {"status": "error", "message": str(e)}
