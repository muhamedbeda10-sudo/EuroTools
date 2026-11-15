"""Runtime configuration. Secrets never live here: broker credentials are not used by this release."""
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
    cors_origins: str = "http://localhost:3000,http://127.0.0.1:3000"
    # Live brokerage execution is a separate, future module. It is not implemented
    # and this flag exists only so the UI can state the fact explicitly.
    live_trading_enabled: bool = False

    model_config = SettingsConfigDict(env_file=".env", extra="ignore")


def get_settings() -> Settings:
    return Settings()
