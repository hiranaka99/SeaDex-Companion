import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const MODULE_DIR = dirname(fileURLToPath(import.meta.url))
export const BASE_DIR = MODULE_DIR.endsWith(join('dist', 'server')) ? resolve(MODULE_DIR, '../..') : resolve(MODULE_DIR, '..')
export const DATA_DIR = process.env.DATA_DIR || BASE_DIR
export const STATIC_DIR = process.env.STATIC_DIR || join(BASE_DIR, 'static')
export const CONFIG_FILE = join(DATA_DIR, 'config.json')
export const ENCRYPTED_SECRETS_FILE = join(DATA_DIR, 'secrets.enc.json')
export const SECRETS_KEY_FILE = process.env.SECRETS_KEY_FILE || join(DATA_DIR, '.seadex-key')
export const CACHE_FILE = join(DATA_DIR, 'anilist_cache.json')
export const RESULTS_FILE = join(DATA_DIR, 'last_results.json')
export const NOTIFIED_FILE = join(DATA_DIR, 'notified.json')
export const OWNED_TORRENTS_FILE = join(DATA_DIR, 'owned_torrents.json')
export const DOWNLOAD_RECORDS_FILE = join(DATA_DIR, 'download_records.json')
export const USER_RULES_FILE = join(DATA_DIR, 'user_rules.json')
export const HISTORY_FILE = join(DATA_DIR, 'scan_history.json')
export const LOG_DIR = join(DATA_DIR, 'logs')
export const LOG_FILE = join(LOG_DIR, 'app.log')
