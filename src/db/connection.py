"""SQLite connections and checked, transactional migrations."""
import hashlib
import os
import sqlite3
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path
from threading import Lock
from urllib.parse import unquote

ROOT = Path(__file__).resolve().parents[2]


def database_path():
    raw = os.getenv('YUNQI_DB_PATH')
    if not raw:
        url = os.getenv('DATABASE_URL')
        if url:
            if not url.startswith('sqlite:///') or '?' in url or '#' in url:
                raise ValueError('DATABASE_URL must be a plain sqlite:/// URL')
            raw = unquote(url[len('sqlite:///'):])
        else:
            raw = 'data/yunqi.db'
    if raw == ':memory:' or not raw:
        raise ValueError('a file database is required')
    path = Path(raw).expanduser()
    return path if path.is_absolute() else ROOT / path


def utc_now():
    return datetime.now(timezone.utc)


def iso_time(value):
    return value.astimezone(timezone.utc).isoformat(timespec='milliseconds')


class Database:
    def __init__(self, path=None, migrations=None):
        self.path = Path(path) if path is not None else database_path()
        self.migrations = Path(migrations) if migrations else ROOT / 'migrations'
        self._lock = Lock()
        self._ready = False

    def connect(self):
        connection = sqlite3.connect(self.path, timeout=5, isolation_level=None)
        connection.row_factory = sqlite3.Row
        connection.execute('PRAGMA foreign_keys=ON')
        connection.execute('PRAGMA busy_timeout=5000')
        connection.execute('PRAGMA synchronous=FULL')
        return connection

    def migrate(self):
        with self._lock:
            self.path.parent.mkdir(parents=True, exist_ok=True)
            connection = self.connect()
            try:
                connection.execute('PRAGMA journal_mode=WAL')
                connection.execute('BEGIN IMMEDIATE')
                exists = connection.execute("SELECT 1 FROM sqlite_master WHERE name='schema_version'").fetchone()
                applied = {r['version']: r for r in connection.execute('SELECT * FROM schema_version')} if exists else {}
                files = sorted(self.migrations.glob('[0-9][0-9][0-9][0-9]_*.sql'))
                versions = [int(p.name.split('_')[0]) for p in files]
                if not files or len(versions) != len(set(versions)) or set(applied) - set(versions):
                    raise RuntimeError('invalid migration versions')
                for path, version in zip(files, versions):
                    raw = path.read_bytes()
                    checksum = hashlib.sha256(raw).hexdigest()
                    if version in applied:
                        if applied[version]['checksum'] != checksum or applied[version]['name'] != path.name:
                            raise RuntimeError('applied migration changed')
                        continue
                    statement = ''
                    for line in raw.decode('utf-8').splitlines(keepends=True):
                        statement += line
                        if sqlite3.complete_statement(statement):
                            connection.execute(statement)
                            statement = ''
                    if statement.strip():
                        raise RuntimeError('incomplete migration SQL')
                    connection.execute('INSERT INTO schema_version VALUES (?,?,?,?)',
                                       (version, path.name, checksum, iso_time(utc_now())))
                connection.commit()
                self._ready = True
            except BaseException:
                connection.rollback()
                raise
            finally:
                connection.close()

    @contextmanager
    def transaction(self):
        if not self._ready:
            self.migrate()
        connection = self.connect()
        try:
            connection.execute('BEGIN IMMEDIATE')
            yield connection
            connection.commit()
        except BaseException:
            connection.rollback()
            raise
        finally:
            connection.close()
