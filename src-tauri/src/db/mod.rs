pub mod migrations;
pub mod queries;

use rusqlite::{Connection, Result};
use std::sync::{Arc, Mutex};

/// Thread-safe handle to the SQLite connection.
/// Registered as Tauri managed state so commands can access it.
pub type DbState = Arc<Mutex<Connection>>;

/// Open (or create) the `pomotroid.db` file inside `app_data_dir`,
/// enable WAL mode for better concurrent read performance,
/// and run any pending schema migrations.
///
/// If the database is corrupt/unreadable, it is quarantined as
/// `pomotroid.db.corrupt-<timestamp>` (along with its WAL/SHM sidecars) and
/// opened fresh, so a broken file never prevents the app from launching.
pub fn open(app_data_dir: &std::path::Path) -> Result<DbState> {
    let db_path = app_data_dir.join("pomotroid.db");
    match try_open(&db_path) {
        Ok(state) => Ok(state),
        Err(first_err) if is_corruption(&first_err) => {
            log::warn!("[db] open failed ({first_err}); quarantining database and retrying");
            let ts = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_secs())
                .unwrap_or(0);
            for suffix in ["", "-wal", "-shm"] {
                let src = app_data_dir.join(format!("pomotroid.db{suffix}"));
                if src.exists() {
                    let dst = app_data_dir.join(format!("pomotroid.db.corrupt-{ts}{suffix}"));
                    if let Err(e) = std::fs::rename(&src, &dst) {
                        log::error!("[db] failed to quarantine {}: {e}", src.display());
                    }
                }
            }
            try_open(&db_path).map_err(|second_err| {
                log::error!("[db] retry after quarantine failed: {second_err}");
                second_err
            })
        }
        Err(other_err) => {
            // Transient failures (file locked by AV/backup, I/O error) must NOT
            // quarantine a healthy database — surface the error instead.
            log::error!("[db] open failed for a non-corruption reason: {other_err}");
            Err(other_err)
        }
    }
}

/// True when the error indicates the database file itself is corrupt
/// (as opposed to a transient I/O or locking failure).
fn is_corruption(err: &rusqlite::Error) -> bool {
    matches!(
        err.sqlite_error_code(),
        Some(rusqlite::ErrorCode::DatabaseCorrupt) | Some(rusqlite::ErrorCode::NotADatabase)
    )
}

fn try_open(db_path: &std::path::Path) -> Result<DbState> {
    let conn = Connection::open(db_path)?;

    // WAL mode: readers don't block writers and vice-versa.
    conn.execute_batch("PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;")?;

    migrations::run(&conn)?;

    Ok(Arc::new(Mutex::new(conn)))
}
