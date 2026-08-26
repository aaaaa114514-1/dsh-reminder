# DSH Reminder

[简体中文](README.zh-CN.md)

A Windows DSH Desktop plugin that plays a one-time reminder when a main session needs attention while DSH is not in the foreground.

## Reminders

The plugin can remind you when a main session:

- Waits for a permission or high-risk-operation confirmation.
- Waits for an answer to a clarification question.
- Completes.
- Fails or becomes blocked.

It does not remind for long-running work alone, repeated unchanged states, or subagent events. It suppresses reminders while the DSH renderer is focused.

## Settings

Open **Settings -> Plugins -> DSH Reminder** to configure:

- A master enable switch.
- Sound and taskbar-flash switches for each reminder event.
- Built-in tones or imported MP3/WAV files for each event.
- A separate volume control and preview button for every event.

The 50% volume setting matches the original default reminder loudness. Imported tones and event preferences persist across DSH restarts.

## Custom Tones

Use **Import MP3/WAV** in the plugin settings card to add a local audio file. The plugin stores an internal copy and makes it available in every event's tone selector. Imported files are limited to 10 MB each.

## Platform Notes

This plugin targets Windows DSH Desktop.

Sound reminders work in the renderer. Native Windows taskbar flashing requires the optional Desktop `dshDesktop.attention({ flash })` bridge. When that bridge is unavailable, taskbar-flash controls are disabled and sound reminders remain available.

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
