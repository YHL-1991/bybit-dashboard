#!/bin/bash
cd "$(dirname "$0")"
exec /usr/bin/python3 -m uvicorn app:app --host 0.0.0.0 --port 8000
