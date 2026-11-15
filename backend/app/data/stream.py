"""One-shot snapshots from a Lightstreamer server.

Younit publishes live quotes only on its streaming channel. A serverless
function cannot hold a stream open, so this connects, asks for the current
value of every item, collects the answers and disconnects: a few seconds, once
a minute, while the market is open. Read-only: only market-data items are
subscribed, never the orders stream.
"""
from __future__ import annotations

import threading
import time


class StreamError(RuntimeError):
    pass


class _Quiet:
    """Listener base: the client library calls many hooks; ignore the ones not needed."""

    def __getattr__(self, name):
        return lambda *args, **kwargs: None


def snapshot(url: str, adapter_set: str, groups: list[dict], *, user: str | None = None, password: str | None = None,
             timeout: float = 8.0, grace: float = 0.6) -> dict:
    """Subscribe to each group ({"items", "fields", "data_adapter", "required"}) and return what arrives.

    Returns {"values": {item: {field: value}}, "errors": [...], "status": last connection status}.
    Waits until every item of the `required` groups has answered, or `timeout`.
    """
    from lightstreamer.client import LightstreamerClient, Subscription

    values: dict[str, dict] = {}
    errors: list[str] = []
    state = {"status": "", "failed": None}
    lock = threading.Lock()
    done = threading.Event()
    wanted = {item for g in groups if g.get("required", True) for item in g["items"]}
    failed_items: set[str] = set()

    def check() -> None:
        if wanted <= (set(values) | failed_items):
            done.set()

    class Connection(_Quiet):
        def onStatusChange(self, status):  # noqa: N802 - library callback name
            state["status"] = status

        def onServerError(self, code, message):  # noqa: N802
            state["failed"] = f"streaming server refused the connection ({code}: {message})"
            done.set()

    def listener(group: dict):
        class Sub(_Quiet):
            def onItemUpdate(self, update):  # noqa: N802
                with lock:
                    row = values.setdefault(update.getItemName(), {})
                    for field in group["fields"]:
                        value = update.getValue(field)
                        if value is not None:
                            row[field] = value
                    check()

            def onSubscriptionError(self, code, message):  # noqa: N802
                with lock:
                    errors.append(f"{group['items'][0]}…: {code} {message}"[:160])
                    failed_items.update(group["items"])
                    check()
        return Sub()

    client = LightstreamerClient(url, adapter_set)
    if user is not None:
        client.connectionDetails.setUser(user)
        client.connectionDetails.setPassword(password)
    client.addListener(Connection())
    try:
        client.connect()
        for group in groups:
            sub = Subscription("MERGE", group["items"], group["fields"])
            if group.get("data_adapter"):
                sub.setDataAdapter(group["data_adapter"])
            sub.setRequestedSnapshot("yes")
            sub.addListener(listener(group))
            client.subscribe(sub)
        finished = done.wait(timeout)
        if finished and not state["failed"]:
            time.sleep(grace)  # let the optional groups answer too
    finally:
        try:
            client.disconnect()
        except Exception:  # noqa: BLE001 - nothing useful to do if hanging up fails
            pass
    if state["failed"]:
        raise StreamError(state["failed"])
    if not values:
        raise StreamError(f"the streaming server sent no prices (connection: {state['status'] or 'never connected'})"
                          + (f"; {errors[0]}" if errors else ""))
    return {"values": values, "errors": errors[:5], "status": state["status"]}


def follow(url: str, adapter_set: str, group: dict | list[dict], *, user: str | None = None, password: str | None = None,
           max_seconds: float = 240.0, heartbeat: float = 15.0, settle: float = 0.25):
    """Stay subscribed to one or more groups and yield {item: {field: value}} every time something changes.

    Only the fields that changed are yielded for an item (its first message carries them all).

    Yields None when `heartbeat` seconds pass in silence (so the caller can keep
    its own connection alive) and stops after `max_seconds`. Bursts of updates
    within `settle` seconds are merged into one. Always disconnects on exit,
    including when the consumer stops iterating.
    """
    import queue

    from lightstreamer.client import LightstreamerClient, Subscription

    events: queue.Queue = queue.Queue()

    class Connection(_Quiet):
        def onServerError(self, code, message):  # noqa: N802
            events.put(StreamError(f"streaming server refused the connection ({code}: {message})"))

    groups = [group] if isinstance(group, dict) else list(group)
    refused = {"count": 0}

    def listener(g: dict):
        class Sub(_Quiet):
            def onItemUpdate(self, update):  # noqa: N802
                row = {}
                for field in g["fields"]:
                    value = update.getValue(field)
                    if value is not None:
                        row[field] = value
                events.put((update.getItemName(), row))

            def onSubscriptionError(self, code, message):  # noqa: N802
                refused["count"] += 1
                # One refused group among several is survivable; all of them is not.
                if g.get("required", True) and refused["count"] >= sum(1 for x in groups if x.get("required", True)):
                    events.put(StreamError(f"subscription refused ({code}: {message})"))
        return Sub()

    client = LightstreamerClient(url, adapter_set)
    if user is not None:
        client.connectionDetails.setUser(user)
        client.connectionDetails.setPassword(password)
    client.addListener(Connection())
    subs = []
    for g in groups:
        sub = Subscription("MERGE", g["items"], g["fields"])
        if g.get("data_adapter"):
            sub.setDataAdapter(g["data_adapter"])
        sub.setRequestedSnapshot("yes")
        sub.addListener(listener(g))
        subs.append(sub)
    deadline = time.monotonic() + max_seconds
    state: dict[str, dict] = {}
    try:
        client.connect()
        for sub in subs:
            client.subscribe(sub)
        while True:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                return
            try:
                event = events.get(timeout=min(heartbeat, remaining))
            except queue.Empty:
                yield None
                continue
            changed: dict[str, dict] = {}
            end = time.monotonic() + settle
            while True:
                if isinstance(event, Exception):
                    raise event
                item, row = event
                known = state.setdefault(item, {})
                delta = {k: v for k, v in row.items() if known.get(k) != v}
                if delta:
                    known.update(delta)
                    changed.setdefault(item, {}).update(delta)
                try:
                    event = events.get(timeout=max(end - time.monotonic(), 0))
                except queue.Empty:
                    break
            if changed:
                yield {item: {"changed": delta, "row": dict(state[item])} for item, delta in changed.items()}
    finally:
        try:
            client.disconnect()
        except Exception:  # noqa: BLE001 - nothing useful to do if hanging up fails
            pass
