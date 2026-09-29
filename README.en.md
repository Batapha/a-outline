# A outline

[中文](README.md)

## Introduction

A outline is an Obsidian plugin. It renders block references as inline text and makes lists behave more like an outliner.

The plugin provides five capabilities:

- Inline block references: a reference sits in the same line as the surrounding text and refreshes when the source block changes.
- Block search: type `@` and a keyword to find a block anywhere in the vault and insert a block link.
- Block id protection: the trailing `^id` is hidden, and Enter, Backspace and Delete no longer lose it.
- Outline look: round bullets, indentation guides, and guides that show only the ancestor chain.
- Cursor and position: Roam-style cursor movement, and files reopen at the position where you left them.

The plugin makes no network requests and collects no data. It works on desktop and mobile.

## Quick start

1. Install and enable the plugin. See "Installation".
2. In any note, type `@` and a keyword, pick a block, and press `Enter`.
3. The plugin inserts a block link such as `[[Note name#^abc123]]` and writes the id into the note that contains the block.
4. The link shows as an inline reference. Hold `Shift` and click it to open the source block in a right-hand split.

## Basics

### Requirements

- Obsidian 1.8.7 or later. The plugin was tested on Obsidian 1.13.7, and the file tree guides are written against the file tree structure of that version.
- Turn on the Obsidian setting "Editor → Show indentation guides". You only need it for the indentation-guide features.

### Installation

From the community plugin browser (available after the plugin is listed):

1. Open "Settings → Community plugins" and turn off Restricted mode.
2. Click "Browse" and search for "A outline".
3. Click "Install", then "Enable".

Manual installation:

1. Download `main.js`, `manifest.json` and `styles.css` from the Releases page of this repository.
2. Create the folder `.obsidian/plugins/a-outline/` in your vault and put the three files in it.
3. Restart Obsidian and enable "A outline" under "Community plugins".

### Settings

The settings page has three groups: editing and references, theme, and file explorer. The table lists the default of each option. The setting labels in the plugin are currently in Chinese; the Chinese label is shown in parentheses.

| Group | Setting | Default | Effect |
|---|---|---|---|
| Editing | Inline block references (行内块引用) | On | Render `[[Note#^block]]` as inline text |
| Editing | Task state in references, experimental (引用带待办状态) | Off | Show the checkbox when a reference points to a task; clicking it edits the source task |
| Editing | Shift+click to jump (Shift+点击跳转原文) | On | Hold Shift and click a reference to open the source block |
| Editing | Warm-up scan on open, experimental (打开文件时预热扫描) | Off | Measure the whole document first to reduce scroll jumps in long files |
| Editing | Vault-wide block search with @ (@ 唤起全库块搜索) | On | Type `@` to search blocks and insert a block link |
| Editing | Hide block ids (隐藏块 id) | On | Hide the trailing `^id` and enable block id protection |
| Editing | Roam-style cursor (Roam 式光标) | On | Cursor stays at line start or line end on Up, Down and Enter |
| Editing | Block reference counts (块引用计数) | Off | Show how many times a block is referenced |
| Editing | Context menu: copy block link/embed (右键菜单：复制块链接/嵌入) | On | Add two copy items to the editor context menu |
| Editing | Remember cursor and scroll position (记住光标与滚动位置) | On | Restore the position when a file is reopened |
| Theme | Outline style (大纲视图样式) | On | Round bullets, hover halo, wider indentation and aligned guides |
| Theme | Guides show ancestors only (缩进参考线只显示上级链) | On | Draw one vertical line for each ancestor of the block under the cursor |
| Theme | Wider line height (加宽行距并统一列表间距) | Off | Raise the line height to 1.7 and unify list spacing |
| Theme | Compact list spacing (紧凑列表间距) | Off | Tighten list line spacing; choose either this or wider line height |
| Theme | Accent color for bold (加粗用重点色) | Off | Bold text uses the theme accent color |
| Theme | Round checkboxes (圆角待办框) | Off | Make task checkboxes circular |
| Theme | Heading level badges (标题级别徽标) | Off | Show a faint H1 to H6 label to the left of headings |
| Theme | Liquid glass, experimental (液态玻璃) | Off | Use a frosted-glass look for popups and menus |
| File explorer | File tree guides (文件树参考线) | Off | Draw a thin line in front of each nested level of the file tree |
| File explorer | File tree guides: elbows (文件树参考线：肘线) | Off | Draw a short horizontal line from the guide to each child |
| File explorer | File tree guides: mute files (文件树参考线：文件行淡化) | Off | Show file names in a lighter color than folder names |
| File explorer | File tree guides: indent (文件树参考线：层级缩进) | 32 px | Indentation of each nested level, 8 to 60 px |

You can fine-tune the look with a CSS snippet. The plugin provides these variables:

| Variable | Effect |
|---|---|
| `--oo-ref-color` | Text color of references |
| `--oo-ref-bg-alpha` | Opacity of the reference background |
| `--oo-list-indent` | List indentation of the outline style, 2.5 em by default |
| `--oo-line-height` | Line height when wider line height is on, 1.7 by default |
| `--oo-checkbox-radius` | Corner radius of round checkboxes |
| `--oo-hlv-color`, `--oo-hlv-opacity`, `--oo-hlv-size` | Color, opacity and size of heading level badges |
| `--oo-nav-guide-w`, `--oo-nav-guide-alpha`, `--oo-nav-guide-alpha-active` | Line width, opacity, and opacity of the active branch of file tree guides |

## Usage

### Inline block references

Block links `[[Note#^blockid]]` and block embeds `![[Note#^blockid]]` render as inline text. A reference shares the line with the surrounding text, wraps naturally, and keeps the line height. It works in reading view and live preview.

Display rules:

- A reference to a list item shows that line only, without its children.
- A reference to a heading that has an id shows the heading text only.
- A reference refreshes when the source block changes.
- A reference whose target does not exist appears with a gray dashed underline and cannot be followed.
- Nested references are shown up to 2 levels deep.

Interaction:

- Click a reference: the cursor enters the link code, so you can edit the link.
- `Shift` + click: open the source block in a right-hand split (desktop only).
- `Shift` + `Cmd` or `Ctrl` + click: open the source block in a new tab.

### Block search and block links

Type `@` anywhere, then a keyword, to search every block in the vault. `@` can directly follow text. To leave email addresses alone, the popup stops appearing when `@` follows a letter, digit or email symbol and a period has been typed after the `@`. The keyword can be up to 40 characters and cannot contain spaces. The candidate list shows the block text, file path and line number. Press `Enter` to insert a block link.

If the target block has no id, the plugin generates one and writes it into the target note.

Typing `@` without a keyword lists the most referenced blocks. When no block has been referenced yet, it lists blocks from the most recently modified files. When nothing matches, the popup shows a "no matching block" row (没有匹配的块).

Three commands can be bound to hotkeys:

- "Copy block link of the current block" (id generated when missing).
- "Copy block embed of the current block" (id generated when missing).
- "Insert @ block search", handy for the mobile toolbar.

The editor context menu also offers the first two.

### Block id protection

Obsidian only recognizes an id at the end of the last line of a paragraph. Once the id is hidden, the cursor can sit before or after it, and one Enter or Backspace can expose, lose or invalidate it.

With "Hide block ids" on, the plugin handles three keys:

- `Enter`: keeps the id in the original paragraph and starts the new content in a new paragraph.
- `Backspace` and `Delete`: when two lines are merged or deleted, the id moves to the last line of the merged paragraph.
- Both lines have an id: the merge is blocked and a notice appears.

The plugin does not intervene during IME composition, with a selection, or inside code blocks and math.

### Outline look

With "Outline style" on, lists get this look:

- Round bullets, a halo on hover, and a permanent halo on collapsed nodes.
- Indentation widened to 2.5 em.
- Indentation guides drop from the center of the parent bullet or task checkbox.

With "Guides show ancestors only" on, each ancestor of the block under the cursor gets one vertical line and all other lines are hidden. When the cursor is not in a list, no line is shown.

### Cursor and position

Roam-style cursor rules:

- With the cursor at the start of the content (after the list marker or checkbox), Up and Down move it to the start of the content on the adjacent line.
- With the cursor at the end of a line, Up and Down move it to the end of the adjacent line. If the line ends with a hidden id, the cursor stops before the id.
- Pressing `Enter` at the start of the content moves the cursor into the newly opened line.

"Remember cursor and scroll position" records the position when a file is closed or switched, and restores it when the file is reopened. Tabs that were open before a restart are restored too. The positions are stored on this device only and are not synced. Files opened through back and forward navigation, heading links, block links or search results are not affected.

### File tree guides

When enabled, a thin line appears in front of each nested level of the left-hand file tree. It drops from the center of the parent folder's arrow, and the branch that contains the current file is darker.

Elbows and muted file rows are two optional extras. The level indent can be set between 8 and 60 px.

### Daily stream

The command "Open daily stream" shows the latest 7 daily notes in a new tab, one after another. Click "Load 7 more days" to continue. Chinese labels: 打开日记流（瀑布视图）, 加载更多 7 天.

A daily note is a note whose file name is `YYYY-MM-DD`, in any folder. Click the date to open that note in a new tab.

## FAQ

**Block ids are hidden. How do I see them?**

Turn off the setting "Hide block ids".

**A reference shows as gray dashed text. Why?**

The target note or block does not exist, or the block id was changed.

**Nothing pops up when I type `@`. What should I check?**

Check three things: the setting "Vault-wide block search with @" is on; you are in editing mode, since reading view does not respond; and no period has been typed after the `@`, and it is not a double `@@`.

**The indentation guides do not appear. What should I do?**

Check two settings: the Obsidian setting "Show indentation guides" and the plugin setting "Outline style".

**The heading level badges are missing on my phone. Is that a bug?**

No. The badges are not shown on phones.

**What if the plugin conflicts with another plugin?**

If another plugin also takes over the rendering of block embeds, or also rewrites the Enter key in lists, the two behaviors stack. Turn off the matching feature in one of them.

**Does the plugin use the network?**

No. It sends no network requests and collects no data.

**Does the plugin modify my notes?**

Only in three cases:

- It adds an id to a target block that has none, when you use `@` search or copy a block link.
- It edits the source task line when you click a checkbox inside a reference, with "Task state in references" on.
- It moves an id when block id protection merges two lines.

**Where are the settings and positions stored?**

Settings are stored in `data.json` in the plugin folder. Cursor and scroll positions are stored in the local storage of this device.

## Appendix

### Known limitations

- The interface text is currently in Chinese only.
- Nested references are shown up to 2 levels deep, and a circular reference is shown as an ellipsis.
- Positions are recorded by line number, so they can shift when the file is edited elsewhere.
- The daily stream only recognizes notes named `YYYY-MM-DD`.
- The plugin patches the way the editor opens files and calls an internal Obsidian interface for global search. These features may break after a major Obsidian update.

### Changelog

**1.0.1**: `@` block search now works directly after text, with a guard for email addresses.

**1.0.0**: first public release.

### Feedback

Please open an issue on the Issues page of this repository, and include the Obsidian version, the operating system and the steps to reproduce.

### License

MIT. See the `LICENSE` file.
