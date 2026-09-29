# A outline

[中文](README.md)

## Introduction

A outline is an Obsidian plugin. It renders block references as inline text and makes cursor movement in lists feel more natural.

The plugin provides four capabilities:

- Inline block references: a reference sits in the same line as the surrounding text and refreshes when the source block changes.
- Block search: type `@` and a keyword to find a block anywhere in the vault and insert a block link.
- Block id protection: the trailing `^id` is hidden, and Enter, Backspace and Delete no longer lose it.
- Cursor and position: Roam-style cursor movement, and files reopen at the position where you left them.

The plugin makes no network requests and collects no data. It works on desktop and mobile.

## Quick start

1. Install and enable the plugin. See "Installation".
2. In any note, type `@` and a keyword, pick a block, and press `Enter`.
3. The plugin inserts a block link such as `[[Note name#^abc123]]` and writes the id into the note that contains the block.
4. The link shows as an inline reference. Hold `Shift` and click it to open the source block in a right-hand split.

## Basics

### Requirements

- Obsidian 1.8.7 or later. The plugin was tested on Obsidian 1.13.7.

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

The setting labels in the plugin are currently in Chinese; the Chinese label is shown in parentheses. The table lists the default of each option.

| Setting | Default | Effect |
|---|---|---|
| Inline block references (行内块引用) | On | Render `[[Note#^block]]` as inline text |
| Task state in references, experimental (引用带待办状态) | Off | Show the checkbox when a reference points to a task; clicking it edits the source task |
| Shift+click to jump (Shift+点击跳转原文) | On | Hold Shift and click a reference to open the source block |
| Warm-up scan on open, experimental (打开文件时预热扫描) | Off | Measure the whole document first to reduce scroll jumps in long files |
| Vault-wide block search with @ (@ 唤起全库块搜索) | On | Type `@` to search blocks and insert a block link |
| Hide block ids (隐藏块 id) | On | Hide the trailing `^id` and enable block id protection |
| Roam-style cursor (Roam 式光标) | On | Cursor stays at line start or line end on Up, Down and Enter |
| Block reference counts (块引用计数) | Off | Show how many times a block is referenced |
| Context menu: copy block link/embed (右键菜单：复制块链接/嵌入) | On | Add two copy items to the editor context menu |
| Remember cursor and scroll position (记住光标与滚动位置) | On | Restore the position when a file is reopened |

You can fine-tune the look of references with a CSS snippet. The plugin provides two variables:

| Variable | Effect |
|---|---|
| `--oo-ref-color` | Text color of references |
| `--oo-ref-bg-alpha` | Opacity of the reference background |

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

Type `@` anywhere, then a keyword, to search every block in the vault. `@` can directly follow text. To leave email addresses alone, the popup stops appearing when `@` follows a letter, digit or email symbol and a period has been typed after the `@`.

The keyword can be up to 40 characters and cannot contain spaces. The candidate list shows the block text, file path and line number. Press `Enter` to insert a block link.

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

### Cursor and position

Roam-style cursor rules:

- With the cursor at the start of the content (after the list marker or checkbox), Up and Down move it to the start of the content on the adjacent line.
- With the cursor at the end of a line, Up and Down move it to the end of the adjacent line. If the line ends with a hidden id, the cursor stops before the id.
- Pressing `Enter` at the start of the content moves the cursor into the newly opened line.

"Remember cursor and scroll position" records the position when a file is closed or switched, and restores it when the file is reopened. Tabs that were open before a restart are restored too. The positions are stored on this device only and are not synced. Files opened through back and forward navigation, heading links, block links or search results are not affected.

## FAQ

**Block ids are hidden. How do I see them?**

Turn off the setting "Hide block ids".

**A reference shows as gray dashed text. Why?**

The target note or block does not exist, or the block id was changed.

**Nothing pops up when I type `@`. What should I check?**

Check three things: the setting "Vault-wide block search with @" is on; you are in editing mode, since reading view does not respond; and no period has been typed after the `@`, and it is not a double `@@`.

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
- The plugin patches the way the editor opens files and calls an internal Obsidian interface for global search. These features may break after a major Obsidian update.

### Changelog

**1.0.2**: keeps only block reference and cursor features. Removed the outline look, indentation guides, heading badges, file tree guides, daily stream and the other theme options.

**1.0.1**: `@` block search now works directly after text, with a guard for email addresses.

**1.0.0**: first public release.

### Feedback

Please open an issue on the Issues page of this repository, and include the Obsidian version, the operating system and the steps to reproduce.

### License

MIT. See the `LICENSE` file.
