import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises'
import { extname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomUUID } from 'node:crypto'
import z from 'schemastery'

export const name = '@dsh-external/dsh-reminder'
export const inject = ['settings', 'connection']

export type Config = { enabled?: boolean }
export const Config = z.object({
  enabled: z.boolean(),
})

const MAX_TONE_BYTES = 10 * 1024 * 1024
const VALID_EXTENSIONS = new Set(['.mp3', '.wav'])
const pluginDirectory = resolve(fileURLToPath(new URL('..', import.meta.url)))
const soundsDirectory = join(pluginDirectory, 'sounds')
const preferencesPath = join(pluginDirectory, 'preferences.json')

type Tone = { id: string; name: string }
type Preferences = { enabled: boolean; events: Record<'approval' | 'question' | 'completed' | 'failed', { sound: boolean; flash: boolean; soundId: string; volume: number }> }

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
  if (typeof id !== 'string' || !/^[a-f0-9-]{36}--[A-Za-z0-9._ -]{1,96}\.(mp3|wav)$/.test(id)) throw new Error('Tone id is invalid.')
  return id
}

async function listTones(): Promise<Tone[]> {
  await mkdir(soundsDirectory, { recursive: true })
  const files = await readdir(soundsDirectory)
  return files
    .filter((id) => /^[a-f0-9-]{36}--[A-Za-z0-9._ -]{1,96}\.(mp3|wav)$/.test(id))
    .sort()
    .map((id) => ({ id, name: id.slice(38, -extname(id).length) }))
}

/** Register settings and a loopback-only RPC for persistent custom tones. */
export function apply(ctx: any, config: Config): void {
  ctx.inject(['settings'], (settingsCtx: any) => {
    settingsCtx.settings.register('dsh-reminder', Config, { base: config })
  })
  ctx.inject(['connection'], (connectionCtx: any) => {
    connectionCtx.connection.rpc.handle('/dsh-reminder', async (method: string, payload: unknown) => {
      if (method === 'tones') return { ok: true, value: await listTones() }
      if (method === 'preferences') return { ok: true, value: await readPreferences() }
      if (method === 'savePreferences') {
        const preferences = payload as Preferences
        if (!preferences || typeof preferences !== 'object' || typeof preferences.enabled !== 'boolean' || !preferences.events) throw new Error('Invalid reminder preferences.')
        await writePreferences(preferences)
        return { ok: true, value: preferences }
      }
      if (method === 'readTone') {
        const id = toneId((payload as { id?: unknown })?.id)
        const data = await readFile(join(soundsDirectory, id))
        return { ok: true, value: { data: data.toString('base64') } }
      }
      if (method === 'importTone') {
        const input = payload as { name?: unknown; data?: unknown }
        const name = toneName(input?.name)
        const extension = extname(name).toLowerCase()
        if (!VALID_EXTENSIONS.has(extension)) throw new Error('Only MP3 and WAV files are supported.')
        if (typeof input?.data !== 'string') throw new Error('Tone data is required.')
        const data = Buffer.from(input.data, 'base64')
        if (!data.length || data.length > MAX_TONE_BYTES) throw new Error('Tone must be between 1 byte and 10 MB.')
        await mkdir(soundsDirectory, { recursive: true })
        const displayName = name.slice(0, -extension.length)
        const id = `${randomUUID()}--${displayName}${extension}`
        await writeFile(join(soundsDirectory, id), data, { flag: 'wx' })
        return { ok: true, value: { id, name: displayName } }
      }
      throw new Error(`Unknown dsh-reminder method: ${method}`)
    }, { authority: 'loopback' })
  })
}
