#!/usr/bin/env node

import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

const REPO_ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..')
const PACKAGE_JSON_PATH = path.join(REPO_ROOT, 'package.json')
const RELEASE_META_PATH = path.join(REPO_ROOT, 'release', 'current-version.json')

const SPREADSHEET_TOKEN = 'ICA2s2tgGhonFjtLblRctv8AnGc'
const SHEET_ID = 'cVwJUD'
const READ_RANGE = `${SHEET_ID}!A1:C200`
const HEADER_ROW = ['版本号', '核心功能', '发布时间']
function runLark(args) {
  return execFileSync('lark-cli', args, {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  })
}

function parseJson(raw) {
  try {
    return JSON.parse(raw)
  } catch (error) {
    throw new Error(`Failed to parse lark-cli JSON response: ${error instanceof Error ? error.message : String(error)}`)
  }
}

function getVersion() {
  const pkg = JSON.parse(fs.readFileSync(PACKAGE_JSON_PATH, 'utf8'))
  const meta = JSON.parse(fs.readFileSync(RELEASE_META_PATH, 'utf8'))
  const version = meta.version || pkg.version
  if (!version || typeof version !== 'string') {
    throw new Error('release metadata is missing a string version field')
  }
  return `v${version.replace(/^v/, '')}`
}

function getCoreFeatures() {
  const meta = JSON.parse(fs.readFileSync(RELEASE_META_PATH, 'utf8'))
  if (!Array.isArray(meta.coreFeatures) || meta.coreFeatures.length === 0) {
    throw new Error('release/current-version.json must contain a non-empty coreFeatures array')
  }
  return meta.coreFeatures.map((item) => `• ${String(item).replace(/^\s*•\s*/, '')}`).join('\n')
}

function todayString() {
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  })
  return formatter.format(new Date())
}

function cellRangeForRow(rowNumber) {
  return `${SHEET_ID}!A${rowNumber}:C${rowNumber}`
}

function loadExistingRows() {
  const raw = runLark([
    'sheets',
    '+read',
    '--as',
    'user',
    '--spreadsheet-token',
    SPREADSHEET_TOKEN,
    '--range',
    READ_RANGE,
  ])
  const payload = parseJson(raw)
  const values = payload?.data?.valueRange?.values
  if (!Array.isArray(values)) return []
  return values
}

function findTargetRow(rows, version) {
  let firstEmptyRow = 2
  for (let i = 0; i < rows.length; i += 1) {
    const rowNumber = i + 1
    const row = Array.isArray(rows[i]) ? rows[i] : []
    const versionCell = row[0]
    if (rowNumber === 1) continue
    if (versionCell === version) return rowNumber
    const isEmpty = row.every((cell) => cell == null || cell === '')
    if (isEmpty) return rowNumber
    firstEmptyRow = rowNumber + 1
  }
  return firstEmptyRow
}

function ensureHeader(rows) {
  const firstRow = Array.isArray(rows[0]) ? rows[0] : []
  const missingHeader = HEADER_ROW.some((value, index) => firstRow[index] !== value)
  if (!missingHeader) return

  runLark([
    'sheets',
    '+write',
    '--as',
    'user',
    '--spreadsheet-token',
    SPREADSHEET_TOKEN,
    '--range',
    `${SHEET_ID}!A1:C1`,
    '--values',
    JSON.stringify([HEADER_ROW]),
  ])
}

function upsertVersionRow(rowNumber, version, coreFeatures, releaseDate) {
  const values = [[version, coreFeatures, releaseDate]]
  runLark([
    'sheets',
    '+write',
    '--as',
    'user',
    '--spreadsheet-token',
    SPREADSHEET_TOKEN,
    '--range',
    cellRangeForRow(rowNumber),
    '--values',
    JSON.stringify(values),
  ])
}

function main() {
  const version = getVersion()
  const coreFeatures = getCoreFeatures()
  const releaseDate = todayString()
  const rows = loadExistingRows()
  ensureHeader(rows)
  const targetRow = findTargetRow(rows, version)
  upsertVersionRow(targetRow, version, coreFeatures, releaseDate)
  process.stdout.write(`Updated Feishu version record: ${version} -> row ${targetRow}\n`)
}

try {
  main()
} catch (error) {
  const message = error instanceof Error ? error.message : String(error)
  process.stderr.write(`Failed to update Feishu version record: ${message}\n`)
  process.exit(1)
}
