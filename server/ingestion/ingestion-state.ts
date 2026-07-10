import type { DatabaseSync } from 'node:sqlite'

export interface IngestionState {
  last_processed_lines: number
  parser_version?: number | null
}

export const UPSERT_INGESTION_STATE_SQL = `
  INSERT INTO ingestion_state (
    source_path,
    last_processed_lines,
    last_scan_at,
    event_count,
    parser_version
  ) VALUES (
    @sourcePath,
    @lines,
    @scanAt,
    @eventCount,
    @parserVersion
  )
  ON CONFLICT(source_path) DO UPDATE SET
    last_processed_lines = excluded.last_processed_lines,
    last_scan_at = excluded.last_scan_at,
    event_count = excluded.event_count,
    parser_version = excluded.parser_version
`

export function resolveStartLine(
  forceReindex: boolean,
  state: IngestionState | undefined,
  currentVersion: number,
): number {
  if (forceReindex || !state || state.parser_version !== currentVersion) return 0
  return state.last_processed_lines || 0
}

export function prepareIngestionStateStatements(database: DatabaseSync) {
  return {
    getState: database.prepare('SELECT * FROM ingestion_state WHERE source_path = ?'),
    upsertState: database.prepare(UPSERT_INGESTION_STATE_SQL),
  }
}
