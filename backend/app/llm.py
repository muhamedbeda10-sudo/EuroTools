"""The one place that talks to the Claude API.

Everything else in the assistant works with plain dictionaries, so the agent
loop can be tested with a scripted stand-in and no network.

The API key comes from the server's environment (ANTHROPIC_API_KEY). It is
never sent to the browser, logged, or stored. Without it the assistant is off.
"""
from __future__ import annotations

import time
from collections.abc import Iterator
from typing import Protocol

DEFAULT_MODEL = "claude-opus-5-5"
# Models this integration is written for (adaptive thinking, effort, 1M context).
SUPPORTED_MODELS = ("claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-5-5", "claude-fable-5-2")
EFFORTS = ("low", "medium", "high", "xhigh", "max")
# Output ceiling per model call (thinking included). A chat reply is far shorter; this only bounds a runaway.
MAX_TOKENS = 32000

FALLBACK_BETA = "server-side-fallback-2026-07-01"        # a declined request is retried on the model Anthropic recommends
BINDING_BETA = "thinking-binding-controls-2026-08-01"    # lets a changed prompt drop old reasoning instead of failing
UPDATES_BETA = "thinking-display-updates-2026-08-18"     # short progress notes between tool calls
PROGRESS_MODELS = ("claude-opus-5-5", "claude-sonnet-5-5", "claude-fable-5-2")

# USD per million tokens: (input, output, cache read, cache write). Used only for the estimate shown to the user.
PRICES = {
    "claude-opus-5-5": (4.0, 20.0, 0.20, 5.0),
    "claude-sonnet-5-5": (2.0, 10.0, 0.10, 2.5),
    "claude-haiku-5-5": (0.10, 0.50, 0.01, 0.125),
    "claude-fable-5-2": (8.0, 40.0, 0.20, 10.0),
}


class AssistantError(RuntimeError):
    """Something the user should be told in plain words (bad key, no credit, busy, ...)."""

    def __init__(self, message: str, *, retry_after: int | None = None):
        super().__init__(message)
        self.retry_after = retry_after


class AssistantModel(Protocol):
    name: str

    def turn(self, *, system: str, tools: list[dict], messages: list[dict]) -> Iterator[dict]:
        """One model call. Yields {"type": "text"|"progress"|"reset", ...} while it runs and
        finally {"type": "final", "message": {...}} (see `final_message`)."""


def cost_usd(model: str, usage: dict) -> float | None:
    """Approximate cost of one call; None when the model's prices are not known here."""
    price = PRICES.get(model)
    if price is None:
        return None
    tokens = (usage.get("input", 0), usage.get("output", 0), usage.get("cache_read", 0), usage.get("cache_write", 0))
    return sum(n * p for n, p in zip(tokens, price, strict=True)) / 1_000_000


def block_param(block) -> dict | None:
    """A response block in the shape the API takes back, unchanged in substance."""
    kind = block.type
    if kind == "text":
        return {"type": "text", "text": block.text} if block.text.strip() else None  # an empty text block is not accepted back
    if kind == "thinking":
        return {"type": "thinking", "thinking": block.thinking, "signature": block.signature}
    if kind == "redacted_thinking":
        return {"type": "redacted_thinking", "data": block.data}
    if kind == "tool_use":
        return {"type": "tool_use", "id": block.id, "name": block.name, "input": block.input}
    return block.model_dump(mode="json", by_alias=True, exclude_none=True)  # e.g. a `fallback` marker: kept where it was


def final_message(message) -> dict:
    """What the agent loop needs from a finished response.

    When a request was declined and re-run on a fallback model, the response holds a
    `fallback` marker. Reasoning and tool calls from before the last marker belong to the
    attempt that was declined: they are neither sent back nor run. Text and the marker
    itself stay in place.
    """
    blocks = list(message.content)
    boundary = max((i for i, b in enumerate(blocks) if b.type == "fallback"), default=-1)
    content, calls = [], []
    for i, block in enumerate(blocks):
        if i < boundary and block.type not in ("text", "fallback"):
            continue
        param = block_param(block)
        if param is None:
            continue
        content.append(param)
        if block.type == "tool_use":
            calls.append({"id": block.id, "name": block.name, "input": block.input})
    usage = message.usage
    details = getattr(message, "stop_details", None)
    return {
        "content": content, "tool_calls": calls, "stop_reason": message.stop_reason, "model": message.model,
        "refusal_category": getattr(details, "category", None) if details is not None else None,
        "usage": {"input": usage.input_tokens or 0, "output": usage.output_tokens or 0,
                  "cache_read": usage.cache_read_input_tokens or 0, "cache_write": usage.cache_creation_input_tokens or 0},
    }


def without_reasoning(messages: list[dict]) -> list[dict]:
    """The conversation with reasoning blocks and fallback markers removed (text and tool calls stay).

    This is the documented recovery for a request the API will not take with those blocks in it.
    """
    out = []
    for message in messages:
        content = message["content"]
        if isinstance(content, list):
            content = [b for b in content if b.get("type") not in ("thinking", "redacted_thinking", "fallback")]
            if not content:
                content = [{"type": "text", "text": "(no text)"}]
        out.append({"role": message["role"], "content": content})
    return out


class ClaudeModel:
    """Streams one model call at a time through the official SDK."""

    def __init__(self, api_key: str, model: str = DEFAULT_MODEL, effort: str = "medium", *, client=None, _shared: dict | None = None):
        self.name = model if model in SUPPORTED_MODELS else DEFAULT_MODEL
        self.effort = effort if effort in EFFORTS else "medium"
        # One connection and one memory of what the API accepts, shared by every model choice made from this object.
        self._shared = _shared if _shared is not None else {"key": api_key, "client": client, "plain": set(), "checked": {}}

    def using(self, model: str | None = None, effort: str | None = None) -> ClaudeModel:
        """The same connection with another model or effort: each account chooses its own in Settings."""
        return ClaudeModel("", model or self.name, effort or self.effort, _shared=self._shared)

    @property
    def client(self):
        # The SDK takes about a second to import. It is loaded on the assistant's first use,
        # so a server that never talks to Claude never pays for it.
        if self._shared["client"] is None:
            import anthropic
            self._shared["client"] = anthropic.Anthropic(api_key=self._shared["key"], max_retries=2, timeout=240.0)
        return self._shared["client"]

    @property
    def plain(self) -> bool:
        """True once the optional beta features were refused for this model; remembered for this server instance."""
        return self.name in self._shared["plain"]

    @plain.setter
    def plain(self, value: bool) -> None:
        (self._shared["plain"].add if value else self._shared["plain"].discard)(self.name)

    @property
    def _checked(self) -> tuple[float, str | None] | None:
        return self._shared["checked"].get(self.name)

    @_checked.setter
    def _checked(self, value: tuple[float, str | None]) -> None:
        self._shared["checked"][self.name] = value

    def check(self) -> str | None:
        """Is the key accepted and the model available? None when all is well, else what is wrong.

        Asks the API to describe the model, which uses no tokens and costs nothing. A good
        answer is remembered for the life of this server instance; a bad one for a minute.
        """
        import anthropic
        if self._checked is not None and (self._checked[1] is None or time.monotonic() - self._checked[0] < 60):
            return self._checked[1]
        try:
            self.client.models.retrieve(self.name)
            problem = None
        except anthropic.APIStatusError as exc:
            problem = _explain(exc)
        except anthropic.APIConnectionError:
            problem = "Could not reach Claude from the server."
        self._checked = (time.monotonic(), problem)
        return problem

    def turn(self, *, system: str, tools: list[dict], messages: list[dict]) -> Iterator[dict]:
        import anthropic
        bad_json = 0
        while True:
            try:
                yield from self._call(system, tools, messages)
                return
            except ValueError:
                # A tool call arrived as JSON the SDK could not read. Nothing can be answered: ask again.
                bad_json += 1
                if bad_json > 2:
                    raise AssistantError("The assistant's reply could not be read. Please try again.") from None
                yield {"type": "reset"}
            except anthropic.BadRequestError as exc:
                if self.plain or not _optional_feature_refused(exc):
                    raise AssistantError(_explain(exc)) from None
                self.plain = True  # carry on without the optional features
            except anthropic.RateLimitError as exc:
                raise AssistantError("Claude is receiving too many requests right now. Try again in a minute.",
                                     retry_after=_retry_after(exc)) from None
            except anthropic.APIStatusError as exc:
                raise AssistantError(_explain(exc)) from None
            except anthropic.APIConnectionError:
                raise AssistantError("Could not reach Claude. Check the connection and try again.") from None

    def _call(self, system: str, tools: list[dict], messages: list[dict]) -> Iterator[dict]:
        common = {
            "model": self.name, "max_tokens": MAX_TOKENS, "tools": tools,
            "system": [{"type": "text", "text": system}],
            "output_config": {"effort": self.effort},
            "cache_control": {"type": "ephemeral"},  # the growing conversation is read from cache on each step
        }
        if self.plain:
            manager = self.client.messages.stream(**common, messages=without_reasoning(messages), thinking={"type": "adaptive"})
        else:
            # If this app's instructions or tools change between releases, reasoning from older turns no
            # longer matches the conversation: have the API drop it rather than reject the request.
            thinking: dict = {"type": "adaptive", "block_binding": {"prefix_mismatch_behavior": "drop_block"}}
            betas = [FALLBACK_BETA, BINDING_BETA]
            if self.name in PROGRESS_MODELS:
                thinking["display"] = "updates"
                betas.append(UPDATES_BETA)
            manager = self.client.beta.messages.stream(**common, messages=messages, thinking=thinking,
                                                       fallbacks="default", betas=betas)
        beat = time.monotonic()
        with manager as stream:
            for event in stream:
                if event.type == "text":
                    yield {"type": "text", "text": event.text}
                elif event.type == "thinking" and event.snapshot.strip():
                    yield {"type": "progress", "text": event.snapshot.strip()[-400:]}
                elif time.monotonic() - beat < 5:
                    continue
                else:
                    yield {"type": "beat"}  # keeps the connection to the browser alive while the model is thinking
                beat = time.monotonic()
            message = stream.get_final_message()
        yield {"type": "final", "message": final_message(message)}


def _optional_feature_refused(exc) -> bool:
    text = str(getattr(exc, "message", exc)).lower()
    return any(word in text for word in ("beta", "fallback", "block_binding", "display", "extra inputs", "signature"))


def _retry_after(exc) -> int:
    try:
        return min(max(int(float(exc.response.headers.get("retry-after", "60"))), 5), 300)
    except (ValueError, AttributeError):
        return 60


def _explain(exc) -> str:
    """A status error in words the account owner can act on. The API's own message is kept: it names the cause."""
    import anthropic
    status = getattr(exc, "status_code", 0)
    detail = str(getattr(exc, "message", "") or exc)[:300]
    if isinstance(exc, anthropic.AuthenticationError):
        return "Claude rejected the API key saved on the server. Check ANTHROPIC_API_KEY in the hosting settings."
    if isinstance(exc, anthropic.PermissionDeniedError):
        return f"The Claude API key is not allowed to do this: {detail}"
    if isinstance(exc, anthropic.NotFoundError):
        return "This Claude API account cannot use the chosen model. Check ASSISTANT_MODEL in the hosting settings."
    if status in (402,) or "credit balance" in detail.lower():
        return "The Claude API account has no credit left. Add credit in the Anthropic Console, then try again."
    if status in (500, 502, 503, 504, 529):
        return "Claude is busy or unavailable at the moment. Try again shortly."
    return f"Claude could not process the request: {detail}"
