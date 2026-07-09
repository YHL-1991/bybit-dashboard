import asyncio
import json
import os
import hmac
import hashlib
import secrets
import time as _time0
from pathlib import Path

import uvicorn
import websockets
from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.responses import HTMLResponse, JSONResponse, RedirectResponse
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

# ─── 자동매매 엔드포인트 보안 ───
# 환경변수 TRADER_TOKEN이 설정돼 있어야만 trader 엔드포인트 사용 가능.
# 미설정 시 모든 실거래 엔드포인트 차단 (안전 기본값).
TRADER_TOKEN = os.environ.get("TRADER_TOKEN", "")


def _check_trader_auth(request: Request):
    """trader 엔드포인트 인증. 통과하면 None, 실패하면 JSONResponse 반환.
    - 헤더 전용(X-Trader-Token). query_param 미지원 (로그/리퍼러/히스토리 누수 방지).
    - hmac.compare_digest 상수시간 비교 (타이밍 공격 방지)."""
    if not TRADER_TOKEN:
        return JSONResponse(
            {"status": "disabled", "message": "실거래 기능 비활성화됨 (서버에 TRADER_TOKEN 미설정). 보안을 위해 기본 차단."},
            status_code=403,
        )
    token = request.headers.get("X-Trader-Token", "")
    if not hmac.compare_digest(token, TRADER_TOKEN):
        return JSONResponse(
            {"status": "unauthorized", "message": "인증 토큰 불일치 (X-Trader-Token 헤더 필요)"},
            status_code=401,
        )
    return None

BASE_DIR = Path(__file__).parent
app.mount("/static", StaticFiles(directory=BASE_DIR / "static"), name="static")
templates = Jinja2Templates(directory=BASE_DIR / "templates")

# ─────────────────────────────────────────────────────────────────────────
# 하이브리드 접근 제어 (공개 랜딩 / 초대 전용 대시보드)
#   - "/"          : 공개 랜딩 페이지 (마케팅/포트폴리오, 누구나 접근)
#   - "/dashboard" : 실제 대시보드 (초대 세션 필요)
#   - "/api","/ws" : 데이터 (초대 세션 필요)
#   인증 경로 3가지:
#     1) 매직링크  /invite?token=...  (admin이 발급, 클릭 시 자동 로그인)
#     2) 초대코드  /login            (ACCESS_CODES 직접 입력)
#   환경변수:
#     ACCESS_CODES  콤마구분 초대코드 (미설정 시 게이트 비활성 = 전체 공개)
#     ADMIN_KEY     /admin 접근 키 (미설정 시 admin 비활성)
#     TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID  request-access 알림용
#     SESSION_SECRET  쿠키 서명 비밀 (미설정 시 ACCESS_CODES 기반 파생)
# ─────────────────────────────────────────────────────────────────────────
ACCESS_CODES = [c.strip() for c in os.environ.get("ACCESS_CODES", "").split(",") if c.strip()]
ADMIN_KEY = os.environ.get("ADMIN_KEY", "")
_SESSION_SECRET = os.environ.get("SESSION_SECRET", "") or (
    "velox-gate-" + hashlib.sha256(("|".join(ACCESS_CODES) or "novar").encode()).hexdigest()[:40]
)
_SESSION_TTL = 60 * 60 * 24 * 30   # 세션 쿠키 30일
_INVITE_TTL = 60 * 60 * 24 * 14    # 매직링크 토큰 14일 (첫 사용까지)
_COOKIE_NAME = "velox_session"
# 게이트를 통과시키는(=세션 불필요) 경로. 나머지 중 _GATED_PREFIXES만 보호.
_GATED_PREFIXES = ("/dashboard", "/api", "/ws")


def _data_path(name: str) -> str:
    return os.path.join(_DATA_DIR, name)


def _load_json(name, default):
    try:
        p = _data_path(name)
        if os.path.exists(p):
            with open(p, "r", encoding="utf-8") as f:
                return json.load(f)
    except Exception:
        pass
    return default


def _save_json(name, data):
    try:
        with open(_data_path(name), "w", encoding="utf-8") as f:
            json.dump(data, f, ensure_ascii=False)
    except Exception:
        pass


def _make_session() -> str:
    ts = str(int(_time0.time()))
    sig = hmac.new(_SESSION_SECRET.encode(), ts.encode(), hashlib.sha256).hexdigest()
    return f"{ts}.{sig}"


def _valid_session(cookie: str) -> bool:
    if not cookie or "." not in cookie:
        return False
    ts, sig = cookie.rsplit(".", 1)
    expected = hmac.new(_SESSION_SECRET.encode(), ts.encode(), hashlib.sha256).hexdigest()
    if not hmac.compare_digest(sig, expected):
        return False
    try:
        return (_time0.time() - int(ts)) <= _SESSION_TTL
    except Exception:
        return False


def _set_session_cookie(resp, request):
    secure = request.url.scheme == "https"  # localhost(http)에서도 동작하도록 https일 때만 Secure
    resp.set_cookie(_COOKIE_NAME, _make_session(), max_age=_SESSION_TTL,
                    httponly=True, samesite="lax", secure=secure)
    return resp


def _log_access(kind, request, extra=""):
    try:
        log = _load_json("velox_access.json", [])
        ip = request.headers.get("x-forwarded-for", "") or (request.client.host if request.client else "")
        log.append({"ts": int(_time0.time()), "kind": kind, "ip": ip.split(",")[0].strip(),
                    "path": request.url.path, "extra": extra,
                    "ua": request.headers.get("user-agent", "")[:140]})
        _save_json("velox_access.json", log[-1000:])
    except Exception:
        pass


async def _notify_telegram(text: str):
    token = os.environ.get("TELEGRAM_BOT_TOKEN", "")
    chat = os.environ.get("TELEGRAM_CHAT_ID", "")
    if not token or not chat:
        return
    try:
        async with _httpx.AsyncClient(timeout=8.0) as c:
            await c.post(f"https://api.telegram.org/bot{token}/sendMessage",
                         json={"chat_id": chat, "text": text, "disable_web_page_preview": True})
    except Exception:
        pass


@app.middleware("http")
async def _access_gate(request: Request, call_next):
    # 게이트 비활성(ACCESS_CODES 미설정) → 전체 공개 (개발/락아웃 방지)
    if not ACCESS_CODES:
        return await call_next(request)
    path = request.url.path
    if not any(path.startswith(p) for p in _GATED_PREFIXES):
        return await call_next(request)  # 랜딩/로그인/초대/admin/정적 등은 통과
    if _valid_session(request.cookies.get(_COOKIE_NAME, "")):
        return await call_next(request)
    # 미인증: API/WS는 401, 대시보드 HTML은 로그인으로
    if path.startswith("/api") or path.startswith("/ws"):
        return JSONResponse({"error": "unauthorized", "message": "초대 인증 필요"}, status_code=401)
    return RedirectResponse(url="/login", status_code=302)


# ── 초대코드 직접 로그인 ──
@app.get("/login", response_class=HTMLResponse)
async def login_page(request: Request):
    if not ACCESS_CODES:
        return RedirectResponse(url="/dashboard", status_code=302)
    if _valid_session(request.cookies.get(_COOKIE_NAME, "")):
        return RedirectResponse(url="/dashboard", status_code=302)
    return templates.TemplateResponse("login.html", {"request": request})


@app.post("/login")
async def login_submit(request: Request):
    try:
        body = await request.json()
    except Exception:
        body = {}
    code = (body.get("code", "") or "").strip()
    ok = any(hmac.compare_digest(code, c) for c in ACCESS_CODES) if code else False
    if not ok:
        return JSONResponse({"ok": False, "message": "Invalid invite code."}, status_code=401)
    _log_access("login_code", request)
    return _set_session_cookie(JSONResponse({"ok": True}), request)


# ── 매직링크 초대 (admin이 발급한 토큰 클릭) ──
@app.get("/invite")
async def invite_redeem(request: Request, token: str = ""):
    invites = _load_json("velox_invites.json", {})
    inv = invites.get(token)
    now = int(_time0.time())
    if not inv:
        return templates.TemplateResponse("login.html",
            {"request": request, "invite_error": "Invalid invite link."}, status_code=403)
    if inv.get("revoked"):
        return templates.TemplateResponse("login.html",
            {"request": request, "invite_error": "This invite link has been revoked."}, status_code=403)
    if now - int(inv.get("created", now)) > _INVITE_TTL and not inv.get("used"):
        return templates.TemplateResponse("login.html",
            {"request": request, "invite_error": "This invite link has expired."}, status_code=403)
    # 첫 사용 기록 + 세션 발급
    if not inv.get("used"):
        inv["used"] = now
        inv["uses"] = inv.get("uses", 0) + 1
        invites[token] = inv
        _save_json("velox_invites.json", invites)
    _log_access("invite_redeem", request, extra=inv.get("label", ""))
    return _set_session_cookie(RedirectResponse(url="/dashboard", status_code=302), request)


@app.get("/logout")
async def logout():
    resp = RedirectResponse(url="/", status_code=302)
    resp.delete_cookie(_COOKIE_NAME)
    return resp


# ── 공개 데모 신청 폼 (랜딩 페이지에서 제출) ──
@app.post("/request-access")
async def request_access(request: Request):
    try:
        body = await request.json()
    except Exception:
        body = {}
    name = (body.get("name", "") or "").strip()[:120]
    email = (body.get("email", "") or "").strip()[:160]
    company = (body.get("company", "") or "").strip()[:160]
    use_case = (body.get("use_case", "") or "").strip()[:600]
    if not email or "@" not in email:
        return JSONResponse({"ok": False, "message": "유효한 이메일을 입력하세요."}, status_code=400)
    leads = _load_json("velox_leads.json", [])
    ip = request.headers.get("x-forwarded-for", "") or (request.client.host if request.client else "")
    leads.append({"ts": int(_time0.time()), "name": name, "email": email,
                  "company": company, "use_case": use_case, "status": "new",
                  "ip": ip.split(",")[0].strip()})
    _save_json("velox_leads.json", leads[-2000:])
    await _notify_telegram(
        f"🔔 Velox 데모 신청\n이름: {name}\n이메일: {email}\n회사: {company}\n용도: {use_case[:300]}")
    return JSONResponse({"ok": True})


# ── 관리자 페이지 (리드 조회 + 매직링크 발급) ──
def _admin_ok(key: str) -> bool:
    return bool(ADMIN_KEY) and bool(key) and hmac.compare_digest(key, ADMIN_KEY)


@app.get("/admin", response_class=HTMLResponse)
async def admin_page(request: Request, key: str = ""):
    if not _admin_ok(key):
        return HTMLResponse("<h3 style='font-family:sans-serif'>403 — admin key 필요</h3>", status_code=403)
    leads = _load_json("velox_leads.json", [])
    invites = _load_json("velox_invites.json", {})
    return templates.TemplateResponse("admin.html", {
        "request": request, "key": key,
        "leads": list(reversed(leads)),
        "invites": [{"token": t, **v} for t, v in sorted(invites.items(), key=lambda kv: kv[1].get("created", 0), reverse=True)],
    })


@app.post("/admin/invite")
async def admin_invite(request: Request, key: str = ""):
    if not _admin_ok(key):
        return JSONResponse({"ok": False, "message": "admin key 필요"}, status_code=403)
    try:
        body = await request.json()
    except Exception:
        body = {}
    label = (body.get("label", "") or "").strip()[:120]
    invites = _load_json("velox_invites.json", {})
    token = secrets.token_urlsafe(24)
    invites[token] = {"label": label, "created": int(_time0.time()), "used": 0, "uses": 0, "revoked": False}
    _save_json("velox_invites.json", invites)
    base = str(request.base_url).rstrip("/")
    return JSONResponse({"ok": True, "token": token, "link": f"{base}/invite?token={token}"})


@app.post("/admin/revoke")
async def admin_revoke(request: Request, key: str = ""):
    if not _admin_ok(key):
        return JSONResponse({"ok": False, "message": "admin key 필요"}, status_code=403)
    try:
        body = await request.json()
    except Exception:
        body = {}
    token = body.get("token", "")
    invites = _load_json("velox_invites.json", {})
    if token in invites:
        invites[token]["revoked"] = True
        _save_json("velox_invites.json", invites)
    return JSONResponse({"ok": True})


@app.get("/healthz")
async def healthz():
    return {"ok": True}

# 인기 종목 우선순위 (검색 드롭다운 상단 노출용)
PRIORITY_SYMBOLS = [
    "BTCUSDT", "ETHUSDT", "SOLUSDT", "XRPUSDT", "DOGEUSDT",
    "BNBUSDT", "ADAUSDT", "AVAXUSDT", "DOTUSDT", "LINKUSDT",
    "SUIUSDT", "PEPEUSDT", "WIFUSDT", "ARBUSDT", "OPUSDT",
]

# Fallback list (API 실패 시 사용) - 사용자가 추가했던 종목들
FALLBACK_SYMBOLS = PRIORITY_SYMBOLS + [
    "RAVEUSDT", "ENJUSDT", "ARIAUSDT", "DRIFTUSDT", "BLESSUSDT", "MYXUSDT",
    "INUSDT", "BIOUSDT", "CHZUSDT", "ORDIUSDT", "BASEDUSDT",
    "SIRENUSDT", "SOONUSDT", "SIGNUSDT", "HIGHUSDT", "PORTALUSDT", "ALICEUSDT",
    "CHIPUSDT", "METUSDT", "SEIUSDT", "HUSDT",
    "BSBUSDT", "KATUSDT", "MOVRUSDT", "SPKUSDT", "ORCAUSDT",
]


# 서버는 fallback만 제공. Railway 서버는 Bybit CloudFront에 차단됨 →
# 프론트엔드가 사용자 브라우저에서 직접 Bybit instruments-info 호출
SYMBOLS = list(FALLBACK_SYMBOLS)

STOCKS = [
    ("STK:174900.KQ", "앱클론 (KOSDAQ:174900)"),
    ("STK:456160.KQ", "지투지바이오 (KOSDAQ:456160)"),
    ("STK:TSLA", "테슬라 (NASDAQ:TSLA)"),
    ("STK:SPCX", "스페이스X (NASDAQ:SPCX)"),
    ("STK:005930.KS", "삼성전자 (KRX:005930)"),
    ("STK:000660.KS", "SK하이닉스 (KRX:000660)"),
    ("STK:009150.KS", "삼성전기 (KRX:009150)"),
    ("STK:006400.KS", "삼성SDI (KRX:006400)"),
    ("STK:005380.KS", "현대차 (KRX:005380)"),
    ("STK:001450.KS", "현대해상 (KRX:001450)"),
    ("STK:009830.KS", "한화솔루션 (KRX:009830)"),
    ("STK:010060.KS", "OCI홀딩스 (KRX:010060)"),
    ("STK:322000.KS", "HD현대에너지솔루션 (KRX:322000)"),
    ("STK:011930.KS", "신성이엔지 (KRX:011930)"),
    ("STK:047810.KS", "한국항공우주 (KRX:047810)"),
    ("STK:001430.KS", "세아베스틸 (KRX:001430)"),
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
_coinness_cache = {"data": None, "ts": 0}
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


# ── 백테스트 결과 저장 ──
# 우선순위: DATA_DIR 환경변수(Railway 볼륨) → 앱 디렉토리(재시작엔 유지, 재배포엔 소실)
# ⚠️ 진정한 영구 저장은 Railway Volume 마운트 + DATA_DIR 설정 필요
import os as _os
_DATA_DIR = _os.environ.get("DATA_DIR", str(BASE_DIR / "data"))
try:
    _os.makedirs(_DATA_DIR, exist_ok=True)
except Exception:
    _DATA_DIR = "/tmp"
BACKTEST_FILE = _os.path.join(_DATA_DIR, "velox_backtest.json")
FORWARDTEST_FILE = _os.path.join(_DATA_DIR, "velox_forwardtest.json")


def _load_backtest():
    if _os.path.exists(BACKTEST_FILE):
        try:
            with open(BACKTEST_FILE, "r", encoding="utf-8") as f:
                return json.load(f)
        except Exception:
            pass
    return {}


def _save_backtest(data):
    try:
        with open(BACKTEST_FILE, "w", encoding="utf-8") as f:
            json.dump(data, f, ensure_ascii=False)
    except Exception:
        pass


def _load_forwardtest():
    if _os.path.exists(FORWARDTEST_FILE):
        try:
            with open(FORWARDTEST_FILE, "r", encoding="utf-8") as f:
                return json.load(f)
        except Exception:
            pass
    return []


def _append_forwardtest(entry):
    """실시간 신호 → 결과 로그 (forward-test, 과최적화 방지 검증용)"""
    try:
        log = _load_forwardtest()
        log.append(entry)
        log = log[-2000:]  # 최근 2000건만 유지
        with open(FORWARDTEST_FILE, "w", encoding="utf-8") as f:
            json.dump(log, f, ensure_ascii=False)
    except Exception:
        pass


@app.get("/api/forwardtest")
async def api_forwardtest_get():
    """forward-test 로그 조회 (실시간 신호 vs 실제 결과)"""
    return {"log": _load_forwardtest()}


@app.post("/api/forwardtest/log")
async def api_forwardtest_log(request: Request):
    """실시간 신호 기록 (종목군별 적중률 추적용).
    신호 발생 시점에 entry_price/direction/horizon_hours를 함께 저장하면
    이후 /api/forwardtest/resolve가 N시간 뒤 실제 결과와 페어링한다."""
    try:
        body = await request.json()
        body["ts"] = int(_time.time())
        body.setdefault("resolved", False)
        # 미래 검증을 위한 필수 필드 보존 (없으면 페어링 불가 → resolved 처리 안 함)
        body.setdefault("horizon_hours", 4)
        _append_forwardtest(body)
        return {"ok": True}
    except Exception as e:
        return {"ok": False, "error": str(e)}


@app.post("/api/forwardtest/resolve")
async def api_forwardtest_resolve(request: Request):
    """신호→결과 페어링.

    중요: 서버(Railway)는 CloudFront 차단으로 Bybit kline을 못 받는다. 따라서 실제
    매매 전략(TP +2% / SL -1% 배리어)과 일치시키려면, Bybit 접근이 가능한 프론트(브라우저)가
    진입 시점부터 horizon까지의 kline 경로를 걸어 'TP/SL 중 무엇이 먼저 닿았는지' 판정하고
    수수료/펀딩을 차감한 결과를 보내야 한다.

    body: {"resolutions":[{"ts":<신호ts(초)>,"exit_price":..,"change_pct":..,
            "realized_pct":<비용차감후>,"correct":bool,"outcome":"tp|sl|timeout"}]}
    ts로 미해결 신호를 찾아 매칭 후 resolved 처리."""
    try:
        body = await request.json()
        resolutions = body.get("resolutions", []) or []
        by_ts = {}
        for r in resolutions:
            try:
                by_ts[int(r["ts"])] = r
            except Exception:
                continue
        if not by_ts:
            return {"ok": True, "resolved": 0}
        now = int(_time.time())
        log = _load_forwardtest()
        resolved_count = 0
        for e in log:
            if e.get("resolved"):
                continue
            ets = int(e.get("ts", 0) or 0)
            r = by_ts.get(ets)
            if not r:
                continue
            e["resolved"] = True
            e["resolve_ts"] = now
            e["exit_price"] = r.get("exit_price")
            e["change_pct"] = r.get("change_pct")
            e["realized_pct"] = r.get("realized_pct")  # 수수료/펀딩 차감 후
            e["correct"] = bool(r.get("correct"))
            e["outcome"] = r.get("outcome", "timeout")  # tp/sl/timeout
            resolved_count += 1
        if resolved_count:
            try:
                with open(FORWARDTEST_FILE, "w", encoding="utf-8") as f:
                    json.dump(log, f, ensure_ascii=False)
            except Exception:
                pass
        return {"ok": True, "resolved": resolved_count}
    except Exception as e:
        return {"ok": False, "error": str(e)}


@app.get("/api/forwardtest/stats")
async def api_forwardtest_stats():
    """페어링된 결과를 종목군(symClass)별로 집계.
    적중률(hit-rate)뿐 아니라 평균 실현수익률(EV 대용)도 함께 반환.
    표본이 적으면 신뢰 불가 — n과 함께 노출해 정직하게 판단하도록."""
    log = _load_forwardtest()
    buckets = {}
    for e in log:
        if not e.get("resolved"):
            continue
        cls = e.get("symClass") or "unknown"
        b = buckets.setdefault(cls, {"n": 0, "wins": 0, "sum_realized": 0.0,
                                     "tp": 0, "sl": 0, "timeout": 0})
        b["n"] += 1
        if e.get("correct"):
            b["wins"] += 1
        b["sum_realized"] += float(e.get("realized_pct", 0) or 0)
        oc = e.get("outcome")
        if oc in ("tp", "sl", "timeout"):
            b[oc] += 1
    out = {}
    total_n = total_w = 0
    total_sum = 0.0
    for cls, b in buckets.items():
        n = b["n"]
        out[cls] = {
            "n": n,
            "hit_rate": round(b["wins"] / n * 100, 1) if n else 0,
            "avg_realized_pct": round(b["sum_realized"] / n, 3) if n else 0,  # 수수료/펀딩 차감 후
            "tp": b["tp"], "sl": b["sl"], "timeout": b["timeout"],
        }
        total_n += n
        total_w += b["wins"]
        total_sum += b["sum_realized"]
    out["_total"] = {
        "n": total_n,
        "hit_rate": round(total_w / total_n * 100, 1) if total_n else 0,
        "avg_realized_pct": round(total_sum / total_n, 3) if total_n else 0,
        "pending": sum(1 for e in log if not e.get("resolved")),
        "note": "realized_pct는 TP+2%/SL-1% 배리어 + 왕복수수료 0.11% 차감 기준. 표본 n이 작으면 신뢰 불가.",
    }
    return out


@app.get("/api/backtest")
async def api_backtest_get():
    """저장된 백테스트 결과 조회"""
    return _load_backtest()


@app.post("/api/backtest/save")
async def api_backtest_save(req: Request):
    """단일 종목 백테스트 결과 저장"""
    try:
        body = await req.json()
        sym = body.get("symbol")
        if not sym:
            return {"ok": False, "error": "no symbol"}
        data = _load_backtest()
        body["ts"] = int(_time.time())
        data[sym] = body
        _save_backtest(data)
        return {"ok": True, "symbol": sym}
    except Exception as e:
        return {"ok": False, "error": str(e)}


@app.post("/api/backtest/clear")
async def api_backtest_clear():
    """전체 백테스트 결과 삭제"""
    _save_backtest({})
    return {"ok": True}


@app.get("/api/symbols")
async def api_symbols():
    """프론트엔드에서 SYMBOLS 리스트 조회용"""
    return {"symbols": SYMBOLS, "stocks": [s for s, _ in STOCKS]}


_upbit_markets_cache = {"list": None, "ts": 0}


async def _get_upbit_krw_markets(client):
    """업비트 KRW 마켓 리스트 조회 (1시간 캐시)"""
    now = _time.time()
    if _upbit_markets_cache["list"] and now - _upbit_markets_cache["ts"] < 3600:
        return _upbit_markets_cache["list"]
    try:
        r = await client.get("https://api.upbit.com/v1/market/all", params={"isDetails": "false"})
        markets = r.json()
        krw = [m["market"] for m in markets if m.get("market", "").startswith("KRW-")]
        _upbit_markets_cache["list"] = krw
        _upbit_markets_cache["ts"] = now
        return krw
    except Exception:
        return _upbit_markets_cache["list"] or []


@app.get("/api/kimchi-premium")
async def api_kimchi_premium():
    """김치프리미엄: 업비트(KRW) vs Bybit(USD) 가격 차이"""
    now = _time.time()
    if _kimchi_cache["data"] and now - _kimchi_cache["ts"] < 5:
        return _kimchi_cache["data"]
    try:
        async with _httpx.AsyncClient(timeout=10.0) as c:
            # 1) 업비트 KRW 마켓 리스트 가져오기 (1시간 캐시)
            krw_markets = await _get_upbit_krw_markets(c)
            krw_market_set = set(krw_markets)
            # 2) SYMBOLS 중 업비트 KRW 마켓에 존재하는 종목만 필터 (URL 길이 제한 회피)
            valid_markets = []
            for s in SYMBOLS:
                coin = s.replace("USDT", "")
                m = f"KRW-{coin}"
                if m in krw_market_set:
                    valid_markets.append(m)
                if len(valid_markets) >= 100:  # 안전장치
                    break
            if not valid_markets:
                # 업비트 마켓 조회 실패 시 fallback: 메이저 코인만
                valid_markets = ["KRW-BTC","KRW-ETH","KRW-SOL","KRW-XRP","KRW-DOGE",
                                 "KRW-ADA","KRW-AVAX","KRW-DOT","KRW-LINK","KRW-SUI",
                                 "KRW-PEPE","KRW-WIF","KRW-ARB","KRW-OP"]

            # 3) 업비트 시세 + 실시간 환율(forex) 병렬 호출
            #    ⚠️ 환율은 kimpga와 동일하게 '실시간 원/달러 forex'를 사용한다.
            #    업비트 USDT-KRW를 환율로 쓰면 안 됨 — USDT 자체에 김프가 끼어 있어
            #    그걸 환율로 나누면 코인 김프가 0% 근처로 왜곡된다(기존 버그).
            #    또한 fawaz/frankfurter는 '일 1회' 갱신이라 장중에 멈춰 보였음.
            #    Dunamu(두나무=업비트 모회사, 실시간 갱신) → frankfurter → fawazahmed 순.
            upbit_r, dunamu_r, frank_r, fawaz_r, usdt_r = await asyncio.gather(
                c.get("https://api.upbit.com/v1/ticker", params={"markets": ",".join(valid_markets)}),
                c.get("https://quotation-api-cdn.dunamu.com/v1/forex/recent", params={"codes": "FRX.KRWUSD"}),
                c.get("https://api.frankfurter.app/latest", params={"from": "USD", "to": "KRW"}),
                c.get("https://cdn.jsdelivr.net/npm/@fawazahmed0/currency-api@latest/v1/currencies/usd.json"),
                c.get("https://api.upbit.com/v1/ticker", params={"markets": "KRW-USDT"}),
                return_exceptions=True,
            )
            upbit = upbit_r.json() if hasattr(upbit_r, "status_code") and upbit_r.status_code == 200 else []
            usd_krw = None
            rate_source = None
            # (a) Dunamu 실시간 forex (kimpga와 동일 기준)
            try:
                if hasattr(dunamu_r, "status_code") and dunamu_r.status_code == 200:
                    dd = dunamu_r.json()
                    if isinstance(dd, list) and dd and dd[0].get("basePrice"):
                        usd_krw = float(dd[0]["basePrice"]); rate_source = "dunamu"
            except Exception:
                pass
            # (b) frankfurter (ECB 기준, 영업일 갱신)
            if not usd_krw:
                try:
                    if hasattr(frank_r, "status_code") and frank_r.status_code == 200:
                        kr = frank_r.json().get("rates", {}).get("KRW")
                        if kr:
                            usd_krw = float(kr); rate_source = "frankfurter"
                except Exception:
                    pass
            # (c) fawazahmed (최후 fallback)
            if not usd_krw:
                try:
                    fx = fawaz_r.json() if hasattr(fawaz_r, "status_code") else {}
                    usd_krw = float(fx.get("usd", {}).get("krw", 1400)); rate_source = "fawaz"
                except Exception:
                    usd_krw = 1400; rate_source = "default"
            # 참고용: 업비트 USDT-KRW (USDT 김프 모니터링용 — 환율로는 쓰지 않음)
            usdt_krw = None
            try:
                if hasattr(usdt_r, "status_code") and usdt_r.status_code == 200:
                    ud = usdt_r.json()
                    if isinstance(ud, list) and ud:
                        usdt_krw = float(ud[0]["trade_price"])
            except Exception:
                pass

            result = {"usd_krw": usd_krw, "rate_source": rate_source, "usdt_krw": usdt_krw, "coins": {}}
            if isinstance(upbit, list):
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


@app.get("/api/coinness")
async def api_coinness(limit: int = 20):
    """코인니스 한국어 속보 (실시간). 10초 캐시.
    참고: Coinness 공개 API (api.coinness.com/feed/v1/breaking-news)."""
    now = _time.time()
    if _coinness_cache["data"] and now - _coinness_cache["ts"] < 10:
        return _coinness_cache["data"]
    try:
        async with _httpx.AsyncClient(timeout=8.0,
                                      headers={"User-Agent": "Mozilla/5.0",
                                               "Origin": "https://coinness.com",
                                               "Referer": "https://coinness.com/"}) as c:
            r = await c.get("https://api.coinness.com/feed/v1/breaking-news",
                            params={"lang": "ko", "limit": int(limit)})
            if r.status_code != 200:
                return {"error": f"HTTP {r.status_code}", "list": []}
            items = r.json() if isinstance(r.json(), list) else r.json().get("list", [])
            result = {"list": items, "ts": int(now)}
            _coinness_cache["data"] = result
            _coinness_cache["ts"] = now
            return result
    except Exception as e:
        return {"error": str(e), "list": []}


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
async def landing(request: Request):
    # 공개 랜딩 페이지 (마케팅/포트폴리오). 게이트 무관 항상 공개.
    _log_access("landing_view", request)
    return templates.TemplateResponse("landing.html", {"request": request})


@app.get("/dashboard", response_class=HTMLResponse)
async def dashboard(request: Request):
    # 실제 대시보드. ACCESS_CODES 설정 시 미들웨어가 세션 검사.
    return templates.TemplateResponse("index.html", {"request": request, "symbols": SYMBOLS, "stocks": STOCKS})


# ─────────────────────────────────────────────────────────────────────────
# ⚠️ 아래 Bybit REST 엔드포인트는 프로덕션(Railway)에서 DEAD CODE다.
#    Railway egress IP가 Bybit CloudFront에 차단되어 서버측 호출은 실패/타임아웃한다.
#    따라서 프론트엔드(static/app.js)는 이 백엔드 경로를 호출하지 않고,
#    사용자 브라우저에서 Bybit Public API를 '직접' 호출한다(CORS 허용).
#    → 이 라우트들은 로컬/개발 환경 디버깅용으로만 남겨둔 것이며,
#      프론트엔드 데이터 경로와 무관하므로 '백엔드 차단 → 프론트 NaN' 연쇄는 발생하지 않는다.
#    (검증: grep 결과 프론트엔드에서 /api/orderbook|ratio|kline|tickers 등 호출 0건)
# ─────────────────────────────────────────────────────────────────────────
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
    # CME에 실제 상장된 코인만 CME갭이 의미가 있다. 나머지는 미상장이므로 빈 결과 반환.
    CME_LISTED = {"BTCUSDT", "ETHUSDT", "SOLUSDT", "XRPUSDT"}
    if symbol.upper() not in CME_LISTED:
        return []  # CME 미상장 코인은 CME갭 계산 자체가 무의미
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
    """API 키로 트레이더 연결 (인증 필요)"""
    auth = _check_trader_auth(request)
    if auth: return auth
    body = await request.json()
    # 복사붙여넣기 시 끼는 앞뒤 공백/개행 제거 (서명 깨짐 방지)
    key = (body.get("api_key", "") or "").strip()
    secret = (body.get("api_secret", "") or "").strip()
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
    """자동매매 ON/OFF (인증 필요)"""
    auth = _check_trader_auth(request)
    if auth: return auth
    body = await request.json()
    auto_trader.auto_trade_enabled = body.get("enabled", False)
    return {"enabled": auto_trader.auto_trade_enabled}


@app.post("/api/trader/config")
async def api_trader_config(request: Request):
    """자동매매 설정 변경 (인증 필요)"""
    auth = _check_trader_auth(request)
    if auth: return auth
    body = await request.json()
    for k, v in body.items():
        if k in auto_trader.auto_trade_config:
            auto_trader.auto_trade_config[k] = v
    return {"config": auto_trader.auto_trade_config}


@app.post("/api/trader/execute")
async def api_trader_execute(request: Request):
    """수동 주문 실행 (인증 필요)"""
    auth = _check_trader_auth(request)
    if auth: return auth
    body = await request.json()
    if not auto_trader.trader_instance:
        return {"status": "error", "message": "트레이더 미연결"}
    return await auto_trader.trader_instance.place_order(**body)


@app.get("/api/trader/positions")
async def api_trader_positions(request: Request):
    auth = _check_trader_auth(request)
    if auth: return auth
    if not auto_trader.trader_instance:
        return {"status": "error", "message": "미연결"}
    return await auto_trader.trader_instance.get_positions()


@app.get("/api/trader/balance")
async def api_trader_balance(request: Request):
    auth = _check_trader_auth(request)
    if auth: return auth
    if not auto_trader.trader_instance:
        return {"status": "error", "message": "미연결"}
    return await auto_trader.trader_instance.get_wallet_balance()


@app.get("/api/trader/log")
async def api_trader_log(request: Request):
    auth = _check_trader_auth(request)
    if auth: return auth
    return {"log": auto_trader.trade_log, "enabled": auto_trader.auto_trade_enabled,
            "config": auto_trader.auto_trade_config}


@app.post("/api/trader/signal-trade")
async def api_signal_trade(request: Request):
    """매매 신호 기반 자동 주문 (인증 필요)"""
    auth = _check_trader_auth(request)
    if auth: return auth
    body = await request.json()
    return await execute_signal_trade(
        body.get("direction", ""),
        body.get("score", 0),
        body.get("price", 0),
        symbol=body.get("symbol"),  # 멀티코인: 프론트가 종목 지정 (없으면 config 종목)
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
