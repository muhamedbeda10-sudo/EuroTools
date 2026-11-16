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


class StoreUnavailable(DatabaseError):
    """The database cannot be asked right now (no connection, or it is refusing requests). Nothing was changed."""

    def __init__(self, message: str, retry_after: int | None = 15):
        super().__init__(message, retry_after)
