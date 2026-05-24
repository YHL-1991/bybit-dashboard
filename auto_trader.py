"""
자동매매 엔진
- 테스트넷 / 실거래 모드 지원
- 매매 신호 기반 자동 주문
- 포지션 관리 + 손절/익절

⚠️ 안전 설계 노트 (3차 전문가 피드백 반영):
1) 중복발사 방지: 진입 전 기존 포지션 확인 + orderLinkId 멱등키 + 신호당 쿨다운.
   (서명이 동작하는 순간 가장 위험해지는 부분 — 통제 안 되는 자동 진입 루프 차단)
2) Bybit V5 서명: POST는 compact JSON 바이트를 그대로 전송하고 그 바이트를 서명,
   GET은 정렬된 쿼리스트링을 서명. (httpx json= 의 공백 때문에 서명 불일치 나던 버그 수정)
3) 종목별 tickSize/qtyStep 라운딩: 알트/저가코인 주문 거부·TP/SL 0.00 무효화 방지.

주의: 프로덕션(Railway)에서는 api.bybit.com이 CloudFront로 차단될 수 있어
서명을 고쳐도 서버측 주문이 안 나갈 수 있음. 실거래 전 반드시 응답 retCode 확인.

[ATR/진입가 로직 위치에 대한 메모]
'추천 진입가'(ATR 기반 동적 눌림목) 산출은 백엔드가 아니라 프론트엔드
(static/app.js의 renderTradeRecommendation)에 구현돼 있다. 이유:
 (1) ATR 계산에 필요한 kline을 받으려면 Bybit 접근이 필요한데, 프로덕션 서버는
     CloudFront로 차단되어 못 받는다. 반면 사용자 브라우저(클라이언트)는 직접 받는다.
 (2) 이 엔진은 'Market' 주문으로 현재가에 진입하는 구조라, 진입가를 미리 계산해
     지정가로 거는 방식이 아니다(추천 진입가는 사용자의 수동 판단 보조용).
즉 백엔드에 ATR 진입식을 넣는 것은 prod에서 동작 불가 + 구조상 불필요하다.
"""

import hmac
import hashlib
import time
import json
import urllib.parse
from decimal import Decimal, ROUND_DOWN, ROUND_HALF_UP
import httpx
from typing import Optional

# Bybit API 엔드포인트
MAINNET_URL = "https://api.bybit.com"
TESTNET_URL = "https://api-testnet.bybit.com"


def _round_step(value: float, step: str, mode=ROUND_DOWN) -> str:
    """value를 step(예 '0.001')의 배수로 라운딩해 문자열로 반환.
    수량은 내림(ROUND_DOWN), 가격은 반올림(ROUND_HALF_UP) 권장."""
    try:
        d = Decimal(str(value))
        s = Decimal(str(step))
        if s <= 0:
            return format(d, 'f')
        q = (d / s).to_integral_value(rounding=mode) * s
        # step의 소수 자릿수에 맞춰 정규화
        return format(q.quantize(s), 'f')
    except Exception:
        return format(Decimal(str(value)), 'f')


class BybitTrader:
    def __init__(self, api_key: str, api_secret: str, testnet: bool = True):
        self.api_key = api_key
        self.api_secret = api_secret
        self.base_url = TESTNET_URL if testnet else MAINNET_URL
        self.testnet = testnet
        self._instrument_cache = {}

    def _signed_headers(self, sign_payload: str) -> dict:
        """Bybit V5 서명. sign_payload = GET이면 정렬된 쿼리스트링,
        POST면 전송할 compact JSON 본문 문자열. 둘 다 '전송되는 바이트'와 일치해야 함."""
        timestamp = str(int(time.time() * 1000))
        recv_window = "5000"
        to_sign = timestamp + self.api_key + recv_window + (sign_payload or "")
        signature = hmac.new(
            self.api_secret.encode('utf-8'),
            to_sign.encode('utf-8'),
            hashlib.sha256,
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
        params = params or {}
        async with httpx.AsyncClient(timeout=10) as client:
            if method == "GET":
                # 정렬된 쿼리스트링을 만들어 그 문자열을 서명하고, 동일 문자열을 URL로 전송
                query = urllib.parse.urlencode(sorted(params.items()))
                headers = self._signed_headers(query)
                url = f"{self.base_url}{path}"
                if query:
                    url = f"{url}?{query}"
                resp = await client.get(url, headers=headers)
            else:
                # compact JSON 바이트를 직접 만들어 그 바이트를 서명 + content=로 전송
                body = json.dumps(params, separators=(',', ':'))
                headers = self._signed_headers(body)
                resp = await client.post(f"{self.base_url}{path}", headers=headers, content=body)
            try:
                return resp.json()
            except Exception:
                # Bybit가 JSON이 아닌 응답(차단 페이지/HTML/빈 응답)을 준 경우 → 진단 정보 노출
                snippet = (resp.text or "")[:300].replace("\n", " ")
                raise RuntimeError(
                    f"Bybit 응답이 JSON이 아님 (HTTP {resp.status_code}, host={self.base_url}): {snippet!r}"
                )

    async def get_instrument_info(self, symbol: str) -> Optional[dict]:
        """종목별 tickSize/qtyStep/minOrderQty 조회 (public, 서명 불필요). 캐시."""
        if symbol in self._instrument_cache:
            return self._instrument_cache[symbol]
        try:
            async with httpx.AsyncClient(timeout=10) as client:
                resp = await client.get(
                    f"{self.base_url}/v5/market/instruments-info",
                    params={"category": "linear", "symbol": symbol},
                )
                data = resp.json()
            info = data["result"]["list"][0]
            self._instrument_cache[symbol] = info
            return info
        except Exception:
            return None

    async def get_wallet_balance(self) -> dict:
        """지갑 잔고 조회"""
        return await self._request("GET", "/v5/account/wallet-balance", {"accountType": "UNIFIED"})

    async def get_positions(self, symbol: str = None) -> dict:
        """포지션 조회"""
        params = {"category": "linear"}
        if symbol:
            params["symbol"] = symbol
        else:
            params["settleCoin"] = "USDT"
        return await self._request("GET", "/v5/position/list", params)

    async def has_open_position(self, symbol: str) -> bool:
        """해당 종목에 열린 포지션이 있는지 확인 (중복 진입 방지용)."""
        try:
            res = await self.get_positions(symbol)
            for p in res.get("result", {}).get("list", []) or []:
                if abs(float(p.get("size", 0) or 0)) > 0:
                    return True
        except Exception:
            # 조회 실패 시 안전하게 '있다'고 보고 진입 차단
            return True
        return False

    async def count_open_positions(self) -> int:
        """전체(모든 종목) 열린 포지션 수. 멀티코인 '한 번에 하나' 제한용.
        조회 실패 시 안전하게 큰 값을 반환해 신규 진입을 막는다."""
        try:
            res = await self.get_positions()  # settleCoin=USDT → 전 종목
            return sum(
                1 for p in (res.get("result", {}).get("list", []) or [])
                if abs(float(p.get("size", 0) or 0)) > 0
            )
        except Exception:
            return 999

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
        order_link_id: str = None,
    ) -> dict:
        """주문 실행"""
        # 레버리지 설정 (이미 같은 값이면 Bybit가 retCode 110043 반환 — 무시)
        if leverage:
            await self._request("POST", "/v5/position/set-leverage", {
                "category": "linear",
                "symbol": symbol,
                "buyLeverage": str(leverage),
                "sellLeverage": str(leverage),
            })

        params = {
            "category": "linear",
            "symbol": symbol,
            "side": side,
            "orderType": order_type,
            "qty": qty,
        }
        if order_link_id:
            params["orderLinkId"] = order_link_id  # 멱등키 — 중복 주문 거부됨
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
    "qty_usdt": "50",   # 주문당 USDT 금액
    "tp_pct": 2.0,      # 익절 %
    "sl_pct": 1.0,      # 손절 %
    "min_score": 100,   # 최소 신호 점수
    "cooldown_sec": 1800,  # 같은 종목 재진입 쿨다운(초) — 중복발사 방지
    "max_positions": 1,  # 전체 동시 보유 포지션 수 상한 (멀티코인 안전장치)
}
trade_log = []
_last_trade_ts = {}  # symbol -> 마지막 진입 시각(중복발사 방지)


def init_trader(api_key: str, api_secret: str, testnet: bool = True) -> BybitTrader:
    global trader_instance
    trader_instance = BybitTrader(api_key, api_secret, testnet)
    return trader_instance


async def execute_signal_trade(signal_direction: str, score: int, price: float,
                               symbol: str = None) -> dict:
    """매매 신호에 따라 자동 주문 실행. (멀티코인: symbol 지정 가능)

    중복발사 + 과다진입 차단:
      (a) 쿨다운: 같은 종목 cooldown_sec 내 재진입 금지
      (b) 전체 포지션 상한: max_positions 초과면 신규 진입 안 함 (소액계좌 보호)
      (c) 동일 종목 포지션 체크: 이미 열려 있으면 진입 안 함
      (d) orderLinkId 멱등키: Bybit가 동일 키 중복 주문 거부
    """
    global trade_log
    if not trader_instance or not auto_trade_enabled:
        return {"status": "disabled"}

    cfg = auto_trade_config
    if abs(score) < cfg["min_score"]:
        return {"status": "score_too_low", "score": score}

    if signal_direction not in ("LONG", "SHORT"):
        return {"status": "no_signal"}

    # 멀티코인: 프론트가 보낸 종목 우선, 없으면 config 종목
    symbol = (symbol or cfg["symbol"]).upper()
    now = time.time()

    # (a) 쿨다운 체크 (종목별)
    cooldown = float(cfg.get("cooldown_sec", 1800) or 0)
    last = _last_trade_ts.get(symbol, 0)
    if cooldown > 0 and now - last < cooldown:
        return {"status": "cooldown", "symbol": symbol, "remain_sec": int(cooldown - (now - last))}

    # (b) 전체 포지션 상한 (멀티코인 '한 번에 N개' 제한 — 소액계좌 보호 + 오발사 방지)
    max_pos = int(cfg.get("max_positions", 1) or 1)
    open_cnt = await trader_instance.count_open_positions()
    if open_cnt >= max_pos:
        return {"status": "max_positions_reached", "open": open_cnt, "max": max_pos}

    # (c) 동일 종목 포지션 체크
    if await trader_instance.has_open_position(symbol):
        return {"status": "position_exists", "symbol": symbol}

    if price <= 0:
        return {"status": "bad_price", "price": price}

    # 종목별 라운딩 규칙
    info = await trader_instance.get_instrument_info(symbol)
    qty_step = "0.001"
    min_qty = "0.001"
    tick_size = "0.01"
    if info:
        try:
            qty_step = info["lotSizeFilter"]["qtyStep"]
            min_qty = info["lotSizeFilter"]["minOrderQty"]
            tick_size = info["priceFilter"]["tickSize"]
        except Exception:
            pass

    # 수량: 명목금액/현재가 → qtyStep 내림. 최소수량 미달이면 거부.
    qty_usdt = float(cfg["qty_usdt"])
    raw_qty = qty_usdt / price
    qty = _round_step(raw_qty, qty_step, ROUND_DOWN)
    if Decimal(qty) < Decimal(min_qty):
        return {
            "status": "qty_below_min", "symbol": symbol,
            "computed_qty": qty, "min_qty": min_qty,
            "hint": f"주문금액({qty_usdt} USDT)이 {symbol} 최소수량({min_qty})에 못 미침. 금액을 올리세요.",
        }

    # TP/SL: tickSize에 맞춰 반올림 (저가 알트 0.00 무효화 방지)
    tp_pct = cfg["tp_pct"] / 100
    sl_pct = cfg["sl_pct"] / 100
    if signal_direction == "LONG":
        side = "Buy"
        tp = _round_step(price * (1 + tp_pct), tick_size, ROUND_HALF_UP)
        sl = _round_step(price * (1 - sl_pct), tick_size, ROUND_HALF_UP)
    else:  # SHORT
        side = "Sell"
        tp = _round_step(price * (1 - tp_pct), tick_size, ROUND_HALF_UP)
        sl = _round_step(price * (1 + sl_pct), tick_size, ROUND_HALF_UP)

    # (c) orderLinkId 멱등키 — 쿨다운 윈도우 단위로 동일 → 중복 주문 거부
    window = int(now // max(cooldown, 1))
    order_link_id = f"velox-{symbol}-{side}-{window}"

    try:
        result = await trader_instance.place_order(
            symbol=symbol,
            side=side,
            qty=qty,
            leverage=cfg["leverage"],
            take_profit=tp,
            stop_loss=sl,
            order_link_id=order_link_id,
        )

        ret_code = result.get("retCode", -1)
        # 성공(0)일 때만 쿨다운 타임스탬프 갱신
        if ret_code == 0:
            _last_trade_ts[symbol] = now

        log_entry = {
            "time": time.strftime("%Y-%m-%d %H:%M:%S"),
            "symbol": symbol,
            "side": side,
            "qty": qty,
            "price": price,
            "tp": tp,
            "sl": sl,
            "score": score,
            "order_link_id": order_link_id,
            "retCode": ret_code,
            "result": result.get("retMsg", "unknown"),
            "testnet": trader_instance.testnet,
        }
        trade_log.append(log_entry)
        if len(trade_log) > 100:
            trade_log = trade_log[-100:]

        status = "executed" if ret_code == 0 else "rejected"
        return {"status": status, "order": log_entry, "response": result}
    except Exception as e:
        return {"status": "error", "message": str(e)}
