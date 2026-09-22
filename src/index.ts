import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises'
import { extname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomUUID } from 'node:crypto'
import z from 'schemastery'
import { flashDshTaskbar } from './windows-flash.js'
import { prepareWindowsToast, showWindowsToast } from './windows-toast.js'

export const name = '@dsh-external/dsh-reminder'
export const inject = ['settings', 'connection', 'webServer']

export type Config = { enabled?: boolean }
export const Config = z.object({
  enabled: z.boolean(),
})

const MAX_TONE_BYTES = 10 * 1024 * 1024
const VALID_EXTENSIONS = new Set(['.mp3', '.wav'])
const TONE_FILE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}--[^\\/:*?"<>|\r\n]{1,96}\.(mp3|wav)$/i
const pluginDirectory = resolve(fileURLToPath(new URL('..', import.meta.url)))
const soundsDirectory = join(pluginDirectory, 'sounds')
const preferencesPath = join(pluginDirectory, 'preferences.json')

type Tone = { id: string; name: string }
type ReminderKind = 'approval' | 'question' | 'completed' | 'failed'
type ReminderMode = 'off' | 'background' | 'always'
type EventPreference = { sound: boolean; flash: boolean; popup?: boolean; soundId: string; volume: number }
type Preferences = { enabled: boolean; mode?: ReminderMode; events: Record<ReminderKind, EventPreference> }
type RpcResult = { ok: true; value: unknown } | { ok: false; error: { code: string; message: string; details: Record<string, unknown> } }

let toastWarn: ((message: string) => void) | undefined

function fail(message: string): RpcResult {
  return { ok: false, error: { code: 'dsh-reminder/error', message, details: {} } }
}

async function readPreferences(): Promise<Preferences | undefined> {
  try {
    return JSON.parse(await readFile(preferencesPath, 'utf8')) as Preferences
  } catch {
    return undefined
  }
}

async function writePreferences(preferences: Preferences): Promise<void> {
  await mkdir(pluginDirectory, { recursive: true })
  await writeFile(preferencesPath, JSON.stringify(preferences, null, 2), 'utf8')
}

function toneName(name: unknown): string {
  if (typeof name !== 'string') throw new Error('Tone name is required.')
  const clean = name.replace(/[\\/:*?"<>|\u0000-\u001f]/g, '').trim().slice(0, 96)
  if (!clean) throw new Error('Tone name is invalid.')
  return clean
}

function toneId(id: unknown): string {
  if (typeof id !== 'string' || !TONE_FILE.test(id)) throw new Error('Tone id is invalid.')
  return id
}

async function listTones(): Promise<Tone[]> {
  await mkdir(soundsDirectory, { recursive: true })
  const files = await readdir(soundsDirectory)
  return files
    .filter((id) => TONE_FILE.test(id))
    .sort()
    .map((id) => ({ id, name: id.slice(38, -extname(id).length) }))
}

async function dispatch(method: string, payload: unknown): Promise<RpcResult> {
  try {
    if (method === 'tones') return { ok: true, value: await listTones() }
    if (method === 'preferences') return { ok: true, value: await readPreferences() }
    if (method === 'savePreferences') {
      const preferences = payload as Preferences
      if (!preferences || typeof preferences !== 'object' || !preferences.events) return fail('Invalid reminder preferences.')
      if (preferences.mode !== undefined && preferences.mode !== 'off' && preferences.mode !== 'background' && preferences.mode !== 'always') return fail('Invalid reminder mode.')
      if (typeof preferences.enabled !== 'boolean' && preferences.mode === undefined) return fail('Invalid reminder preferences.')
      preferences.enabled = (preferences.mode ?? (preferences.enabled ? 'background' : 'off')) !== 'off'
      if (!preferences.mode) preferences.mode = preferences.enabled ? 'background' : 'off'
      await writePreferences(preferences)
      return { ok: true, value: preferences }
    }
    if (method === 'readTone') {
      const id = toneId((payload as { id?: unknown })?.id)
      const data = await readFile(join(soundsDirectory, id))
      return { ok: true, value: { data: data.toString('base64') } }
    }
    if (method === 'importTone') {
      const input = payload as { name?: unknown; data?: unknown; mime?: unknown }
      const rawName = typeof input?.name === 'string' ? input.name : ''
      const mime = typeof input?.mime === 'string' ? input.mime.toLowerCase() : ''
      let name = toneName(rawName || (mime.includes('mpeg') || mime.includes('mp3') ? 'tone.mp3' : mime.includes('wav') ? 'tone.wav' : ''))
      let extension = extname(name).toLowerCase()
      if (!VALID_EXTENSIONS.has(extension)) {
        if (mime.includes('mpeg') || mime === 'audio/mp3') {
          name = `${name}.mp3`
          extension = '.mp3'
        } else if (mime.includes('wav') || mime === 'audio/wave') {
          name = `${name}.wav`
          extension = '.wav'
        }
      }
      if (!VALID_EXTENSIONS.has(extension)) return fail('Only MP3 and WAV files are supported.')
      if (typeof input?.data !== 'string') return fail('Tone data is required.')
      const data = Buffer.from(input.data, 'base64')
      if (!data.length || data.length > MAX_TONE_BYTES) return fail('Tone must be between 1 byte and 10 MB.')
      await mkdir(soundsDirectory, { recursive: true })
      const displayName = name.slice(0, -extension.length).trim() || 'tone'
      const id = `${randomUUID()}--${displayName}${extension}`
      if (!TONE_FILE.test(id)) return fail('Tone name is invalid.')
      await writeFile(join(soundsDirectory, id), data, { flag: 'wx' })
      return { ok: true, value: { id, name: displayName } }
    }
    if (method === 'notify') {
      const input = payload as { title?: unknown; body?: unknown }
      const title = typeof input?.title === 'string' ? input.title : ''
      const body = typeof input?.body === 'string' ? input.body : ''
      if (!title.trim() && !body.trim()) return fail('Notification text is required.')
      const toast = await showWindowsToast(title, body, toastWarn)
      if (!toast.ok) return fail(toast.error)
      return { ok: true, value: toast }
    }
    if (method === 'flash') {
      const force = (payload as { force?: unknown })?.force === true
      const flash = await flashDshTaskbar(force, toastWarn)
      if (!flash.ok) return fail(flash.error)
      return { ok: true, value: flash }
    }
    return fail(`Unknown dsh-reminder method: ${method}`)
  } catch (error) {
    return fail(error instanceof Error ? error.message : String(error))
  }
}

async function serveReminderRpc(req: any, res: any, connection: any): Promise<void> {
  const rejection = typeof connection?.requestRejection === 'function' ? connection.requestRejection(req) : undefined
  if (rejection !== undefined) {
    res.writeHead(rejection)
    res.end(rejection === 401 ? 'unauthorized' : 'forbidden')
    return
  }
  const pathname = new URL(req.url ?? '/', 'http://dsh.internal').pathname
  const endpoint = pathname.startsWith('/dsh-reminder/') ? pathname.slice('/dsh-reminder/'.length) : ''
  if (req.method !== 'POST' || !endpoint || endpoint.includes('/')) {
    res.writeHead(404)
    res.end('not found')
    return
  }
  const chunks: Buffer[] = []
  let received = 0
  for await (const chunk of req) {
    received += chunk.byteLength
    if (received > MAX_TONE_BYTES + 1024 * 1024) {
      res.writeHead(413)
      res.end()
      req.destroy?.()
      return
    }
    chunks.push(chunk)
  }
  let body: { rpcId?: unknown; method?: unknown; payload?: unknown }
  try {
    body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    res.writeHead(400)
    res.end('body is not JSON')
    return
  }
  const method = typeof body.method === 'string' ? body.method : endpoint
  const result = await dispatch(method, body.payload)
  res.writeHead(200, { 'content-type': 'application/json' })
  res.end(JSON.stringify({ type: 'server-response', rpcId: body.rpcId, result }))
}

/** Register settings and a web RPC for persistent custom tones. */
export function apply(ctx: any, config: Config): void {
  toastWarn = (message) => ctx.logger?.warn?.(message)
  prepareWindowsToast()
  try {
    ctx.settings.register('dsh-reminder', Config, { base: { enabled: config?.enabled ?? true } })
  } catch (error) {
    ctx.logger?.warn?.(`[dsh-reminder] settings.register skipped: ${error instanceof Error ? error.message : String(error)}`)
  }
  // Register the prefix on this plugin fiber. connection.rpc.handle previously
  // ran in a nested inject child and never kept the route, so POST importTone
  // fell through to the SPA fallback (HTTP 405).
  ctx.effect(() => ctx.webServer.register({
    kind: 'prefix',
    path: '/dsh-reminder',
    handler: (req: unknown, res: unknown) => serveReminderRpc(req, res, ctx.connection),
  }), 'dsh-reminder rpc')
}
