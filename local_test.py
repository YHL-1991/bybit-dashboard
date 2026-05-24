#!/usr/bin/env python3
"""
Velox 로컬 트레이더 테스트 (배관 검증용)

목적: Railway 서버는 Bybit에 지역차단(HTTP 403)당하므로, 본인 Mac(한국 IP)에서
      직접 실행해 '주문이 실제로 들어가는지' 배관을 검증한다.

안전 설계:
- API 키/시크릿은 실행 시점에 입력받고 어디에도 저장하지 않는다 (시크릿은 입력 시 화면에 안 보임).
- 기본은 TESTNET(모의). 실거래는 `--mainnet` 인자를 명시할 때만, 그것도 'yes' 확인 후.
- 테스트 주문은 '최소 수량' 시장가 1건만. 넣기 전 반드시 y 확인.

사용법:
    pip3 install httpx
    python3 local_test.py            # testnet (모의, 안전)
    python3 local_test.py --mainnet  # 실거래 (진짜 돈 — 검증 끝난 뒤에만!)
"""
import asyncio
import getpass
import sys
import time
from decimal import Decimal, ROUND_DOWN, ROUND_HALF_UP

import httpx

from auto_trader import BybitTrader, _round_step


async def main():
    mainnet = "--mainnet" in sys.argv
    testnet = not mainnet
    base = "https://api.bybit.com" if mainnet else "https://api-testnet.bybit.com"

    print("=" * 60)
    print(f"  Velox 로컬 트레이더 테스트  [{'⚠️ 실거래 MAINNET' if mainnet else 'TESTNET (모의)'}]")
    print("=" * 60)

    if mainnet:
        print("\n⚠️  실거래 모드입니다. 진짜 돈이 나갑니다.")
        if input("정말 진행하시겠습니까? ('yes' 정확히 입력): ").strip() != "yes":
            print("취소됨.")
            return

    api_key = input("\nAPI Key: ").strip()
    api_secret = getpass.getpass("API Secret (입력해도 화면에 안 보입니다): ").strip()
    if not api_key or not api_secret:
        print("❌ 키/시크릿이 비어 있습니다.")
        return

    trader = BybitTrader(api_key, api_secret, testnet=testnet)

    # ── [1] 잔고 조회 = 연결/서명/지역 배관 1차 검증 ──
    print("\n[1] 잔고 조회 중...")
    try:
        bal = await trader.get_wallet_balance()
    except Exception as e:
        print(f"  ❌ 통신 실패: {e}")
        print("  → 'block access from your country'가 보이면 이 PC도 차단 지역입니다(VPN 등 필요).")
        return
    if bal.get("retCode") != 0:
        print(f"  ❌ Bybit 거부: retCode={bal.get('retCode')}, retMsg={bal.get('retMsg')}")
        print("  → 10003/10004류면 키/권한 문제. 키 권한(Unified Trading: Orders+Positions) 확인.")
        return
    try:
        coins = bal["result"]["list"][0]["coin"]
        usdt = next((c for c in coins if c["coin"] == "USDT"), None)
        print(f"  ✅ 연결 성공! USDT 잔고: {usdt['walletBalance'] if usdt else 0}")
    except Exception:
        print(f"  ✅ 연결됨(잔고 파싱은 생략). 원본: {bal}")

    # ── [2] 현재 포지션 조회 ──
    print("\n[2] BTCUSDT 포지션 조회...")
    # ── 종목 선택 (알트 가능) ──
    sym_in = input("\n거래할 종목? (엔터=BTCUSDT, 예: ETHUSDT, SOLUSDT, XRPUSDT): ").strip().upper()
    symbol = sym_in or "BTCUSDT"
    if not symbol.endswith("USDT"):
        symbol += "USDT"

    try:
        pos = await trader.get_positions(symbol)
        plist = pos.get("result", {}).get("list", [])
        if plist and float(plist[0].get("size", 0) or 0) != 0:
            print(f"  {symbol} 보유 포지션: size={plist[0].get('size')}, side={plist[0].get('side')}")
        else:
            print(f"  {symbol} 보유 포지션 없음.")
    except Exception as e:
        print(f"  포지션 조회 실패: {e}")

    # ── [3] 최소 수량 테스트 주문 (선택) ──
    ans = input(f"\n[3] {symbol} '최소 수량' 시장가 테스트 주문을 넣을까요? (y/N): ").strip().lower()
    if ans != "y":
        print("\n주문 생략. (잔고/포지션 조회가 됐다면 배관의 절반은 검증된 것)")
        return

    # 방향 선택
    side_in = input("  방향? (1=롱/Buy, 2=숏/Sell, 엔터=롱): ").strip()
    side = "Sell" if side_in == "2" else "Buy"

    # 종목 규격 (최소수량/스텝/틱)
    info = await trader.get_instrument_info(symbol)
    if not info:
        print(f"  ❌ {symbol} 종목 정보 조회 실패 (종목명 확인).")
        return
    qty_step = info["lotSizeFilter"]["qtyStep"]
    min_qty = info["lotSizeFilter"]["minOrderQty"]
    tick = info["priceFilter"]["tickSize"]

    # 현재가 (public, 서명 불필요)
    async with httpx.AsyncClient(timeout=10) as c:
        r = await c.get(f"{base}/v5/market/tickers",
                        params={"category": "linear", "symbol": symbol})
        lst = r.json().get("result", {}).get("list", [])
        if not lst:
            print(f"  ❌ {symbol} 시세 조회 실패 (상장 안 됐거나 종목명 오류).")
            return
        price = float(lst[0]["lastPrice"])

    qty = _round_step(float(min_qty), qty_step, ROUND_DOWN)
    if Decimal(qty) < Decimal(min_qty):
        qty = str(min_qty)
    # TP/SL: 롱이면 위가 익절·아래가 손절, 숏이면 반대
    if side == "Buy":
        tp = _round_step(price * 1.02, tick, ROUND_HALF_UP)   # +2%
        sl = _round_step(price * 0.99, tick, ROUND_HALF_UP)   # -1%
    else:
        tp = _round_step(price * 0.98, tick, ROUND_HALF_UP)   # -2%
        sl = _round_step(price * 1.01, tick, ROUND_HALF_UP)   # +1%

    notional = price * float(qty)
    side_kr = "롱(Buy)" if side == "Buy" else "숏(Sell)"
    print(f"  현재가 {price} | 주문: {side_kr} {qty} {symbol} 시장가 · TP {tp} · SL {sl}")
    print(f"  명목가치(notional) ≈ {notional:,.2f} USDT  (이만큼 / 레버리지 = 필요 증거금)")
    confirm = input("  이대로 주문 전송? (y/N): ").strip().lower()
    if confirm != "y":
        print("  주문 취소됨.")
        return

    res = await trader.place_order(
        symbol, side, qty,
        take_profit=tp, stop_loss=sl,
        order_link_id=f"velox-localtest-{int(time.time())}",
    )
    print(f"\n  결과: retCode={res.get('retCode')}, retMsg={res.get('retMsg')}")
    if res.get("retCode") == 0:
        print("  ✅ 주문 성공! Bybit testnet 화면(Orders/Positions)에서 TP/SL이 걸렸는지 확인하세요.")
        print("     → 이게 보이면 '실행 배관'이 정상입니다. 다음은 신호 검증입니다.")
    else:
        print(f"  ❌ 주문 거부: {res}")
        print("     → retMsg를 보고 원인 파악 (수량/권한/마진 등).")


if __name__ == "__main__":
    asyncio.run(main())
