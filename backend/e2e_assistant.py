"""Local end-to-end helper: the real API (sample data) with a stand-in for Claude, so the assistant's
panel can be exercised in a browser without an API key or any cost.

    DATA_DIR=/tmp/egx-e2e uvicorn e2e_assistant:app --port 8000
"""
import json
import time

from app.config import Settings
from app.main import create_app

USAGE = {"input": 1200, "output": 150, "cache_read": 4000, "cache_write": 0}


class RuleModel:
    """Answers by simple rules on the user's last words; streams its text word by word."""

    name = "claude-opus-5-5"
    n = 0

    def turn(self, *, system, tools, messages):
        last = messages[-1]["content"]
        results = [b for b in last if b["type"] == "tool_result"]
        words = " ".join(b["text"] for b in last if b["type"] == "text" and not b["text"].startswith("<context>")).lower()
        calls, text = [], ""
        if results:
            data = json.loads(results[0]["content"]) if results[0]["content"].startswith("{") else {}
            if results[0].get("is_error") or "did not approve" in results[0]["content"]:
                text = "That was not done."
            elif "summary" in data:
                text = (f"**Portfolio** (paper)\n\n| Item | EGP |\n|---|---|\n| Cash | {data['summary']['cash']:,.2f} |\n"
                        f"| Total value | {data['summary']['total_value']:,.2f} |\n\n- Holdings: {len(data['holdings'])}\n- Mode: `paper`")
            elif "recorded" in data:
                r = data["recorded"]
                text = f"تم: {r['type']} {r['qty']} {r['symbol']} بسعر {r['price']}، والكاش الباقي EGP {data['cash_after']:,.2f}."
            else:
                text = "Done."
        elif "buy" in words:
            calls = [self._call("place_trade", side="BUY", symbol="COMI", qty=10, note="from the assistant")]
            text = "Placing the paper trade."
        elif "open" in words:
            calls = [self._call("open_page", page="stock", symbol="TMGH")]
        elif "watch" in words:
            calls = [self._call("set_watch", symbol="SWDY", watched=True)]
        elif "portfolio" in words or "المحفظة" in words:
            calls = [self._call("portfolio")]
        else:
            text = "I can look things up and act in the app. Try: *review my portfolio*, *buy 10 COMI*."
        yield {"type": "progress", "text": "Thinking about the request"}
        for word in text.split(" ") if text else []:
            time.sleep(0.03)
            yield {"type": "text", "text": word + " "}
        content = [{"type": "thinking", "thinking": "", "signature": f"s{self.n}"}]
        content += [{"type": "text", "text": text}] if text else []
        content += [{"type": "tool_use", **c} for c in calls]
        yield {"type": "final", "message": {"content": content, "tool_calls": calls, "model": self.name, "refusal_category": None,
                                            "usage": dict(USAGE), "stop_reason": "tool_use" if calls else "end_turn"}}

    def _call(self, name, **args):
        self.n += 1
        return {"id": f"toolu_e2e_{self.n}", "name": name, "input": args}


app = create_app(Settings(), assistant_model=RuleModel())
