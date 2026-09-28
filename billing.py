"""회원 / 구독 / 결제 (SQLite, 표준 라이브러리만 사용)

구조
  users   : 이메일 계정. trial_until(무료체험 만료), paid_until(유료 만료)
  orders  : 결제 요청. method별로 확인 방식이 다르지만 결제 확정은 반드시 confirm_order() 한 곳을 거친다.
            → 나중에 PG(카드) 웹훅이나 토큰 결제 검증이 붙어도 이 함수만 호출하면 구독이 연장된다.

결제 수단 (PAYMENT_METHODS)
  bank : 무통장입금. 입금자명을 받고 관리자가 확인 후 확정
  usdt : USDT 송금. 트랜잭션 해시를 받고 관리자가 확인 후 확정
  (예정) card  : PG 연동 후 웹훅에서 confirm_order 호출
  (예정) token : 자체 토큰 결제. 온체인 전송 확인 후 confirm_order 호출
"""
import hashlib
import hmac
import os
import secrets
import sqlite3
import time
from contextlib import contextmanager
from typing import Optional

# ─── 요금제 ───
# 초기 가격 (2026-09 결정). 바꿀 때는 이 표만 수정하면 된다.
PLANS = {
    "pro_1m": {"name": "Pro 1개월", "days": 30, "krw": 29000, "usdt": 20},
    "pro_3m": {"name": "Pro 3개월", "days": 90, "krw": 79000, "usdt": 55},
    "pro_12m": {"name": "Pro 12개월", "days": 365, "krw": 290000, "usdt": 200},
}
TRIAL_DAYS = int(os.environ.get("TRIAL_DAYS", "7"))

PAYMENT_METHODS = {
    "bank": {"name": "무통장입금", "currency": "KRW", "ref_label": "입금자명"},
    "usdt": {"name": "USDT 송금", "currency": "USDT", "ref_label": "트랜잭션 해시(TxID)"},
}

_DAY = 86400
_PBKDF2_ITER = 390_000


def _db_path() -> str:
    base = os.environ.get("DATA_DIR", os.path.join(os.path.dirname(__file__), "data"))
    return os.path.join(base, "velox.db")


@contextmanager
def _conn():
    """블록이 끝나면 커밋(예외 시 롤백)하고 연결을 닫는다."""
    c = sqlite3.connect(_db_path())
    c.row_factory = sqlite3.Row
    try:
        with c:
            yield c
    finally:
        c.close()


def init_db():
    with _conn() as c:
        c.executescript("""
        CREATE TABLE IF NOT EXISTS users (
            id          INTEGER PRIMARY KEY AUTOINCREMENT,
            email       TEXT UNIQUE NOT NULL,
            pw_hash     TEXT NOT NULL,
            created     INTEGER NOT NULL,
            trial_until INTEGER NOT NULL DEFAULT 0,
            paid_until  INTEGER NOT NULL DEFAULT 0
        );
        CREATE TABLE IF NOT EXISTS orders (
            id        TEXT PRIMARY KEY,
            user_id   INTEGER NOT NULL REFERENCES users(id),
            plan      TEXT NOT NULL,
            method    TEXT NOT NULL,
            amount    REAL NOT NULL,
            currency  TEXT NOT NULL,
            payer_ref TEXT NOT NULL DEFAULT '',
            status    TEXT NOT NULL DEFAULT 'pending',  -- pending / paid / cancelled
            created   INTEGER NOT NULL,
            paid_at   INTEGER NOT NULL DEFAULT 0
        );
        CREATE INDEX IF NOT EXISTS idx_orders_user ON orders(user_id);
        """)


# ─── 비밀번호 ───
def _hash_pw(pw: str) -> str:
    salt = secrets.token_hex(16)
    dk = hashlib.pbkdf2_hmac("sha256", pw.encode(), bytes.fromhex(salt), _PBKDF2_ITER).hex()
    return f"pbkdf2${_PBKDF2_ITER}${salt}${dk}"


def _check_pw(pw: str, stored: str) -> bool:
    try:
        _, it, salt, dk = stored.split("$")
        got = hashlib.pbkdf2_hmac("sha256", pw.encode(), bytes.fromhex(salt), int(it)).hex()
        return hmac.compare_digest(got, dk)
    except Exception:
        return False


# ─── 사용자 ───
def _norm_email(email: str) -> str:
    return (email or "").strip().lower()[:160]


def create_user(email: str, pw: str):
    """성공 시 (user, None), 실패 시 (None, 메시지)"""
    email = _norm_email(email)
    if "@" not in email or "." not in email.split("@")[-1]:
        return None, "이메일 형식이 올바르지 않습니다."
    if len(pw or "") < 8:
        return None, "비밀번호는 8자 이상이어야 합니다."
    now = int(time.time())
    try:
        with _conn() as c:
            cur = c.execute(
                "INSERT INTO users(email, pw_hash, created, trial_until) VALUES(?,?,?,?)",
                (email, _hash_pw(pw), now, now + TRIAL_DAYS * _DAY))
            uid = cur.lastrowid
    except sqlite3.IntegrityError:
        return None, "이미 가입된 이메일입니다."
    return get_user(uid), None


def authenticate(email: str, pw: str) -> Optional[dict]:
    with _conn() as c:
        row = c.execute("SELECT * FROM users WHERE email=?", (_norm_email(email),)).fetchone()
    if row and _check_pw(pw or "", row["pw_hash"]):
        return dict(row)
    return None


def get_user(uid) -> Optional[dict]:
    with _conn() as c:
        row = c.execute("SELECT * FROM users WHERE id=?", (uid,)).fetchone()
    return dict(row) if row else None


def get_user_by_email(email: str) -> Optional[dict]:
    with _conn() as c:
        row = c.execute("SELECT * FROM users WHERE email=?", (_norm_email(email),)).fetchone()
    return dict(row) if row else None


def list_users() -> list:
    with _conn() as c:
        return [dict(r) for r in c.execute("SELECT * FROM users ORDER BY created DESC")]


def access_until(user: dict) -> int:
    return max(int(user.get("trial_until") or 0), int(user.get("paid_until") or 0))


def is_active(user: Optional[dict]) -> bool:
    return bool(user) and access_until(user) > time.time()


def status_label(user: dict) -> str:
    now = time.time()
    if int(user.get("paid_until") or 0) > now:
        return "Pro"
    if int(user.get("trial_until") or 0) > now:
        return "무료체험"
    return "만료"


def _extend(c: sqlite3.Connection, uid: int, days: int):
    """유료 기간 연장. 남은 기간이 있으면 그 뒤에 이어 붙인다."""
    row = c.execute("SELECT paid_until FROM users WHERE id=?", (uid,)).fetchone()
    if not row:
        return
    start = max(int(time.time()), int(row["paid_until"] or 0))
    c.execute("UPDATE users SET paid_until=? WHERE id=?", (start + days * _DAY, uid))


def extend_user(uid: int, days: int):
    with _conn() as c:
        _extend(c, uid, days)


# ─── 주문 ───
def create_order(uid: int, plan: str, method: str, payer_ref: str):
    """성공 시 (order, None), 실패 시 (None, 메시지)"""
    p = PLANS.get(plan)
    m = PAYMENT_METHODS.get(method)
    if not p or not m:
        return None, "요금제 또는 결제 수단이 올바르지 않습니다."
    payer_ref = (payer_ref or "").strip()[:200]
    if not payer_ref:
        return None, f"{m['name']}에는 {m['ref_label']}이(가) 필요합니다."
    amount = p["krw"] if m["currency"] == "KRW" else p["usdt"]
    oid = "VX" + time.strftime("%y%m%d") + secrets.token_hex(3).upper()
    with _conn() as c:
        # 같은 사용자의 대기 주문은 하나만 유지 (중복 신청 방지)
        c.execute("UPDATE orders SET status='cancelled' WHERE user_id=? AND status='pending'", (uid,))
        c.execute(
            "INSERT INTO orders(id,user_id,plan,method,amount,currency,payer_ref,created) VALUES(?,?,?,?,?,?,?,?)",
            (oid, uid, plan, method, amount, m["currency"], payer_ref, int(time.time())))
    return get_order(oid), None


def get_order(oid: str) -> Optional[dict]:
    with _conn() as c:
        row = c.execute("SELECT * FROM orders WHERE id=?", (oid,)).fetchone()
    return dict(row) if row else None


def list_orders(uid: Optional[int] = None) -> list:
    q = ("SELECT o.*, u.email FROM orders o JOIN users u ON u.id=o.user_id "
         + ("WHERE o.user_id=? " if uid is not None else "") + "ORDER BY o.created DESC")
    with _conn() as c:
        return [dict(r) for r in c.execute(q, (uid,) if uid is not None else ())]


def confirm_order(oid: str) -> bool:
    """결제 확정. 모든 결제 수단이 이 함수 하나로 구독을 연장한다. 두 번 호출돼도 한 번만 반영."""
    with _conn() as c:
        cur = c.execute(
            "UPDATE orders SET status='paid', paid_at=? WHERE id=? AND status='pending'",
            (int(time.time()), oid))
        if cur.rowcount != 1:
            return False
        row = c.execute("SELECT user_id, plan FROM orders WHERE id=?", (oid,)).fetchone()
        _extend(c, row["user_id"], PLANS[row["plan"]]["days"])  # 같은 트랜잭션에서 연장
    return True


def cancel_order(oid: str) -> bool:
    with _conn() as c:
        cur = c.execute("UPDATE orders SET status='cancelled' WHERE id=? AND status='pending'", (oid,))
        return cur.rowcount == 1
