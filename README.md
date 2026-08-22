# clio

Extendable terminal persistence daemon. Shells run in a background daemon, so tabs and their 
containing windows can be closed and reattached without losing state. When the daemon crashes 
tabs come back remembering their name, directory and the command that was running, and pick up 
where they left off if there is an extension to do so, otherwise print what was running. 

Built on Node + [xterm.js](https://xtermjs.org) + node-pty, displayed in 
a Chrome app window. Currently Linux-only. To install or run:
```bash
bin/clio
```
On first run it fetches dependencies, starts the background daemon and opens a terminal window. 
To put it on your PATH, applications menu, and panel:

```bash
bin/clio install
```
| Other commands: | What it does |
| --- | --- |
| `clio start` | Start the daemon only, no window |
| `clio reload` | Run the code that is on disk now, keeping every shell running |
| `clio stop` | Stop the daemon (state is saved first) |
| `clio status` | Show the daemon, its windows and their tabs |
| `clio log [n]` | Tail the daemon log |

## Input

| Key | Action |
| --- | --- |
| `Ctrl+Shift+T` | New tab |
| `Ctrl+Shift+W` / `Ctrl+Shift+D` | Close tab |
| `Ctrl+Tab` / `Ctrl+Shift+Tab` | Next / previous tab |
| `Alt+1`…`Alt+9` | Jump to tab |
| `Ctrl+Shift+C` | Copy selection |
| `Ctrl+Shift+V` / `Ctrl+V` | Paste |

| Mouse | Action |
| --- | --- |
| Double-click a tab | Rename it |
| Drag a tab | Reorder it |
| Drag a tab onto another window's tabs | Move it there, shell and scrollback and all |
| Drag a tab out of every window | It becomes a window of its own |
| Middle-click a tab | Close it |
| Drag a file onto a tab | Type its path there |
| `Ctrl`+click a link | Open it wherever the desktop sends links |
| Right-click a link | Open it in a browser you pick by name |

`Ctrl+C`, `Ctrl+D`, `Ctrl+Z` and friends go to the shell untouched — `Ctrl+R`
included, so reverse search works as it does anywhere else.
Text size can be increased and decreased via arrows at the right end 
of the tab row, and changes will be saved. New windows are opened
with the plus button after the arrows.

## When a window loses its page

A window whose page Chrome has replaced with an error page — `Aw, Snap!`, or
`Can't open this page` with nothing on it but Send feedback — comes back with
**Ctrl+R**, tabs, names, scrollback and running programs and all. That is the
one moment `Ctrl+R` does not reach the shell: there is no page left to give it
to, so the browser takes it. If the window itself has gone, `clio` puts it back.

It happens because the renderer holding a window is the largest process on the
desktop once there is a day's scrollback in it, so it is the first thing killed
when the machine runs out of memory — earlyoom, on a desktop that runs it, opens
with a SIGTERM to exactly that process. Nothing in the tabs is affected: the shells are
in the daemon and never knew the window went. Chrome's error page belongs to
Chrome and cannot be made to explain any of that, so clio says it in the three
places it can reach — a desktop notification as it happens, a note against the
window in `clio status`, and a line in the window once it is back.

## Extensions

Clio ships with claude code and ssh extensions that resume claude and ssh sessions

A Claude Code tab that has stopped — a turn finished, or a permission question
waiting on screen — pulses its name in the tab row until you look at it. It is
read off the terminal title, which is where Claude Code says which of the two it
is doing: a spinner while it works, a still glyph when it stops. Only tabs you
are not looking at, and only ones that were working a moment ago, so a restart
never brings a row back with every tab announcing itself at once.
