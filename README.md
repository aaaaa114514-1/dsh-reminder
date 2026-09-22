# DSH Reminder

[简体中文](README.zh-CN.md)

A Windows DSH Desktop plugin that plays a one-time reminder, and can also show a Windows notification, when a main session needs attention while DSH is not in the foreground.

## Reminders

The plugin can remind you when a main session:

- Waits for a permission or high-risk-operation confirmation.
- Waits for an answer to a clarification question.
- Completes.
- Fails or becomes blocked.

It does not remind for long-running work alone, repeated unchanged states, or subagent events. It suppresses reminders while the DSH renderer is focused. A runtime error on the main session, including an invalid LLM API, is classified as failed, not completed. The plugin reads the session error snapshot and the last `turn/end` reason instead of treating every idle edge as success.

## Settings

Open **Settings -> Plugins -> DSH Reminder** to configure:

- A three-position timing slider: off, background only, or always.
- Sound, system-notification, and taskbar-flash switches for each reminder event.
- Built-in tones or imported MP3/WAV files for each event.
- A separate volume control and preview button for every event. Preview also shows a test notification and flashes the taskbar when those switches are on.

The 50% volume setting matches the original default reminder loudness. Imported tones and event preferences persist across DSH restarts. After a plugin reload or a DSH restart, click a preview button once to prepare browser audio for background reminders.

## Custom Tones

Use **Import MP3/WAV** in the plugin settings card to add a local audio file. The plugin stores an internal copy and makes it available in every event's tone selector. Imported files are limited to 10 MB each.

## Platform Notes

This plugin targets Windows DSH Desktop.

Sound reminders work in the renderer. System notifications use a Windows toast (with a balloon-tip fallback) from the plugin host. They appear at the bottom-right of the screen, not inside the settings card. Taskbar flashing uses Win32 `FlashWindowEx` against the live DSH Desktop window, so it no longer depends on a Desktop `dshDesktop.attention` bridge. Clicking **Test sound** with those switches enabled also shows a test toast and flashes the taskbar icon a few times. Windows Focus Assist / Do Not Disturb can still hide toasts.

## Development

Install dependencies, then run:

```bash
npm run typecheck
npm run build:client
```

The host entry can be compiled with TypeScript:

```bash
npx tsc -p tsconfig.json
```

This repository is intended for local DSH Desktop injection during development. See your DSH development environment's plugin-injection workflow to load the built `lib/` artifacts.

## License

BSD-3-Clause.
