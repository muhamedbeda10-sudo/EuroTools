"""Runtime configuration. Secrets never live here: they come from the server's environment."""
from decimal import Decimal
from pathlib import Path

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    app_env: str = "development"
    data_dir: Path = Path(__file__).resolve().parent.parent / "var"
    initial_capital_egp: Decimal = Decimal("50000")
    seed_sample_data: bool = True
    # "sqlite" for local runs and tests; "firestore" when deployed (per-user data,
    # authenticated with the caller's own Firebase sign-in token).
    store_backend: str = "sqlite"
    firebase_project_id: str = ""
    # Public web API key of the Firebase project (identifies it, grants nothing).
    firebase_web_api_key: str = ""
    # Younit market-data credentials. Server-side only: never sent to the browser,
    # never logged, never committed. Leave empty to run on sample / imported data.
    younit_trading_id: str = ""
    younit_api_key: str = ""
    # The in-app assistant (Claude). Server-side only, like the feed credentials. Without the key
    # the assistant is switched off and nothing is ever charged.
    anthropic_api_key: str = ""
    assistant_model: str = "claude-opus-5-5"
    assistant_effort: str = "medium"
    # Who may use the assistant when several people have accounts: "admins" (default) or "all".
    assistant_users: str = "admins"
    # Rough daily spending ceiling per account, in USD (0 = no ceiling).
    assistant_daily_usd: float = 5.0
    # The real brokerage account behind the Younit credentials can be looked at (never traded) by these
    # sign-ins only: Firebase user IDs, separated by commas. Empty = nobody. A server without sign-in
    # (local SQLite) may look only if the list contains the word "local". See app/broker.py.
    broker_account_uids: str = ""
    cors_origins: str = "http://localhost:3000,http://127.0.0.1:3000"
    # The server's switch for real orders (LIVE_TRADING_ENABLED). Off unless set: with it off no order
    # can reach the broker whatever anybody chose in the app. On, an order still needs the owner's own
    # switch and limits (Settings → Real trading) and their approval of that order. See app/real_orders.py.
    live_trading_enabled: bool = False

    model_config = SettingsConfigDict(env_file=".env", extra="ignore")


def get_settings() -> Settings:
    return Settings()
