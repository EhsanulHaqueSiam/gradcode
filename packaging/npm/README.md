# getmyprof

Find professors who can fund your degree, and the money behind them. Then reach out, apply and
compare offers. It runs on your machine, on your own Claude subscription.

![A hunt: ask, allow a paid lookup, review what it found, see the grid](https://raw.githubusercontent.com/EhsanulHaqueSiam/getmyprof/main/docs/screenshots/hunt.gif)

## Use

macOS, Linux or Windows, with Node 24 or newer:

```sh
npx getmyprof@latest
```

Keep the command:

```sh
npm install -g getmyprof
getmyprof
```

It opens in your browser. Sign in to Claude in Setup's first step, or with `getmyprof login`; npm
already brought the Claude Code binary for your machine.

| Command           | What it does                                      |
| ----------------- | ------------------------------------------------- |
| `getmyprof`       | starts it and opens your browser; Ctrl-C stops it |
| `getmyprof serve` | keeps it running in the background                |
| `getmyprof stop`  | stops the background server                       |
| `getmyprof login` | signs in to Claude in the terminal                |

With npx: `npx getmyprof@latest serve`. Update: `npm install -g getmyprof@latest`. Your data lives
in `~/.getmyprof`; `GETMYPROF_HOME` moves it.

The desktop app, screenshots and every feature:
[github.com/EhsanulHaqueSiam/getmyprof](https://github.com/EhsanulHaqueSiam/getmyprof#readme).
