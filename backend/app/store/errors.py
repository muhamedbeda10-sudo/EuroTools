import logging

log = logging.getLogger("egx.store")


class AuthError(PermissionError):
    pass


class ConflictError(RuntimeError):
    pass


class DatabaseError(RuntimeError):
    """The database did not do what it was asked, and it is not the caller's doing.

    Said to the person in its own words (the API answers 503), so the message is written for them.
    `retry_after` is how many seconds to leave before asking again, when that is known.
    """

    def __init__(self, message: str, retry_after: int | None = None):
        super().__init__(message)
        self.retry_after = retry_after


class QuotaError(DatabaseError):
    """The database refused because the project has used up what it may use (Firestore answers 429).

    The allowance is the project's, shared by everything that uses it, and it is counted per day:
    asking again a moment later is refused again. Nothing was read or written.
    """


QUOTA_MESSAGE = ("The database has reached its usage limit for today, so nothing can be read or saved until it resets "
                 "(midnight Pacific time, about 10:00 in Cairo). Your data is safe. The limit is Firebase's free daily "
                 "allowance for the project; moving the project to the pay-as-you-go plan lifts it.")
BUSY_MESSAGE = "The database is refusing requests for the moment (too many at once). Try again in a minute."


def database_error(action: str, status: int, body: str = "") -> DatabaseError:
    """The error for a database call that failed, from its HTTP status and what the database said.

    `action` is "read" or "write". Only the status and the database's own error words are looked at.
    """
    if status == 429 or status >= 500:
        # The database's own words (an error message, never anyone's data): what tells a used-up day from a busy minute.
        log.warning("database %s refused: HTTP %s %s", action, status, " ".join(body.split())[:300])
    if status == 429:
        text = body.lower()
        daily = not text.strip() or ("quota" in text and "per minute" not in text)
        return QuotaError(QUOTA_MESSAGE if daily else BUSY_MESSAGE, retry_after=None if daily else 60)
    if status in (500, 502, 503, 504):
        return DatabaseError(f"The database is not answering right now (HTTP {status}). Try again in a minute.", retry_after=30)
    return DatabaseError(f"database {action} failed ({status})")


class StoreUnavailable(DatabaseError):
    """The database cannot be asked right now (no connection, or it is refusing requests). Nothing was changed."""

    def __init__(self, message: str, retry_after: int | None = 15):
        super().__init__(message, retry_after)
