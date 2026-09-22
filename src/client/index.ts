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
  popup: boolean
  soundId: SoundId
  volume: number
}

type ReminderMode = 'off' | 'background' | 'always'

type Preferences = {
  enabled: boolean
  mode: ReminderMode
  events: Record<ReminderKind, EventPreference>
}

type DesktopAttention = {
  attention?: (request?: { flash?: boolean }) => Promise<{
    focused: boolean
    minimized: boolean
    visible: boolean
  }>
}

type SessionSummary = {
  id?: string
  sessionId?: string
  title?: string
  displayTitle?: string
  running: boolean
  origin?: string
  pendingInteraction?: 'approval' | 'question' | string
  projectionValues?: Record<string, unknown>
}

type SessionListSnapshot = {
  // DSH Desktop before 0.1.2 exposed a keyed snapshot; current builds expose items.
  ids?: string[]
  byId?: Record<string, SessionSummary>
  items?: SessionSummary[]
}

type Sessions = {
  list: {
    getSnapshot(): SessionListSnapshot
    subscribe(listener: () => void): () => void
  }
}

type Remote = {
  $on(event: 'user-questions/request' | 'approval/request', listener: (this: unknown, request: unknown, next: () => Promise<unknown>) => Promise<unknown>): void
}

type PendingInteraction = { key: string; kind: 'approval' | 'question' | 'plan-review' | string }
type UiSession = {
  pendingInteractions: {
    getSnapshot(): Map<string, PendingInteraction>
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
  remote: Remote
  uiSession: UiSession
  connection: Connection
  effect(fn: () => void | (() => void), label?: string): void
}

type ImportedTone = { id: string; name: string }
const importedToneBuffers = new Map<string, AudioBuffer>()
let runtimePreferences: Preferences | undefined
let preferencesReady: Promise<void> | undefined
let sharedAudioContext: AudioContext | undefined
let audioUnlocked = false

type AudioContextConstructor = typeof AudioContext

function audioContext(): AudioContext {
  if (sharedAudioContext) return sharedAudioContext
  const AudioContextCtor = (window.AudioContext || (window as any).webkitAudioContext) as AudioContextConstructor | undefined
  if (!AudioContextCtor) throw new Error('Web Audio is unavailable.')
  sharedAudioContext = new AudioContextCtor()
  return sharedAudioContext
}

async function unlockAudio(): Promise<void> {
  const audio = audioContext()
  if (audio.state !== 'running') await audio.resume()
  if (audio.state !== 'running') throw new Error('Audio playback is blocked until you interact with DSH Desktop.')
  audioUnlocked = true
}

function installAudioUnlock(): () => void {
  const unlock = () => { void unlockAudio().catch(() => {}) }
  document.addEventListener('pointerdown', unlock, { capture: true })
  document.addEventListener('keydown', unlock, { capture: true })
  return () => {
    document.removeEventListener('pointerdown', unlock, { capture: true })
    document.removeEventListener('keydown', unlock, { capture: true })
  }
}

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

async function importedToneBuffer(ctx: ClientContext, id: string): Promise<AudioBuffer> {
  const cached = importedToneBuffers.get(id)
  if (cached) return cached
  const response = await reminderRpc<{ data: string }>(ctx, 'readTone', { id })
  const bytes = Uint8Array.from(atob(response.data), (character) => character.charCodeAt(0))
  const source = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer
  const buffer = await audioContext().decodeAudioData(source)
  importedToneBuffers.set(id, buffer)
  return buffer
}

const MODE_VALUES: ReminderMode[] = ['off', 'background', 'always']

function modeFromSaved(saved: Partial<Preferences> | undefined): ReminderMode {
  if (saved?.mode === 'off' || saved?.mode === 'background' || saved?.mode === 'always') return saved.mode
  if (saved?.enabled === false) return 'off'
  return 'background'
}

const defaults: Preferences = {
  enabled: true,
  mode: 'background',
  events: {
    approval: { sound: true, flash: true, popup: true, soundId: 'alert', volume: 0.5 },
    question: { sound: true, flash: true, popup: true, soundId: 'double', volume: 0.5 },
    completed: { sound: true, flash: true, popup: true, soundId: 'chime', volume: 0.5 },
    failed: { sound: true, flash: true, popup: true, soundId: 'alert', volume: 0.5 },
  },
}

function cloneDefaults(): Preferences {
  return JSON.parse(JSON.stringify(defaults)) as Preferences
}

function mergePreferences(saved: Partial<Preferences> | undefined): Preferences {
  const mode = modeFromSaved(saved)
  return {
    enabled: mode !== 'off',
    mode,
    events: Object.fromEntries((Object.keys(defaults.events) as ReminderKind[]).map((kind) => [kind, {
      ...defaults.events[kind],
      ...saved?.events?.[kind],
      popup: saved?.events?.[kind]?.popup ?? defaults.events[kind].popup,
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
    const merged = mergePreferences(saved ?? local)
    runtimePreferences = merged
    const needsMigration = !saved || saved.mode !== merged.mode || (Object.keys(defaults.events) as ReminderKind[]).some((kind) => typeof saved.events?.[kind]?.volume !== 'number' || typeof saved.events?.[kind]?.popup !== 'boolean')
    if (needsMigration) return reminderRpc(ctx, 'savePreferences', merged).then(() => undefined)
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
  await unlockAudio()
  const audio = audioContext()
  if (id.startsWith('imported:')) {
    const source = audio.createBufferSource()
    const gain = audio.createGain()
    source.buffer = await importedToneBuffer(ctx, id.slice('imported:'.length))
    gain.gain.value = Math.min(1, 0.65 * playbackGain)
    source.connect(gain).connect(audio.destination)
    source.start()
    return
  }
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
}

function desktopAttention(): DesktopAttention | undefined {
  return (window as Window & { dshDesktop?: DesktopAttention }).dshDesktop
}

const POPUP_TITLES: Record<ReminderKind, { zh: string; en: string }> = {
  approval: { zh: 'DSH 等待确认', en: 'DSH is waiting for confirmation' },
  question: { zh: 'DSH 等待回答', en: 'DSH is waiting for your answer' },
  completed: { zh: 'DSH 任务已完成', en: 'DSH task completed' },
  failed: { zh: 'DSH 任务失败或阻塞', en: 'DSH task failed or blocked' },
}

function popupLocale(): 'zh' | 'en' {
  const language = document.documentElement.lang || navigator.language || ''
  return language.toLowerCase().startsWith('zh') ? 'zh' : 'en'
}

function popupCopy(kind: ReminderKind): { title: string; body: string } {
  const locale = popupLocale()
  return {
    title: POPUP_TITLES[kind][locale],
    body: locale === 'zh' ? '请查看 DSH Desktop。' : 'Open DSH Desktop for details.',
  }
}

function showPopup(ctx: ClientContext, kind: ReminderKind): Promise<void> {
  const copy = popupCopy(kind)
  return reminderRpc(ctx, 'notify', copy).then(() => undefined)
}

function showFlash(ctx: ClientContext, force = false): Promise<void> {
  return reminderRpc(ctx, 'flash', { force }).then(() => undefined)
}

function notifyReminder(ctx: ClientContext, kind: ReminderKind): void {
  const preferences = runtimePreferences ?? cloneDefaults()
  const event = preferences.events[kind]
  if (preferences.mode === 'off' || !event) return
  const foreground = isForeground()
  if (preferences.mode === 'background' && foreground) return
  if (event.sound) void playTone(ctx, event.soundId, event.volume).catch(() => {})
  if (event.popup) void showPopup(ctx, kind).catch(() => {})
  if (event.flash) {
    void desktopAttention()?.attention?.({ flash: true }).catch(() => {})
    void showFlash(ctx, preferences.mode === 'always' && foreground).catch(() => {})
  }
}

function installInteractionReminders(ctx: ClientContext): () => void {
  const observed = new Set<string>()
  let lastKind: ReminderKind | undefined
  let lastAt = 0
  const notifyOnce = (kind: ReminderKind) => {
    const now = Date.now()
    if (lastKind === kind && now - lastAt < 2_000) return
    lastKind = kind
    lastAt = now
    notifyReminder(ctx, kind)
  }
  const reconcile = () => {
    const pending = ctx.uiSession.pendingInteractions.getSnapshot()
    const current = new Set<string>()
    for (const interaction of pending.values()) {
      current.add(interaction.key)
      if (observed.has(interaction.key)) continue
      if (interaction.kind === 'approval') notifyOnce('approval')
      if (interaction.kind === 'question' || interaction.kind === 'plan-review') notifyOnce('question')
    }
    observed.clear()
    for (const key of current) observed.add(key)
  }
  // Seed existing interactions without alerting, then alert only on state edges.
  for (const interaction of ctx.uiSession.pendingInteractions.getSnapshot().values()) observed.add(interaction.key)
  const dispose = ctx.uiSession.pendingInteractions.subscribe(reconcile)
  ctx.remote.$on('user-questions/request', async function (_request, next) {
    notifyOnce('question')
    return next()
  })
  ctx.remote.$on('approval/request', async function (_request, next) {
    notifyOnce('approval')
    return next()
  })
  return dispose
}

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
  const reconcile = async () => {
    await ensurePreferences(ctx)
    const snapshot = ctx.sessions.list.getSnapshot()
    // 0.1.2+ provides an item array keyed by sessionId; older runtimes used ids/byId.
    const entries = snapshot.items ?? (snapshot.ids ?? []).map((id) => snapshot.byId?.[id]).filter((item): item is SessionSummary => item !== undefined)
    for (const item of entries) {
      const sessionId = item.sessionId ?? item.id
      if (!sessionId || item.origin === 'subagent') continue
      const prior = observed.get(sessionId)
      const goal = item.projectionValues?.goal as { phase?: string } | undefined
      const current = { running: item.running, pending: item.pendingInteraction, goalPhase: goal?.phase }
      if (prior) {
        const kind = eventFor(item, prior)
        if (kind) notifyReminder(ctx, kind)
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
    title: 'DSH 提醒', description: '在主会话需要处理时按下方勾选提醒一次。', statusReady: '声音、系统通知和任务栏闪烁都可用。', statusSoundOnly: '声音、系统通知和任务栏闪烁都可用。', audioReady: '声音提醒已就绪。勾选“系统通知”后，试听会在屏幕右下角弹出 Windows 通知。勾选“任务栏闪烁”后，试听会闪任务栏图标。', audioBlocked: '请先点击“试听”一次以启用声音提醒。', popupHint: '系统通知会出现在屏幕右下角。任务栏闪烁会点亮任务栏里的 DSH 图标。', popupSent: '已发送系统通知，请看屏幕右下角。', popupFailed: '系统通知未能弹出。请检查 Windows 通知设置，并关闭专注助手。', flashSent: '已请求任务栏闪烁，请看任务栏中的 DSH 图标。', flashFailed: '任务栏未能闪烁。', modeTitle: '提醒时机', modeOff: '关闭', modeBackground: '仅后台', modeAlways: '始终', modeOffHint: '不发出任何提醒。', modeBackgroundHint: '仅当 DSH 不在前台或已最小化时提醒。', modeAlwaysHint: '即使 DSH 已经在最前面，也会按下方勾选发出提醒。', sound: '提示音', popup: '系统通知', flash: '任务栏闪烁', volume: '音量', test: '试听', audioFailed: '无法播放提示音，请检查系统音量并再次点击试听。', importTone: '导入 MP3/WAV', importing: '正在导入...', importFailed: '导入失败', importedTones: '已导入提示音', chime: '提示音', double: '双音提示', alert: '警示音', silent: '静音', approval: '等待权限或高风险操作确认', question: '等待回答澄清问题', completed: '主任务完成', failed: '主任务失败或阻塞', expand: '展开', collapse: '收起'
  },
  en: {
    title: 'DSH Reminder', description: 'Alert once when a main session needs attention, according to the switches below.', statusReady: 'Sound, system notifications, and taskbar flashing are available.', statusSoundOnly: 'Sound, system notifications, and taskbar flashing are available.', audioReady: 'Sound reminders are ready. With “System notification” on, Test sound also shows a Windows toast. With “Flash taskbar” on, it flashes the DSH taskbar icon.', audioBlocked: 'Click “Test sound” once to enable sound reminders.', popupHint: 'System notifications appear at the bottom-right. Taskbar flashing lights the DSH icon.', popupSent: 'A system notification was sent. Look at the bottom-right of the screen.', popupFailed: 'The system notification could not be shown. Check Windows notification settings and turn off Focus Assist.', flashSent: 'Taskbar flashing was requested. Look at the DSH icon on the taskbar.', flashFailed: 'The taskbar could not flash.', modeTitle: 'When to remind', modeOff: 'Off', modeBackground: 'Background only', modeAlways: 'Always', modeOffHint: 'Do not send any reminders.', modeBackgroundHint: 'Remind only when DSH is unfocused or minimized.', modeAlwaysHint: 'Remind even when DSH is already in the foreground.', sound: 'Sound', popup: 'System notification', flash: 'Flash taskbar', volume: 'Volume', test: 'Test sound', audioFailed: 'The tone could not play. Check system volume and try Test sound again.', importTone: 'Import MP3/WAV', importing: 'Importing...', importFailed: 'Import failed', importedTones: 'Imported tones', chime: 'Chime', double: 'Double chime', alert: 'Alert', silent: 'Silent', approval: 'Waiting for permission or high-risk confirmation', question: 'Waiting for your answer', completed: 'Main task completed', failed: 'Main task failed or blocked', expand: 'Expand', collapse: 'Collapse'
  }
} as const

type LocaleKey = keyof typeof messages.zh

function ReminderSettingsDom(ctx: ClientContext, t: (key: LocaleKey) => string): HTMLElement {
  let preferences = runtimePreferences ?? cloneDefaults()
  let importedTones: ImportedTone[] = []
  let importError = ''
  let audioError = ''
  let popupStatus = ''
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
      .dsh-reminder-settings .status { margin: 0 0 12px; color: var(--dsw-alias-label-tertiary); font-size: 12px; line-height: 1.5; white-space: pre-wrap; }
      .dsh-reminder-settings .preview { display: none; margin: 0 0 12px; padding: 10px 12px; border: 1px solid var(--dsw-alias-border-l2); border-radius: 10px; background: var(--dsw-alias-bg-layer-2, transparent); }
      .dsh-reminder-settings .preview.show { display: block; }
      .dsh-reminder-settings .preview-title { font-size: 13px; font-weight: 600; }
      .dsh-reminder-settings .preview-body { margin-top: 4px; color: var(--dsw-alias-label-tertiary); font-size: 12px; }
      .dsh-reminder-settings .mode { margin: 0 0 14px; }
      .dsh-reminder-settings .mode-title { display: block; margin-bottom: 8px; font-size: 13px; }
      .dsh-reminder-settings .mode-slider { width: 100%; margin: 0; accent-color: var(--dsw-alias-label-brand, #6f86ff); }
      .dsh-reminder-settings .mode-ticks { display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 8px; margin-top: 6px; }
      .dsh-reminder-settings .mode-ticks button { padding: 0; border: 0; background: transparent; color: var(--dsw-alias-label-tertiary); font: inherit; font-size: 12px; cursor: pointer; }
      .dsh-reminder-settings .mode-ticks button:nth-child(1) { text-align: left; }
      .dsh-reminder-settings .mode-ticks button:nth-child(2) { text-align: center; }
      .dsh-reminder-settings .mode-ticks button:nth-child(3) { text-align: right; }
      .dsh-reminder-settings .mode-ticks button.active { color: var(--dsw-alias-label-primary); font-weight: 600; }
      .dsh-reminder-settings .mode-hint { margin: 6px 0 0; color: var(--dsw-alias-label-tertiary); font-size: 12px; line-height: 1.5; }
      .dsh-reminder-settings .event { display: grid; grid-template-columns: minmax(0, 1fr) auto auto auto; gap: 10px; align-items: center; border-top: 1px solid var(--dsw-alias-border-l2); padding: 12px 0; }
      .dsh-reminder-settings .event-name { min-width: 0; font-size: 13px; }
      .dsh-reminder-settings .event-controls { grid-column: 1 / -1; display: grid; grid-template-columns: minmax(0, 1fr) minmax(120px, 0.7fr) auto; gap: 10px; align-items: center; }
      .dsh-reminder-settings .event-controls select { min-width: 0; width: 100%; }
      .dsh-reminder-settings .volume-control { display: flex; align-items: center; gap: 6px; min-width: 0; }
      .dsh-reminder-settings .volume-control input { min-width: 0; width: 100%; }
      .dsh-reminder-settings .volume-value { min-width: 34px; text-align: right; font-variant-numeric: tabular-nums; }
      .dsh-reminder-settings label { font-size: 13px; }
      .dsh-reminder-settings select, .dsh-reminder-settings button { font: inherit; }
      .dsh-reminder-settings button, .dsh-reminder-settings .import-button { padding: 5px 9px; border: 1px solid var(--dsw-alias-border-l2); border-radius: 6px; color: inherit; background: transparent; cursor: pointer; display: inline-block; }
      .dsh-reminder-settings .imports { display: flex; align-items: center; gap: 10px; margin-bottom: 8px; }
      .dsh-reminder-settings .import-error { color: var(--dsw-alias-label-danger, #d54848); font-size: 12px; }
      .dsh-reminder-settings input[type=file] { position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden; clip: rect(0, 0, 0, 0); border: 0; }
      @media (max-width: 720px) { .dsh-reminder-settings .event { grid-template-columns: 1fr auto auto; } .dsh-reminder-settings .event label:nth-of-type(3) { grid-column: 2; } }
    </style>
    <div class="card">
      <button class="header" type="button" aria-expanded="false">
        <span class="head-text"><span class="title"></span><span class="description"></span></span>
        <span class="chevron">⌄</span>
      </button>
      <div class="body" hidden>
        <div class="status"></div>
        <div class="preview" hidden>
          <div class="preview-title"></div>
          <div class="preview-body"></div>
        </div>
        <div class="mode">
          <span class="mode-title"></span>
          <input class="mode-slider" type="range" min="0" max="2" step="1">
          <div class="mode-ticks">
            <button type="button" data-mode="off"></button>
            <button type="button" data-mode="background"></button>
            <button type="button" data-mode="always"></button>
          </div>
          <div class="mode-hint"></div>
        </div>
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
  importFile.accept = '.mp3,.wav,audio/mpeg,audio/mp3,audio/wav,audio/x-wav,audio/wave,audio/*'
  importFile.id = 'dsh-reminder-import-file'
  root.append(importFile)
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
    const status = root.querySelector('.status') as HTMLElement
    status.textContent = audioError || popupStatus || `${audioUnlocked ? t('audioReady') : `${t('statusReady')} ${t('audioBlocked')}`}\n${t('popupHint')}`
    const preview = root.querySelector('.preview') as HTMLElement
    preview.classList.toggle('show', Boolean(popupStatus && popupStatus === t('popupSent')))
    preview.hidden = !preview.classList.contains('show')
    const modeTitle = root.querySelector('.mode-title') as HTMLElement
    const modeSlider = root.querySelector('.mode-slider') as HTMLInputElement
    const modeHint = root.querySelector('.mode-hint') as HTMLElement
    const modeHints: Record<ReminderMode, LocaleKey> = { off: 'modeOffHint', background: 'modeBackgroundHint', always: 'modeAlwaysHint' }
    modeTitle.textContent = t('modeTitle')
    modeSlider.value = String(MODE_VALUES.indexOf(preferences.mode))
    modeSlider.setAttribute('aria-label', t('modeTitle'))
    modeHint.textContent = t(modeHints[preferences.mode])
    modeSlider.oninput = () => {
      preferences.mode = MODE_VALUES[Number(modeSlider.value)] ?? 'background'
      preferences.enabled = preferences.mode !== 'off'
      persist()
    }
    root.querySelectorAll('.mode-ticks button').forEach((button) => {
      const mode = (button as HTMLButtonElement).dataset.mode as ReminderMode
      button.textContent = t(mode === 'off' ? 'modeOff' : mode === 'always' ? 'modeAlways' : 'modeBackground')
      button.classList.toggle('active', mode === preferences.mode)
      ;(button as HTMLButtonElement).onclick = () => {
        preferences.mode = mode
        preferences.enabled = mode !== 'off'
        persist()
      }
    })
    const events = root.querySelector('.events') as HTMLElement
    events.replaceChildren()
    for (const kind of Object.keys(kinds) as ReminderKind[]) {
      const pref = preferences.events[kind]
      const row = document.createElement('div')
      row.className = 'event'
      const sound = document.createElement('label')
      sound.innerHTML = `<input type="checkbox" ${pref.sound ? 'checked' : ''}> ${t('sound')}`
      const popup = document.createElement('label')
      popup.innerHTML = `<input type="checkbox" ${pref.popup ? 'checked' : ''}> ${t('popup')}`
      const flash = document.createElement('label')
      flash.innerHTML = `<input type="checkbox" ${pref.flash ? 'checked' : ''}> ${t('flash')}`
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
      test.onclick = () => {
        audioError = ''
        popupStatus = ''
        render()
        const jobs: Array<Promise<void>> = []
        if (pref.popup) {
          const copy = popupCopy(kind)
          const preview = root.querySelector('.preview') as HTMLElement
          ;(preview.querySelector('.preview-title') as HTMLElement).textContent = copy.title
          ;(preview.querySelector('.preview-body') as HTMLElement).textContent = copy.body
          jobs.push(showPopup(ctx, kind).then(() => {
            popupStatus = t('popupSent')
          }).catch((error) => {
            popupStatus = error instanceof Error && error.message ? `${t('popupFailed')} ${error.message}` : t('popupFailed')
          }))
        }
        if (pref.flash) {
          jobs.push(showFlash(ctx, true).then(() => {
            if (!popupStatus) popupStatus = t('flashSent')
          }).catch((error) => {
            if (!popupStatus) popupStatus = error instanceof Error && error.message ? `${t('flashFailed')} ${error.message}` : t('flashFailed')
          }))
        }
        jobs.push(playTone(ctx, pref.soundId, pref.volume).catch(() => {
          audioError = t('audioFailed')
        }))
        void Promise.allSettled(jobs).then(() => render())
      }
      ;(sound.querySelector('input') as HTMLInputElement).onchange = (event) => { pref.sound = (event.target as HTMLInputElement).checked; persist() }
      ;(popup.querySelector('input') as HTMLInputElement).onchange = (event) => { pref.popup = (event.target as HTMLInputElement).checked; persist() }
      ;(flash.querySelector('input') as HTMLInputElement).onchange = (event) => { pref.flash = (event.target as HTMLInputElement).checked; persist() }
      select.onchange = () => { pref.soundId = select.value as SoundId; persist() }
      const name = document.createElement('span')
      name.className = 'event-name'
      name.textContent = t(kinds[kind])
      const controls = document.createElement('div')
      controls.className = 'event-controls'
      controls.append(select, volume, test)
      row.append(name, sound, popup, flash, controls)
      events.append(row)
    }
    const importRow = root.querySelector('.imports') as HTMLElement
    importRow.replaceChildren()
    const importButton = document.createElement('label')
    importButton.className = 'import-button'
    importButton.htmlFor = importFile.id
    importButton.textContent = t('importTone')
    importButton.onclick = (event) => {
      event.preventDefault()
      importFile.click()
    }
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
      render()
      const data = base64FromBytes(new Uint8Array(await file.arrayBuffer()))
      await reminderRpc(ctx, 'importTone', { name: file.name, data, mime: file.type })
      await refreshTones()
    } catch (error) {
      importError = error instanceof Error && error.message ? error.message : t('importFailed')
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

export const inject = ['slots', 'locale', 'sessions', 'remote', 'uiSession', 'connection']

export function apply(ctx: ClientContext): void {
  const t = ctx.locale.bind(LOCALE_NS)
  ctx.effect(() => ctx.locale.register(LOCALE_NS, messages), 'dsh-reminder: locale')
  installInteractionReminders(ctx)
  ctx.effect(() => installAudioUnlock(), 'dsh-reminder: audio unlock')
  ctx.effect(() => installReminder(ctx), 'dsh-reminder: session status watcher')
  ctx.effect(() => ctx.slots.inject('settings.plugin.item', () => ctx.slots.register({
    name: 'settings.plugin.item',
    key: 'dsh-reminder',
    order: 100,
    locale: LOCALE_NS,
  }, (props: { t?: (key: string) => string }) => React.createElement(ReminderSettings, { ctx, t: (key) => props.t?.(key) ?? t(key as LocaleKey) }))), 'dsh-reminder: unified plugin settings')
}
