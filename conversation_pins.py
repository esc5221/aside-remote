"""Persistent pins shared by the bridge's browser installations."""
from contextlib import closing
import sqlite3

import config

DB = config.CACHE_DIR / "conversation-pins.sqlite"


def pinned_ids() -> set[str]:
    with closing(sqlite3.connect(DB)) as connection:
        connection.execute("CREATE TABLE IF NOT EXISTS pins (session_id TEXT PRIMARY KEY)")
        return {row[0] for row in connection.execute("SELECT session_id FROM pins")}


def set_pinned(session_id: str, is_pinned: bool) -> None:
    with closing(sqlite3.connect(DB)) as connection, connection:
        connection.execute("CREATE TABLE IF NOT EXISTS pins (session_id TEXT PRIMARY KEY)")
        if is_pinned:
            connection.execute("INSERT OR IGNORE INTO pins VALUES (?)", (session_id,))
        else:
            connection.execute("DELETE FROM pins WHERE session_id=?", (session_id,))
