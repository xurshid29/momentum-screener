#!/usr/bin/env python3
"""Databento EQUS.MINI live tick-feed sidecar.

No official Node client exists for Databento's live feed (binary DBN over raw
TCP), so this thin Python process owns the transport and forwards normalized
per-second bars to the parent Node TickFeedService as newline-delimited JSON
on stdout. The parent drives subscriptions over stdin.

PROTOCOL
  stdin  (commands, one per line):
    SUB AAA,BBB,CCC      subscribe these raw symbols (additive)
  stdout (data, one JSON object per line):
    {"t":1718000000,"s":"DSY","o":2.04,"h":2.04,"l":2.04,"c":2.04,"v":300}
  stderr: human logs (flow to the Node process log)

Env: DATABENTO_API_KEY. Dataset/schema are fixed to EQUS.MINI / ohlcv-1s.

NOTE: field access is wrapped defensively — confirm the OHLCVMsg /
SymbolMappingMsg attribute names against the live feed on first smoke-test
(databento-python versions have shifted these).
"""
import json
import os
import sys
import threading
import time

DATASET = "EQUS.MINI"
SCHEMA = "ohlcv-1s"
PX_SCALE = 1e-9  # DBN fixed-point prices are integers in units of 1e-9

def log(msg: str) -> None:
    print(f"[tickfeed.py] {msg}", file=sys.stderr, flush=True)

def emit(obj: dict) -> None:
    sys.stdout.write(json.dumps(obj, separators=(",", ":")) + "\n")
    sys.stdout.flush()

def stdin_reader(on_sub) -> None:
    """Feed SUB commands from the parent to the live client (runs in a thread)."""
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        if line.startswith("SUB "):
            syms = [s.strip().upper() for s in line[4:].split(",") if s.strip()]
            if syms:
                on_sub(syms)
        else:
            log(f"unknown command: {line[:40]}")

def run_once(key: str) -> None:
    import databento as db

    client = db.Live(key=key)
    id_to_symbol: dict[int, str] = {}
    subscribed: set[str] = set()
    sub_lock = threading.Lock()
    pending_first = threading.Event()

    def do_sub(syms):
        new = [s for s in syms if s not in subscribed]
        if not new:
            return
        with sub_lock:
            # Databento caps symbols per subscribe call; chunk to be safe.
            for i in range(0, len(new), 500):
                chunk = new[i : i + 500]
                client.subscribe(dataset=DATASET, schema=SCHEMA,
                                 stype_in="raw_symbol", symbols=chunk)
                subscribed.update(chunk)
        log(f"subscribed +{len(new)} (total {len(subscribed)})")
        pending_first.set()

    threading.Thread(target=stdin_reader, args=(do_sub,), daemon=True).start()

    # Wait for the parent's first SUB before iterating (the client needs at
    # least one subscription to open the stream).
    if not pending_first.wait(timeout=120):
        log("no symbols within 120s — exiting to retry")
        return

    log("streaming…")
    for record in client:
        rtype = type(record).__name__
        if rtype == "SymbolMappingMsg":
            try:
                id_to_symbol[record.instrument_id] = (
                    getattr(record, "stype_out_symbol", None)
                    or getattr(record, "raw_symbol", "")
                )
            except Exception as e:  # noqa: BLE001
                log(f"symbol map error: {e}")
        elif rtype == "OHLCVMsg":
            try:
                sym = id_to_symbol.get(record.instrument_id)
                if not sym:
                    continue
                emit({
                    "t": int(record.ts_event // 1_000_000_000),
                    "s": sym,
                    "o": round(record.open * PX_SCALE, 6),
                    "h": round(record.high * PX_SCALE, 6),
                    "l": round(record.low * PX_SCALE, 6),
                    "c": round(record.close * PX_SCALE, 6),
                    "v": int(record.volume),
                })
            except Exception as e:  # noqa: BLE001
                log(f"ohlcv error: {e}")

def main() -> None:
    key = os.environ.get("DATABENTO_API_KEY")
    if not key:
        log("DATABENTO_API_KEY not set — exiting")
        sys.exit(1)
    backoff = 2
    while True:
        try:
            run_once(key)
            backoff = 2
        except Exception as e:  # noqa: BLE001
            log(f"stream error: {e} — reconnecting in {backoff}s")
        time.sleep(backoff)
        backoff = min(backoff * 2, 60)

if __name__ == "__main__":
    main()
