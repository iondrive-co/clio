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

## Keys

| Key | Action |
| --- | --- |
| `Ctrl+Shift+T` | New tab |
| `Ctrl+Shift+W` / `Ctrl+Shift+D` | Close tab |
| `Ctrl+Tab` / `Ctrl+Shift+Tab` | Next / previous tab |
| `Alt+1`…`Alt+9` | Jump to tab |
| `Ctrl+Shift+C` | Copy selection |
| `Ctrl+Shift+V` / `Ctrl+V` | Paste |
| Double-click a tab | Rename it |
| Drag a tab | Reorder |
| Middle-click a tab | Close it |

`Ctrl+C`, `Ctrl+D`, `Ctrl+Z` and friends go to the shell untouched.
Text size can be increased and decreased via arrows at the right end 
of the tab row, and changes will be saved. New windows are opened
with the plus button after the arrows.

## Extensions

Clio ships with claude code and ssh extensions that resume claude and ssh sessions
