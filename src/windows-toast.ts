import { spawn, spawnSync } from 'node:child_process'
import { join } from 'node:path'

const REMINDER_AUMID = 'io.dsh.desktop.reminder'
const DESKTOP_AUMID = 'io.dsh.desktop'
const POWERSHELL_AUMID = '{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\\WindowsPowerShell\\v1.0\\powershell.exe'
const TOAST_GAP_MS = 400
let lastToastAt = 0
let toastWarned = false
let identityReady = false

export type ToastResult = { ok: true; channel: string } | { ok: false; error: string }

function powershellPath(): string {
  return join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
}

function clip(value: string, max: number): string {
  return value.replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, max)
}

function runReg(args: string[]): void {
  spawnSync('reg.exe', args, { windowsHide: true, stdio: 'ignore', timeout: 4000 })
}

function ensureReminderIdentity(): void {
  if (identityReady || process.platform !== 'win32') return
  identityReady = true
  try {
    runReg(['add', `HKCU\\Software\\Classes\\AppUserModelId\\${REMINDER_AUMID}`, '/ve', '/d', 'DSH Reminder', '/f'])
    runReg(['add', `HKCU\\Software\\Classes\\AppUserModelId\\${REMINDER_AUMID}`, '/v', 'DisplayName', '/t', 'REG_SZ', '/d', 'DSH Reminder', '/f'])
    runReg(['add', `HKCU\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Notifications\\Settings\\${REMINDER_AUMID}`, '/v', 'Enabled', '/t', 'REG_DWORD', '/d', '1', '/f'])
    runReg(['add', `HKCU\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Notifications\\Settings\\${REMINDER_AUMID}`, '/v', 'ShowInActionCenter', '/t', 'REG_DWORD', '/d', '1', '/f'])
    const exe = 'C:\\Program Files\\DSH Desktop\\DSH Desktop.exe'
    const lnk = join(process.env.APPDATA || '', 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'DSH Reminder.lnk')
    const encoded = Buffer.from(`
$ErrorActionPreference = 'Stop'
$WshShell = New-Object -ComObject WScript.Shell
$s = $WshShell.CreateShortcut($env:DSH_REMINDER_LNK)
$s.TargetPath = $env:DSH_REMINDER_EXE
$s.WorkingDirectory = [IO.Path]::GetDirectoryName($env:DSH_REMINDER_EXE)
$s.IconLocation = "$($env:DSH_REMINDER_EXE),0"
$s.Description = 'DSH Reminder'
$s.Save()
`.trim(), 'utf16le').toString('base64')
    spawnSync(powershellPath(), ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-EncodedCommand', encoded], {
      env: { ...process.env, DSH_REMINDER_LNK: lnk, DSH_REMINDER_EXE: exe },
      windowsHide: true,
      stdio: 'ignore',
      timeout: 5000,
    })
  } catch {
    // Identity setup is best-effort. The toast helper still tries known AUMIDs.
  }
}

const TOAST_SCRIPT = `
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
function XmlEscape([string]$s) {
  if ([string]::IsNullOrEmpty($s)) { return '' }
  return ((($s -replace '&','&amp;') -replace '<','&lt;') -replace '>','&gt;' -replace '"','&quot;')
}
$title = XmlEscape $env:DSH_REMINDER_TITLE
$body = XmlEscape $env:DSH_REMINDER_BODY
$xml = "<toast><audio silent='true'/><visual><binding template='ToastGeneric'><text>$title</text><text>$body</text></binding></visual></toast>"
[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null
[Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime] | Out-Null
function Show-Aumid([string]$aumid) {
  $doc = New-Object Windows.Data.Xml.Dom.XmlDocument
  $doc.LoadXml($xml)
  $toast = [Windows.UI.Notifications.ToastNotification]::new($doc)
  [Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier($aumid).Show($toast)
}
$shown = $false
foreach ($aumid in @(
  '${POWERSHELL_AUMID}',
  '${REMINDER_AUMID}',
  '${DESKTOP_AUMID}'
)) {
  try {
    Show-Aumid $aumid
    Write-Output ("shown:" + $aumid)
    $shown = $true
    break
  } catch {}
}
if (-not $shown) {
  Add-Type -AssemblyName System.Windows.Forms
  Add-Type -AssemblyName System.Drawing
  $n = New-Object System.Windows.Forms.NotifyIcon
  $n.Icon = [System.Drawing.SystemIcons]::Information
  $n.Visible = $true
  $n.BalloonTipTitle = $env:DSH_REMINDER_TITLE
  $n.BalloonTipText = $env:DSH_REMINDER_BODY
  $n.ShowBalloonTip(5000)
  Start-Sleep -Seconds 4
  $n.Dispose()
  Write-Output 'shown:balloon'
}
`.trim()

/**
 * Best-effort Windows toast. Failures never throw into the reminder path.
 * The helper is awaited briefly so 试听 can report success or failure.
 */
export function showWindowsToast(title: string, body: string, warn?: (message: string) => void): Promise<ToastResult> {
  if (process.platform !== 'win32') return Promise.resolve({ ok: false, error: 'Windows toasts are only available on Windows.' })
  const now = Date.now()
  if (now - lastToastAt < TOAST_GAP_MS) return Promise.resolve({ ok: true, channel: 'throttled' })
  lastToastAt = now
  ensureReminderIdentity()
  return new Promise((resolve) => {
    let settled = false
    const finish = (result: ToastResult) => {
      if (settled) return
      settled = true
      if (!result.ok && !toastWarned) {
        toastWarned = true
        warn?.(`[dsh-reminder] ${result.error}`)
      }
      resolve(result)
    }
    const encoded = Buffer.from(TOAST_SCRIPT, 'utf16le').toString('base64')
    const args = ['-NoProfile', '-STA', '-NonInteractive', '-WindowStyle', 'Hidden', '-EncodedCommand', encoded]
    const env = {
      ...process.env,
      DSH_REMINDER_TITLE: clip(title || 'DSH Reminder', 60),
      DSH_REMINDER_BODY: clip(body || '', 180),
    }
    const launch = (stdio: 'pipe' | 'ignore', detached: boolean) => spawn(powershellPath(), args, {
      env,
      windowsHide: true,
      stdio: stdio === 'pipe' ? ['ignore', 'pipe', 'pipe'] : 'ignore',
      detached,
    })
    try {
      const child = launch('pipe', false)
      let stdout = ''
      let stderr = ''
      child.stdout?.on('data', (chunk) => { stdout += String(chunk) })
      child.stderr?.on('data', (chunk) => { stderr += String(chunk) })
      const timer = setTimeout(() => {
        try { child.kill() } catch {}
        finish({ ok: false, error: 'Toast helper timed out.' })
      }, 8000)
      child.on('error', (error) => {
        clearTimeout(timer)
        try {
          const fallback = launch('ignore', true)
          fallback.unref()
          finish({ ok: true, channel: 'queued' })
        } catch {
          finish({ ok: false, error: error instanceof Error ? error.message : String(error) })
        }
      })
      child.on('close', (code) => {
        clearTimeout(timer)
        const line = stdout.split(/\r?\n/).map((item) => item.trim()).find((item) => item.startsWith('shown:'))
        if (line) {
          finish({ ok: true, channel: line.slice('shown:'.length) })
          return
        }
        if (code === 0) {
          finish({ ok: true, channel: 'powershell' })
          return
        }
        finish({ ok: false, error: stderr.trim() || `Toast helper exited ${code ?? 'unknown'}.` })
      })
    } catch {
      try {
        const fallback = launch('ignore', true)
        fallback.unref()
        finish({ ok: true, channel: 'queued' })
      } catch (error) {
        finish({ ok: false, error: error instanceof Error ? error.message : String(error) })
      }
    }
  })
}

export function prepareWindowsToast(): void {
  ensureReminderIdentity()
}
