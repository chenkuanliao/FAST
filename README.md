# FAST

a Fast Annotation and Snapshot Tool.

The idea is simple: when you work with agentic tools, your screenshots start
doing a suspicious amount of the talking.

You can write a beautiful, carefully worded prompt like:

> The spacing in the upper-right control cluster feels visually unbalanced
> relative to the panel below it.

Or you can send a screenshot with a big arrow and:

> this part is weird

The second one usually wins.

FAST exists for that moment. Grab the exact part of the screen, draw the circle,
point the arrow, add the tiny note, and let Excalidraw do the part where the
scribbles look charmingly intentional instead of like you drew them during an
earthquake. Then get it into your AI chat, bug report, design review, or
"future me will understand this" folder before the context evaporates.

It is not trying to be Photoshop. It is trying to be the fastest path from
"look at this" to an annotated screenshot that actually explains what you mean.

## Current Scope

- macOS-first Tauri desktop app.
- Region capture uses the native macOS interactive selector.
- Annotation editor is powered by the MIT-licensed Excalidraw React package,
  so selection, multi-select, text editing, arrows, shape handles, fill, undo,
  and rough/sketched rendering follow Excalidraw behavior.
- Export actions copy the annotated PNG to the clipboard or save it with a
  native save dialog.
- No screenshot history.

## Development

```sh
npm install
npm run tauri dev
```

macOS will require Screen Recording permission for region capture. If the first
capture returns a blank image or permission prompt, enable FAST or the terminal
app running it in System Settings, then restart the dev app.

## Build

Install dependencies first:

```sh
npm install
```

Build the web frontend:

```sh
npm run build
```

Build the packaged Tauri desktop app:

```sh
npm run tauri build
```

The packaged app and installer artifacts are written to `src-tauri/target/release/bundle/`.
