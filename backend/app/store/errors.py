class AuthError(PermissionError):
    pass


class ConflictError(RuntimeError):
    pass


class StoreUnavailable(RuntimeError):
    """The database cannot be asked right now (no connection, or it is refusing requests). Nothing was changed."""
