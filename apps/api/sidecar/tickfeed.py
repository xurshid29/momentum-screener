#!/usr/bin/env python3
"""Databento EQUS.MINI live tick-feed sidecar.

No official Node client exists for Databento's live feed (binary DBN over raw
TCP), so this thin Python process owns the transport and forwards normalized
per-second bars to the parent Node TickFeedService as newline-delimited JSON
on stdout. The parent drives subscriptions over stdin.

PROTOCOL
  stdin  (commands, one per line):
    SUB AAA,BBB,CCC      subscribe these raw symbols (additive; sent in chunks)
  stdout (data, one JSON object per line):
    {"t":1718000000,"s":"DSY","o":2.04,"h":2.04,"l":2.04,"c":2.04,"v":300}
  stderr: human logs (flow to the Node process log). Lines containing "ERROR"
    are scraped by the parent into /health.tickfeed.last_error.

Env: DATABENTO_API_KEY. Dataset/schema are fixed to EQUS.MINI / ohlcv-1s.

LIFECYCLE / CONNECTION HYGIENE (the 2026-06-22 fix)
  Databento caps concurrent Live connections per account. The original code
  created a Live client per retry and never closed it, so failed-subscribe
  retries leaked connections until the cap was hit and the feed wedged (had to
  restart the api container to recover). Now: every run_once closes its client
  in a finally; SIGTERM/SIGINT (docker stop / deploy) cleanly stop the session
  so the slot frees immediately for the next container; and a connection-limit
  error backs off long enough for an overlapping session to drain.
"""
import json
import os
import signal
import sys
import threading
import time

DATASET = "EQUS.MINI"
SCHEMA = "ohlcv-1s"
PX_SCALE = 1e-9  # DBN fixed-point prices are integers in units of 1e-9

# Set on SIGTERM/SIGINT so the run loop and stream iteration unwind cleanly.
_stop = threading.Event()
# The Live client currently in use, so the signal handler can stop it (and thus
# release the Databento connection) even while the main thread blocks iterating.
_current_client = None


def log(msg: str) -> None:
    print(f"[tickfeed.py] {msg}", file=sys.stderr, flush=True)


def emit(obj: dict) -> None:
    sys.stdout.write(json.dumps(obj, separators=(",", ":")) + "\n")
    sys.stdout.flush()


def _shutdown(signum, _frame) -> None:
    log(f"signal {signum} — releasing Databento session and exiting")
    _stop.set()
    c = _current_client
    if c is not None:
        try:
            c.stop()
        except Exception:  # noqa: BLE001
            pass
    # Exit promptly so docker's stop grace window cleanly closes the TCP (and
    # the connection slot) before the next container's sidecar subscribes.
    sys.exit(0)


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


def run_once(key: str):
    """One Live session. Returns an error string (for the parent + backoff
    decision) or None on a clean end. Always closes its client."""
    global _current_client
    import databento as db

    client = db.Live(key=key)
    _current_client = client
    id_to_symbol: dict[int, str] = {}
    subscribed: set[str] = set()
    sub_lock = threading.Lock()
    pending_first = threading.Event()
    fatal = threading.Event()
    err = {"msg": None}

    def do_sub(syms):
        new = [s for s in syms if s not in subscribed]
        if not new:
            pending_first.set()
            return
        try:
            with sub_lock:
                # Databento caps symbols per subscribe call; chunk to be safe.
                for i in range(0, len(new), 500):
                    chunk = new[i : i + 500]
                    client.subscribe(dataset=DATASET, schema=SCHEMA,
                                     stype_in="raw_symbol", symbols=chunk)
                    subscribed.update(chunk)
            log(f"subscribed +{len(new)} (total {len(subscribed)})")
            pending_first.set()
        except Exception as e:  # noqa: BLE001
            err["msg"] = str(e)
            log(f"ERROR subscribe failed: {e}")
            fatal.set()
            pending_first.set()  # unblock main so it can close + back off

    try:
        threading.Thread(target=stdin_reader, args=(do_sub,), daemon=True).start()

        # Wait for the parent's first SUB before iterating (the client needs at
        # least one subscription to open the stream).
        if not pending_first.wait(timeout=120):
            log("no symbols within 120s — exiting to retry")
            return "no-symbols"
        if fatal.is_set():
            return err["msg"] or "subscribe-failed"

        log("streaming…")
        for record in client:
            if _stop.is_set():
                break
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
        return None
    except Exception as e:  # noqa: BLE001
        log(f"ERROR stream: {e}")
        return str(e)
    finally:
        # Always release the connection — this is the leak fix. Without it a
        # failed/ended session's connection lingered and the slots ran out.
        try:
            client.stop()
        except Exception:  # noqa: BLE001
            pass
        _current_client = None


def main() -> None:
    key = os.environ.get("DATABENTO_API_KEY")
    if not key:
        log("ERROR DATABENTO_API_KEY not set — exiting")
        sys.exit(1)
    signal.signal(signal.SIGTERM, _shutdown)
    signal.signal(signal.SIGINT, _shutdown)

    backoff = 2
    while not _stop.is_set():
        err = None
        try:
            err = run_once(key)
        except SystemExit:
            raise
        except Exception as e:  # noqa: BLE001
            err = str(e)
            log(f"ERROR run_once: {e}")
        if _stop.is_set():
            break
        if err and ("connection limit" in err.lower() or "open connection" in err.lower()):
            # An overlapping session (e.g. the previous container during a
            # deploy) still holds the slot. Wait long enough for it to drain
            # rather than tight-looping and leaking more attempts.
            wait = 30
            log(f"connection-limit — backing off {wait}s for the slot to free")
        elif err:
            wait = backoff
            backoff = min(backoff * 2, 60)
        else:
            wait = backoff  # clean end (rare) — gentle retry, reset escalation
            backoff = 2
        time.sleep(wait)


if __name__ == "__main__":
    main()
