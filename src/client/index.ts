import * as React from 'react'

type SlotsService = {
  inject(slot: string, factory: () => void | (() => void)): void | (() => void)
  register(options: Record<string, unknown>, component?: unknown): void | (() => void)
}

type LocaleService = {
  register(namespace: string, messages: { zh: Record<string, string>; en: Record<string, string> }): void | (() => void)
  bind(namespace: string): (key: string) => string
}

const SETTINGS_KEY = 'dsh-reminder.preferences.v1'
type ReminderKind = 'approval' | 'question' | 'completed' | 'failed'
type BuiltInSoundId = 'chime' | 'double' | 'alert' | 'none'
type SoundId = BuiltInSoundId | `imported:${string}`

type EventPreference = {
  sound: boolean
  flash: boolean
  soundId: SoundId
  volume: number
}

type Preferences = {
  enabled: boolean
  events: Record<ReminderKind, EventPreference>
}

type DesktopAttention = {
  attention?: (request?: { flash?: boolean }) => Promise<{
    focused: boolean
    minimized: boolean
    visible: boolean
  }>
}

type Sessions = {
  list: {
    getSnapshot(): {
      ids: string[]
      byId: Record<string, {
        id: string
        title?: string
        displayTitle?: string
        running: boolean
        origin?: string
        pendingInteraction?: 'approval' | 'question' | string
        projectionValues?: Record<string, unknown>
      }>
    }
    subscribe(listener: () => void): () => void
  }
}

type Connection = {
  rpc: {
    call(channel: string, endpoint: string, payload: unknown): Promise<{ ok: boolean; value?: unknown; error?: { message?: string } }>
  }
}

type ClientContext = {
  slots: SlotsService
  locale: LocaleService
  sessions: Sessions
  connection: Connection
  effect(fn: () => void | (() => void), label?: string): void
}

type ImportedTone = { id: string; name: string }
const importedToneUrls = new Map<string, string>()
let runtimePreferences: Preferences | undefined
let preferencesReady: Promise<void> | undefined

async function reminderRpc<T>(ctx: ClientContext, endpoint: string, payload: unknown): Promise<T> {
  const result = await ctx.connection.rpc.call('/dsh-reminder', endpoint, payload)
  if (!result.ok) throw new Error(result.error?.message ?? 'Reminder request failed.')
  return result.value as T
}

function base64FromBytes(bytes: Uint8Array): string {
  let value = ''
  for (let start = 0; start < bytes.length; start += 0x8000) value += String.fromCharCode(...bytes.subarray(start, start + 0x8000))
  return btoa(value)
}

async function importedToneUrl(ctx: ClientContext, id: string): Promise<string> {
  const cached = importedToneUrls.get(id)
  if (cached) return cached
  const response = await reminderRpc<{ data: string }>(ctx, 'readTone', { id })
  const bytes = Uint8Array.from(atob(response.data), (character) => character.charCodeAt(0))
  const url = URL.createObjectURL(new Blob([bytes], { type: id.endsWith('.wav') ? 'audio/wav' : 'audio/mpeg' }))
  importedToneUrls.set(id, url)
  return url
}

const defaults: Preferences = {
  enabled: true,
  events: {
    approval: { sound: true, flash: true, soundId: 'alert', volume: 0.5 },
    question: { sound: true, flash: true, soundId: 'double', volume: 0.5 },
    completed: { sound: true, flash: true, soundId: 'chime', volume: 0.5 },
    failed: { sound: true, flash: true, soundId: 'alert', volume: 0.5 },
  },
}

function cloneDefaults(): Preferences {
  return JSON.parse(JSON.stringify(defaults)) as Preferences
}

function mergePreferences(saved: Partial<Preferences> | undefined): Preferences {
  return {
    enabled: saved?.enabled ?? defaults.enabled,
    events: Object.fromEntries((Object.keys(defaults.events) as ReminderKind[]).map((kind) => [kind, {
      ...defaults.events[kind],
      ...saved?.events?.[kind],
      volume: typeof saved?.events?.[kind]?.volume === 'number' ? Math.max(0, Math.min(1, saved.events[kind]!.volume)) : defaults.events[kind].volume,
    }])) as Preferences['events'],
  }
}

function loadLocalPreferences(): Preferences | undefined {
  try {
    const saved = localStorage.getItem(SETTINGS_KEY)
    return saved ? mergePreferences(JSON.parse(saved) as Partial<Preferences>) : undefined
  } catch {
    return undefined
  }
}

async function ensurePreferences(ctx: ClientContext): Promise<Preferences> {
  if (runtimePreferences) return runtimePreferences
  preferencesReady ??= reminderRpc<Partial<Preferences> | undefined>(ctx, 'preferences', {}).then((saved) => {
    const local = loadLocalPreferences()
    runtimePreferences = mergePreferences(saved ?? local)
    const needsMigration = !saved || (Object.keys(defaults.events) as ReminderKind[]).some((kind) => typeof saved.events?.[kind]?.volume !== 'number')
    if (needsMigration) return reminderRpc(ctx, 'savePreferences', runtimePreferences).then(() => undefined)
    return undefined
  }).catch(() => {
    runtimePreferences = loadLocalPreferences() ?? cloneDefaults()
  })
  await preferencesReady
  return runtimePreferences ?? cloneDefaults()
}

function isForeground(): boolean {
  return document.hasFocus() && !document.hidden
}

async function playTone(ctx: ClientContext, id: SoundId, volume = 0.5): Promise<void> {
  // 50% preserves the previous reminder loudness; 100% doubles that baseline.
  const normalizedVolume = Math.max(0, Math.min(1, volume))
  const playbackGain = normalizedVolume * 2
  if (id === 'none') return
  if (id.startsWith('imported:')) {
    try {
      const audio = new Audio(await importedToneUrl(ctx, id.slice('imported:'.length)))
      audio.volume = Math.min(1, 0.65 * playbackGain)
      await audio.play()
    } catch {
      // The selected imported tone may have been removed outside the plugin.
    }
    return
  }
  try {
    const AudioContextCtor = window.AudioContext || (window as any).webkitAudioContext
    const audio = new AudioContextCtor()
    const notes = id === 'alert' ? [392, 330, 392] : id === 'double' ? [659, 784] : [523, 659]
    notes.forEach((frequency: number, index: number) => {
      const oscillator = audio.createOscillator()
      const gain = audio.createGain()
      const start = audio.currentTime + index * 0.13
      oscillator.type = id === 'alert' ? 'square' : 'sine'
      oscillator.frequency.value = frequency
      gain.gain.setValueAtTime(0.0001, start)
      gain.gain.exponentialRampToValueAtTime(0.12 * playbackGain, start + 0.015)
      gain.gain.exponentialRampToValueAtTime(0.0001, start + 0.11)
      oscillator.connect(gain).connect(audio.destination)
      oscillator.start(start)
      oscillator.stop(start + 0.12)
    })
    window.setTimeout(() => void audio.close(), 800)
  } catch {
    // Browsers may reject audio before the first user gesture.
  }
}

function desktopAttention(): DesktopAttention | undefined {
  return (window as Window & { dshDesktop?: DesktopAttention }).dshDesktop
}

type SessionSummary = ReturnType<Sessions['list']['getSnapshot']>['byId'][string]

function eventFor(item: SessionSummary, previous: { running: boolean; pending?: string; goalPhase?: string }): ReminderKind | undefined {
  const pending = item.pendingInteraction
  if (pending === 'approval' && previous.pending !== 'approval') return 'approval'
  if (pending === 'question' && previous.pending !== 'question') return 'question'
  const goal = item.projectionValues?.goal as { phase?: string } | undefined
  const phase = goal?.phase
  if (phase === 'blocked' && previous.goalPhase !== 'blocked') return 'failed'
  if (phase === 'complete' && previous.goalPhase !== 'complete') return 'completed'
  if (previous.running && !item.running) return 'completed'
  return undefined
}

function installReminder(ctx: ClientContext): () => void {
  const observed = new Map<string, { running: boolean; pending?: string; goalPhase?: string }>()
  const notify = (kind: ReminderKind) => {
    const preferences = runtimePreferences ?? cloneDefaults()
    const event = preferences.events[kind]
    if (!preferences.enabled || !event || isForeground()) return
    if (event.sound) void playTone(ctx, event.soundId, event.volume)
    if (event.flash) void desktopAttention()?.attention?.({ flash: true }).catch(() => {})
  }
  const reconcile = async () => {
    const preferences = await ensurePreferences(ctx)
    const snapshot = ctx.sessions.list.getSnapshot()
    for (const sessionId of snapshot.ids) {
      const item = snapshot.byId[sessionId]
      if (!item || item.origin === 'subagent') continue
      const prior = observed.get(sessionId)
      const goal = item.projectionValues?.goal as { phase?: string } | undefined
      const current = { running: item.running, pending: item.pendingInteraction, goalPhase: goal?.phase }
      if (prior) {
        const kind = eventFor(item, prior)
        if (kind) notify(kind)
      }
      observed.set(sessionId, current)
    }
  }
  void reconcile()
  return ctx.sessions.list.subscribe(() => { void reconcile() })
}

const LOCALE_NS = 'dsh-reminder'
const messages = {
  zh: {
    title: 'DSH 提醒', description: '在 DSH Desktop 不在前台或最小化时提醒一次。', statusReady: '当前 DSH Desktop 支持任务栏闪烁。', statusSoundOnly: '当前安装缺少任务栏桥接，将使用声音提醒。', enabled: '启用提醒', sound: '提示音', flash: '任务栏闪烁', volume: '音量', test: '试听', importTone: '导入 MP3/WAV', importing: '正在导入...', importFailed: '导入失败', importedTones: '已导入提示音', chime: '提示音', double: '双音提示', alert: '警示音', silent: '静音', approval: '等待权限或高风险操作确认', question: '等待回答澄清问题', completed: '主任务完成', failed: '主任务失败或阻塞', expand: '展开', collapse: '收起'
  },
  en: {
    title: 'DSH Reminder', description: 'Alert once when DSH Desktop is unfocused or minimized.', statusReady: 'Taskbar flashing is available in this DSH Desktop installation.', statusSoundOnly: 'The taskbar bridge is unavailable; sound reminders are active.', enabled: 'Enable reminders', sound: 'Sound', flash: 'Flash taskbar', volume: 'Volume', test: 'Test sound', importTone: 'Import MP3/WAV', importing: 'Importing...', importFailed: 'Import failed', importedTones: 'Imported tones', chime: 'Chime', double: 'Double chime', alert: 'Alert', silent: 'Silent', approval: 'Waiting for permission or high-risk confirmation', question: 'Waiting for your answer', completed: 'Main task completed', failed: 'Main task failed or blocked', expand: 'Expand', collapse: 'Collapse'
  }
} as const

type LocaleKey = keyof typeof messages.zh

function ReminderSettingsDom(ctx: ClientContext, t: (key: LocaleKey) => string): HTMLElement {
  let preferences = runtimePreferences ?? cloneDefaults()
  let importedTones: ImportedTone[] = []
  let importError = ''
  const root = document.createElement('section')
  root.className = 'dsh-reminder-settings'
  root.innerHTML = `
    <style>
      .dsh-reminder-settings { color: var(--dsw-alias-label-primary); }
      .dsh-reminder-settings .card { border: 1px solid var(--dsw-alias-border-l2); background: var(--dsw-alias-bg-layer-3); border-radius: 12px; overflow: hidden; }
      .dsh-reminder-settings .header { width: 100%; display: flex; align-items: center; gap: 12px; padding: 14px 16px; border: 0; background: transparent; color: inherit; text-align: left; cursor: pointer; font: inherit; }
      .dsh-reminder-settings .head-text { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 4px; }
      .dsh-reminder-settings .title { font-size: 15px; font-weight: 600; line-height: 1.4; }
      .dsh-reminder-settings .description { color: var(--dsw-alias-label-tertiary); font-size: 13px; line-height: 1.5; }
      .dsh-reminder-settings .chevron { color: var(--dsw-alias-label-tertiary); transition: transform .16s; }
      .dsh-reminder-settings .chevron.open { transform: rotate(180deg); }
      .dsh-reminder-settings .body { border-top: 1px solid var(--dsw-alias-border-l2); margin: 0 16px; padding: 12px 0 8px; }
      .dsh-reminder-settings .status { margin: 0 0 12px; color: var(--dsw-alias-label-tertiary); font-size: 12px; line-height: 1.5; }
      .dsh-reminder-settings .master { display: block; margin-bottom: 12px; font-size: 13px; }
      .dsh-reminder-settings .event { display: grid; grid-template-columns: minmax(0, 1fr) auto auto; gap: 10px; align-items: center; border-top: 1px solid var(--dsw-alias-border-l2); padding: 12px 0; }
      .dsh-reminder-settings .event-name { min-width: 0; font-size: 13px; }
      .dsh-reminder-settings .event-controls { grid-column: 1 / -1; display: grid; grid-template-columns: minmax(0, 1fr) minmax(120px, 0.7fr) auto; gap: 10px; align-items: center; }
      .dsh-reminder-settings .event-controls select { min-width: 0; width: 100%; }
      .dsh-reminder-settings .volume-control { display: flex; align-items: center; gap: 6px; min-width: 0; }
      .dsh-reminder-settings .volume-control input { min-width: 0; width: 100%; }
      .dsh-reminder-settings .volume-value { min-width: 34px; text-align: right; font-variant-numeric: tabular-nums; }
      .dsh-reminder-settings label { font-size: 13px; }
      .dsh-reminder-settings select, .dsh-reminder-settings button { font: inherit; }
      .dsh-reminder-settings button { padding: 5px 9px; border: 1px solid var(--dsw-alias-border-l2); border-radius: 6px; color: inherit; background: transparent; cursor: pointer; }
      .dsh-reminder-settings input[type=file] { display: none; }
      @media (max-width: 650px) { .dsh-reminder-settings .event { grid-template-columns: 1fr auto auto; } }
    </style>
    <div class="card">
      <button class="header" type="button" aria-expanded="false">
        <span class="head-text"><span class="title"></span><span class="description"></span></span>
        <span class="chevron">⌄</span>
      </button>
      <div class="body" hidden>
        <div class="status"></div>
        <label class="master"><input type="checkbox"> </label>
        <div class="imports"></div>
        <div class="events"></div>
      </div>
    </div>
  `
  const kinds: Record<ReminderKind, LocaleKey> = { approval: 'approval', question: 'question', completed: 'completed', failed: 'failed' }
  const header = root.querySelector('.header') as HTMLButtonElement
  const body = root.querySelector('.body') as HTMLDivElement
  const chevron = root.querySelector('.chevron') as HTMLElement
  header.onclick = () => {
    const open = body.hidden
    body.hidden = !open
    header.setAttribute('aria-expanded', String(open))
    header.setAttribute('aria-label', `${t(open ? 'collapse' : 'expand')}: ${t('title')}`)
    chevron.classList.toggle('open', open)
  }
  ;(root.querySelector('.title') as HTMLElement).textContent = t('title')
  ;(root.querySelector('.description') as HTMLElement).textContent = t('description')
  header.setAttribute('aria-label', `${t('expand')}: ${t('title')}`)
  const persist = () => {
    runtimePreferences = preferences
    void reminderRpc(ctx, 'savePreferences', preferences).catch(() => {})
    render()
  }
  const importFile = document.createElement('input')
  importFile.type = 'file'
  importFile.accept = '.mp3,.wav,audio/mpeg,audio/wav'
  importFile.hidden = true
  const refreshTones = async () => {
    try {
      importedTones = await reminderRpc<ImportedTone[]>(ctx, 'tones', {})
      importError = ''
      render()
    } catch {
      importError = t('importFailed')
      render()
    }
  }
  const render = () => {
    const attentionAvailable = typeof desktopAttention()?.attention === 'function'
    ;(root.querySelector('.status') as HTMLElement).textContent = attentionAvailable ? t('statusReady') : t('statusSoundOnly')
    const master = root.querySelector('.master') as HTMLLabelElement
    master.lastChild!.textContent = t('enabled')
    const masterInput = master.querySelector('input') as HTMLInputElement
    masterInput.checked = preferences.enabled
    masterInput.onchange = () => { preferences.enabled = masterInput.checked; persist() }
    const events = root.querySelector('.events') as HTMLElement
    events.replaceChildren()
    for (const kind of Object.keys(kinds) as ReminderKind[]) {
      const pref = preferences.events[kind]
      const row = document.createElement('div')
      row.className = 'event'
      const sound = document.createElement('label')
      sound.innerHTML = `<input type="checkbox" ${pref.sound ? 'checked' : ''}> ${t('sound')}`
      const flash = document.createElement('label')
      flash.innerHTML = `<input type="checkbox" ${pref.flash ? 'checked' : ''} ${attentionAvailable ? '' : 'disabled'}> ${t('flash')}`
      const select = document.createElement('select')
      for (const [value, key] of [['chime', 'chime'], ['double', 'double'], ['alert', 'alert'], ['none', 'silent']] as Array<[BuiltInSoundId, LocaleKey]>) select.add(new Option(t(key), value, false, pref.soundId === value))
      if (importedTones.length) {
        const group = document.createElement('optgroup')
        group.label = t('importedTones')
        for (const tone of importedTones) group.append(new Option(tone.name, `imported:${tone.id}`, false, pref.soundId === `imported:${tone.id}`))
        select.append(group)
      }
      const volume = document.createElement('label')
      volume.className = 'volume-control'
      volume.title = t('volume')
      const volumeText = document.createElement('span')
      volumeText.textContent = t('volume')
      const volumeInput = document.createElement('input')
      volumeInput.type = 'range'
      volumeInput.min = '0'
      volumeInput.max = '1'
      volumeInput.step = '0.01'
      volumeInput.value = String(pref.volume)
      volumeInput.setAttribute('aria-label', t('volume'))
      const volumeValue = document.createElement('span')
      volumeValue.className = 'volume-value'
      volumeValue.textContent = `${Math.round(pref.volume * 100)}%`
      volumeInput.oninput = () => {
        pref.volume = Number(volumeInput.value)
        volumeValue.textContent = `${Math.round(pref.volume * 100)}%`
      }
      volumeInput.onchange = () => persist()
      volume.append(volumeText, volumeInput, volumeValue)
      const test = document.createElement('button')
      test.type = 'button'
      test.textContent = t('test')
      test.onclick = () => { void playTone(ctx, pref.soundId, pref.volume) }
      ;(sound.querySelector('input') as HTMLInputElement).onchange = (event) => { pref.sound = (event.target as HTMLInputElement).checked; persist() }
      ;(flash.querySelector('input') as HTMLInputElement).onchange = (event) => { pref.flash = (event.target as HTMLInputElement).checked; persist() }
      select.onchange = () => { pref.soundId = select.value as SoundId; persist() }
      const name = document.createElement('span')
      name.className = 'event-name'
      name.textContent = t(kinds[kind])
      const controls = document.createElement('div')
      controls.className = 'event-controls'
      controls.append(select, volume, test)
      row.append(name, sound, flash, controls)
      events.append(row)
    }
    const importRow = root.querySelector('.imports') as HTMLElement
    importRow.replaceChildren()
    const importButton = document.createElement('button')
    importButton.type = 'button'
    importButton.textContent = t('importTone')
    importButton.onclick = () => importFile.click()
    importRow.append(importButton)
    if (importError) {
      const error = document.createElement('span')
      error.className = 'import-error'
      error.textContent = importError
      importRow.append(error)
    }
  }
  importFile.onchange = async () => {
    const file = importFile.files?.[0]
    importFile.value = ''
    if (!file) return
    try {
      importError = ''
      const data = base64FromBytes(new Uint8Array(await file.arrayBuffer()))
      await reminderRpc(ctx, 'importTone', { name: file.name, data })
      await refreshTones()
    } catch {
      importError = t('importFailed')
      render()
    }
  }
  render()
  void ensurePreferences(ctx).then((loaded) => {
    preferences = loaded
    render()
  })
  void refreshTones()
  return root
}

function ReminderSettings(props: { ctx: ClientContext; t: (key: LocaleKey) => string }): React.ReactElement {
  const container = React.useRef<HTMLDivElement>(null)
  React.useEffect(() => {
    const root = ReminderSettingsDom(props.ctx, props.t)
    container.current?.replaceChildren(root)
    return () => root.remove()
  }, [])
  return React.createElement('div', { ref: container })
}

export const inject = ['slots', 'locale', 'sessions', 'connection']

export function apply(ctx: ClientContext): void {
  const t = ctx.locale.bind(LOCALE_NS)
  ctx.effect(() => ctx.locale.register(LOCALE_NS, messages), 'dsh-reminder: locale')
  ctx.effect(() => installReminder(ctx), 'dsh-reminder: session status watcher')
  ctx.effect(() => ctx.slots.inject('settings.plugin.item', () => ctx.slots.register({
    name: 'settings.plugin.item',
    key: 'dsh-reminder',
    order: 100,
    locale: LOCALE_NS,
  }, (props: { t?: (key: string) => string }) => React.createElement(ReminderSettings, { ctx, t: (key) => props.t?.(key) ?? t(key as LocaleKey) }))), 'dsh-reminder: unified plugin settings')
}
