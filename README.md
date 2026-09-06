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
| `Ctrl+Insert` / `Ctrl+Shift+C` | Copy selection |
| `Shift+Insert` / `Ctrl+Shift+V` / `Ctrl+V` | Paste |
| `Ctrl+C` | Copy, when something is selected; otherwise the shell's, as always |

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

`Ctrl+D`, `Ctrl+Z` and friends go to the shell untouched — `Ctrl+R` included, so
reverse search works as it does anywhere else. `Ctrl+C` does too, with one
exception: when there is a selection on screen it copies it and clears it, so
the next `Ctrl+C` is an interrupt again. Nothing is ever selected while you are
only typing, so nothing changes for anyone who never reaches for the mouse.

Text size can be increased and decreased via arrows at the right end 
of the tab row, and changes will be saved. New windows are opened
with the plus button after the arrows.

## Copy and paste, and the clipboard that will not answer

Every window is a Chrome `--app` window on a profile of its own, and reading the
system clipboard from one needs a permission Chrome asks for in a bubble hung
off an address bar that is not there. On a profile where it has not been granted
— which over RDP is every profile, because that is a display of its own and so a
profile of its own — `navigator.clipboard.readText()` returns a promise that is
never settled either way. A window cannot even find out that it has been
refused.

So clio asks the browser first, gives it a fraction of a second to answer, and
keeps its own copy of everything it has been asked to copy. That copy lives in
the daemon rather than in any one window, because windows are separate browser
processes sharing nothing else — which is what makes copy in one tab and paste
in another work between windows too, and go on working where the browser has
closed the clipboard to clio entirely. When the browser does answer it wins, so
text copied out of a web page still pastes into a shell.

`Shift+Insert` is the one paste that never needed any of this: it is the
browser's own, it asks no permission, and it is what to reach for if a paste
from somewhere outside clio ever comes up empty.

A program that asked for the mouse — claude, vim, less, tmux — is handed every
drag in the window, so dragging across one selects nothing to copy. Hold
`Shift` and the selection is clio's again. The right-click menu says so, in the
tabs where it applies.

## Where the windows were

Every window that was on screen comes back on its own — after a reboot, a crash,
an out-of-memory kill, the browser going down under it, or `clio stop` — with
its tabs, its scrollback, its size, and on the monitor it was on. Nothing is
asked about any of it.

The windows clio does ask about are the ones you closed yourself. Those are kept
under a name and offered when there is nothing else to put back (`clio windows`
lists them from a terminal, `clio open NAME` opens one). It can tell the
difference: a page says goodbye as it is taken apart, so a window whose page went
in silence was killed rather than closed — and every clio window is a page in one
browser, so when they all say goodbye in the same instant what went was the
browser, not four decisions about four windows.

A desktop can be logged in twice at once — at the machine and over RDP, say —
and then only one of the two sessions has somebody in front of it. Whichever came
up first has the windows, which at boot is the local one, seconds before anybody
has connected; so `clio` in the other session brings them over, with their tabs,
their scrollback and their shells, and takes the frames off the screen nobody is
at. Nothing is restarted and nothing is asked. `clio status` says which display
each window is on when it is not the one you are asking from.

The monitor is the one part a page cannot manage alone. A browser will not move a
window from one screen to another — a move that would leave the screen it is on
is quietly stopped at the edge — so clio asks the window manager instead, through
`wmctrl`, or `xdotool` where that is what is installed. With neither, windows
still come back the size they were, together on whichever monitor the browser
opened them on, and `clio log` says so.

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
