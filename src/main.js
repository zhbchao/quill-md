import { Editor, Extension } from '@tiptap/core';
import { EditorState } from '@tiptap/pm/state';
import StarterKit from '@tiptap/starter-kit';
import Link from '@tiptap/extension-link';
import Image from '@tiptap/extension-image';
import Placeholder from '@tiptap/extension-placeholder';
import Typography from '@tiptap/extension-typography';
import TaskList from '@tiptap/extension-task-list';
import TaskItem from '@tiptap/extension-task-item';
import BubbleMenu from '@tiptap/extension-bubble-menu';
import CharacterCount from '@tiptap/extension-character-count';
import CodeBlockLowlight from '@tiptap/extension-code-block-lowlight';
import Table from '@tiptap/extension-table';
import TableRow from '@tiptap/extension-table-row';
import TableCell from '@tiptap/extension-table-cell';
import TableHeader from '@tiptap/extension-table-header';
import { Markdown } from 'tiptap-markdown';
import { common, createLowlight } from 'lowlight';

const quill = window.quill;
const lowlight = createLowlight(common);

// Tiptap binds strike to Mod-Shift-s, which collides with Save As on Windows
// (no native menu there to intercept it first). Rebind to Mod-Shift-x on both
// platforms to match the menus, and reserve Mod-Shift-s. Also swallow hard
// breaks inside tables: tiptap-markdown can't express them and would corrupt
// the cell on save.
const QuillKeymap = Extension.create({
  name: 'quillKeymap',
  priority: 1000,
  addKeyboardShortcuts() {
    return {
      'Mod-Shift-x': () => this.editor.commands.toggleStrike(),
      'Mod-Shift-s': () => true,
      'Shift-Enter': () => this.editor.isActive('table'),
      'Mod-Enter': () => this.editor.isActive('table'),
    };
  },
});

const els = {
  scroll: document.getElementById('scroll'),
  editor: document.getElementById('editor'),
  source: document.getElementById('source'),
  titlebar: document.getElementById('titlebar'),
  docName: document.getElementById('doc-name'),
  docEdited: document.getElementById('doc-edited'),
  wordCount: document.getElementById('word-count'),
  modePill: document.getElementById('mode-pill'),
  bubble: document.getElementById('bubble'),
  linkOverlay: document.getElementById('link-overlay'),
  linkInput: document.getElementById('link-input'),
};

// --- Document state ---

let currentPath = null;
let savedMarkdown = '';
let sourceMode = false;
let dirtyTimer = null;

const editor = new Editor({
  element: els.editor,
  autofocus: 'start',
  extensions: [
    StarterKit.configure({
      codeBlock: false,
      heading: { levels: [1, 2, 3, 4] },
      dropcursor: { color: 'var(--accent)', width: 2 },
    }),
    CodeBlockLowlight.configure({ lowlight }),
    Link.configure({
      openOnClick: false,
      autolink: true,
      HTMLAttributes: { rel: null, target: null },
    }),
    Image,
    Table.configure({ resizable: false }),
    TableRow,
    // Exactly one paragraph per cell: anything richer (a second paragraph from
    // pressing Enter) has no Markdown form, and tiptap-markdown's html:false
    // fallback would replace the whole table with "[table]" in the saved file.
    TableCell.extend({ content: 'paragraph' }),
    TableHeader.extend({ content: 'paragraph' }),
    QuillKeymap,
    TaskList,
    TaskItem.configure({ nested: true }),
    Typography,
    CharacterCount,
    Placeholder.configure({ placeholder: 'Start writing…' }),
    BubbleMenu.configure({
      element: els.bubble,
      tippyOptions: {
        duration: 0,
        placement: 'top',
        offset: [0, 10],
        zIndex: 9, // below the titlebar (10) and menu dropdowns
        appendTo: () => document.body,
      },
      shouldShow: ({ editor: ed, state }) =>
        !state.selection.empty &&
        !ed.isActive('codeBlock') &&
        !ed.isActive('image') &&
        state.selection.content().size > 0,
    }),
    Markdown.configure({
      html: false,
      linkify: true,
      breaks: false,
      transformPastedText: true,
      transformCopiedText: false,
    }),
  ],
  editorProps: {
    attributes: { class: 'content' },
    handleClick(view, pos, event) {
      const anchor = event.target.closest('a');
      if (anchor && (event.metaKey || event.ctrlKey)) {
        quill.openExternal(anchor.href);
        return true;
      }
      return false;
    },
  },
  onUpdate: () => {
    markDirtyNow();
    scheduleStateSync();
  },
  onSelectionUpdate: () => updateBubbleState(),
});

const getMarkdown = () => editor.storage.markdown.getMarkdown();

function currentMarkdown() {
  return sourceMode ? els.source.value : getMarkdown();
}

// Replace content and reset undo history so a freshly opened
// document can't be "undone" back into the previous one.
function loadDocument(markdown, filePath) {
  editor.commands.setContent(markdown, false);
  const { state, view } = editor;
  view.updateState(
    EditorState.create({ doc: state.doc, plugins: state.plugins, schema: state.schema })
  );
  currentPath = filePath || null;
  savedMarkdown = getMarkdown();
  if (sourceMode) els.source.value = savedMarkdown;
  autosizeSource();
  els.scroll.scrollTop = 0;
  editor.commands.focus('start');
  syncState();
}

// --- Dirty tracking, titlebar, word count ---

function isDirty() {
  return currentMarkdown() !== savedMarkdown;
}

// The main process gates its close-without-saving prompt on the edited flag,
// and syncState is debounced — so a keystroke followed immediately by a close
// would race it. Latch the flag the instant a change happens; the debounced
// sync corrects it back down (e.g. after undo) 200ms later.
let editedFlagSent = false;

function markDirtyNow() {
  if (!editedFlagSent) {
    editedFlagSent = true;
    quill.setEdited(true);
  }
}

function scheduleStateSync() {
  clearTimeout(dirtyTimer);
  dirtyTimer = setTimeout(syncState, 200);
}

function syncState() {
  const dirty = isDirty();
  els.docEdited.hidden = !dirty;
  els.docName.textContent = currentPath ? basename(currentPath) : 'Untitled';
  editedFlagSent = dirty;
  quill.setEdited(dirty);
  quill.setFile(currentPath || '');
  updateWordCount();
}

function basename(p) {
  return p.split(/[\\/]/).pop();
}

function updateWordCount() {
  let words;
  if (sourceMode) {
    const text = els.source.value.trim();
    words = text ? text.split(/\s+/).length : 0;
  } else {
    words = editor.storage.characterCount.words();
  }
  const minutes = Math.max(1, Math.round(words / 220));
  els.wordCount.textContent =
    words === 0
      ? '0 words'
      : `${words.toLocaleString()} ${words === 1 ? 'word' : 'words'} · ${minutes} min read`;
}

// --- Bubble menu ---

els.bubble.style.visibility = 'visible';

for (const button of els.bubble.querySelectorAll('button')) {
  button.addEventListener('mousedown', (e) => e.preventDefault());
  button.addEventListener('click', () => runCommand(button.dataset.cmd));
}

function updateBubbleState() {
  for (const button of els.bubble.querySelectorAll('button')) {
    const { cmd } = button.dataset;
    const active = cmd === 'link' ? editor.isActive('link') : editor.isActive(cmd);
    button.classList.toggle('is-active', active);
  }
}

// --- Link dialog ---

function openLinkDialog() {
  if (sourceMode) return;
  els.linkInput.value = editor.getAttributes('link').href || '';
  els.linkOverlay.hidden = false;
  els.linkInput.focus();
  els.linkInput.select();
}

function closeLinkDialog(apply) {
  if (els.linkOverlay.hidden) return;
  els.linkOverlay.hidden = true;
  if (apply) {
    let href = els.linkInput.value.trim();
    if (!href) {
      editor.chain().focus().extendMarkRange('link').unsetLink().run();
      return;
    }
    if (!/^[a-z][a-z0-9+.-]*:/i.test(href)) href = `https://${href}`;
    editor.chain().focus().extendMarkRange('link').setLink({ href }).run();
  } else {
    editor.commands.focus();
  }
}

els.linkInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    e.preventDefault();
    closeLinkDialog(true);
  } else if (e.key === 'Escape') {
    e.preventDefault();
    closeLinkDialog(false);
  }
});

els.linkOverlay.addEventListener('mousedown', (e) => {
  if (e.target === els.linkOverlay) closeLinkDialog(false);
});

// --- Source mode ---

function autosizeSource() {
  if (!sourceMode) return;
  els.source.style.height = 'auto';
  els.source.style.height = `${els.source.scrollHeight}px`;
}

function toggleSource() {
  closeLinkDialog(false);
  if (!sourceMode) {
    els.source.value = getMarkdown();
    els.editor.hidden = true;
    els.source.hidden = false;
    sourceMode = true;
    autosizeSource();
    els.source.focus();
  } else {
    const markdown = els.source.value;
    sourceMode = false;
    els.source.hidden = true;
    els.editor.hidden = false;
    editor.commands.setContent(markdown, false);
    editor.commands.focus();
  }
  els.modePill.hidden = !sourceMode;
  document.body.classList.toggle('source-mode', sourceMode);
  syncState();
}

els.source.addEventListener('input', () => {
  markDirtyNow();
  autosizeSource();
  scheduleStateSync();
});

// --- File operations ---

async function doSave(saveAs = false) {
  const markdown = currentMarkdown();
  let result = null;
  try {
    result = await quill.save(saveAs ? null : currentPath, markdown);
  } catch {
    // main already surfaced the error dialog; treat like a canceled save
  }
  if (!result) return false;
  currentPath = result.path;
  savedMarkdown = markdown;
  syncState();
  return true;
}

// Returns true if it is OK to discard/replace the current document.
async function confirmIfDirty() {
  if (!isDirty()) return true;
  const choice = await quill.confirmChange();
  if (choice === 2) return false;
  if (choice === 0) return doSave();
  return true;
}

async function doNew() {
  if (!(await confirmIfDirty())) return;
  loadDocument('', null);
}

async function doOpen() {
  if (!(await confirmIfDirty())) return;
  const file = await quill.openDialog();
  if (file) loadDocument(file.content, file.path);
}

async function loadFromPath(filePath) {
  if (!(await confirmIfDirty())) return;
  try {
    const file = await quill.readFile(filePath);
    if (file) loadDocument(file.content, file.path);
  } catch {
    /* main already surfaced the error dialog */
  }
}

// --- Commands from the application menu ---

function runCommand(name, arg) {
  const chain = () => editor.chain().focus();
  switch (name) {
    case 'new': return void doNew();
    case 'open': return void doOpen();
    case 'save': return void doSave(false);
    case 'save-as': return void doSave(true);
    case 'save-then-close':
      return void doSave(false).then((saved) => saved && quill.closeNow());
    case 'load-file':
      return void (async () => {
        if (!(await confirmIfDirty())) return;
        loadDocument(arg.content, arg.path);
      })();
    case 'toggle-source': return toggleSource();
    case 'self-test': return runSelfTest();
    case 'undo':
      return sourceMode ? document.execCommand('undo') : chain().undo().run();
    case 'redo':
      return sourceMode ? document.execCommand('redo') : chain().redo().run();
  }

  if (sourceMode) return; // formatting only applies to the rich editor

  switch (name) {
    case 'bold': return chain().toggleBold().run();
    case 'italic': return chain().toggleItalic().run();
    case 'strike': return chain().toggleStrike().run();
    case 'code': return chain().toggleCode().run();
    case 'link': return openLinkDialog();
    case 'h1': return chain().toggleHeading({ level: 1 }).run();
    case 'h2': return chain().toggleHeading({ level: 2 }).run();
    case 'h3': return chain().toggleHeading({ level: 3 }).run();
    case 'paragraph': return chain().setParagraph().run();
    case 'bulletList': return chain().toggleBulletList().run();
    case 'orderedList': return chain().toggleOrderedList().run();
    case 'taskList': return chain().toggleTaskList().run();
    case 'blockquote': return chain().toggleBlockquote().run();
    case 'codeBlock': return chain().toggleCodeBlock().run();
    case 'hr': return chain().setHorizontalRule().run();
  }
}

quill.onCommand(runCommand);
window.__editor = editor; // for debugging and scripted screenshots

// --- Smoke-test self check (only ever triggered with --smoke-test) ---

function runSelfTest() {
  try {
    const sample = [
      '# Title',
      '',
      'Some **bold**, *italic* and `code` text.',
      '',
      '- [ ] open task',
      '- [x] done task',
      '',
      '> a quote',
      '',
      '```js',
      'const x = 1;',
      '```',
      '',
      '| a | b |',
      '| --- | --- |',
      '| c | d |',
    ].join('\n');
    editor.commands.setContent(sample, false);
    const out = getMarkdown();
    const roundTrip =
      out.includes('# Title') &&
      out.includes('**bold**') &&
      out.includes('- [ ] open task') &&
      out.includes('- [x] done task') &&
      out.includes('> a quote') &&
      out.includes('```js') &&
      out.includes('| a | b |') &&
      !out.includes('[table]');
    const dom =
      els.editor.querySelector('h1') &&
      els.editor.querySelector('strong') &&
      els.editor.querySelector('input[type="checkbox"]') &&
      els.editor.querySelector('blockquote') &&
      els.editor.querySelector('pre code');
    loadDocument('', null);
    const ok = Boolean(roundTrip && dom);
    quill.smokeResult(ok, ok ? '' : `roundTrip=${roundTrip} dom=${Boolean(dom)} out=${JSON.stringify(out)}`);
  } catch (err) {
    quill.smokeResult(false, String((err && err.stack) || err));
  }
}

// --- Custom menu bar (Windows / Linux) ---
// titleBarStyle 'hidden' removes the native menu bar on those platforms, so
// Quill draws its own in the title bar, in the app's own design language.
// macOS keeps the real menu bar (built in electron/main.cjs).

const IS_CUSTOM_MENU = quill.platform !== 'darwin';

const MENUS = [
  {
    label: 'File',
    items: [
      { label: 'New', cmd: 'new', keys: 'Ctrl+N' },
      { label: 'Open…', cmd: 'open', keys: 'Ctrl+O' },
      { sep: true },
      { label: 'Save', cmd: 'save', keys: 'Ctrl+S' },
      { label: 'Save As…', cmd: 'save-as', keys: 'Ctrl+Shift+S' },
      { sep: true },
      { label: 'Exit', action: 'quit' },
    ],
  },
  {
    label: 'Edit',
    items: [
      { label: 'Undo', cmd: 'undo', keys: 'Ctrl+Z' },
      { label: 'Redo', cmd: 'redo', keys: 'Ctrl+Y' },
      { sep: true },
      { label: 'Cut', action: 'cut', keys: 'Ctrl+X' },
      { label: 'Copy', action: 'copy', keys: 'Ctrl+C' },
      { label: 'Paste', action: 'paste', keys: 'Ctrl+V' },
      { label: 'Paste as Plain Text', action: 'pasteAndMatchStyle', keys: 'Ctrl+Shift+V' },
      { sep: true },
      { label: 'Select All', action: 'selectAll', keys: 'Ctrl+A' },
    ],
  },
  {
    label: 'Format',
    items: [
      { label: 'Bold', cmd: 'bold', keys: 'Ctrl+B' },
      { label: 'Italic', cmd: 'italic', keys: 'Ctrl+I' },
      { label: 'Strikethrough', cmd: 'strike', keys: 'Ctrl+Shift+X' },
      { label: 'Inline Code', cmd: 'code', keys: 'Ctrl+E' },
      { label: 'Link…', cmd: 'link', keys: 'Ctrl+K' },
      { sep: true },
      { label: 'Heading 1', cmd: 'h1', keys: 'Ctrl+Alt+1' },
      { label: 'Heading 2', cmd: 'h2', keys: 'Ctrl+Alt+2' },
      { label: 'Heading 3', cmd: 'h3', keys: 'Ctrl+Alt+3' },
      { label: 'Body', cmd: 'paragraph', keys: 'Ctrl+Alt+0' },
      { sep: true },
      { label: 'Bulleted List', cmd: 'bulletList', keys: 'Ctrl+Shift+8' },
      { label: 'Numbered List', cmd: 'orderedList', keys: 'Ctrl+Shift+7' },
      { label: 'Task List', cmd: 'taskList', keys: 'Ctrl+Shift+9' },
      { sep: true },
      { label: 'Blockquote', cmd: 'blockquote', keys: 'Ctrl+Shift+B' },
      { label: 'Code Block', cmd: 'codeBlock', keys: 'Ctrl+Alt+C' },
      { label: 'Divider', cmd: 'hr' },
    ],
  },
  {
    label: 'View',
    items: [
      { label: 'Markdown Source', cmd: 'toggle-source', keys: 'Ctrl+/' },
      { sep: true },
      { label: 'Full Screen', action: 'toggle-fullscreen', keys: 'F11' },
    ],
  },
];

const menubarEl = document.getElementById('menubar');
let openMenuIndex = -1;

function setOpenMenu(index) {
  openMenuIndex = index;
  [...menubarEl.children].forEach((wrap, i) => wrap.classList.toggle('open', i === index));
  // While a menu is open the titlebar stops being a drag region (see CSS), so
  // clicks anywhere on it reach the DOM and dismiss the menu — native behavior.
  document.body.classList.toggle('menu-open', index !== -1);
}

function closeMenus() {
  if (openMenuIndex === -1) return;
  setOpenMenu(-1);
  // If keyboard navigation had focused a menu item (or focus fell to <body>
  // when a dropdown closed), hand focus back to the document.
  const el = document.activeElement;
  if (!el || el === document.body || el.closest('#menubar')) {
    if (sourceMode) els.source.focus();
    else editor.commands.focus();
  }
}

function buildMenubar() {
  document.body.classList.add('custom-menu');
  menubarEl.hidden = false;
  MENUS.forEach((menu, index) => {
    const wrap = document.createElement('div');
    wrap.className = 'menu';

    const button = document.createElement('button');
    button.className = 'menu-label';
    button.textContent = menu.label;
    button.tabIndex = -1;
    // mousedown (not click) so the editor keeps focus and selection
    button.addEventListener('mousedown', (e) => {
      e.preventDefault();
      if (e.button !== 0) return;
      setOpenMenu(openMenuIndex === index ? -1 : index);
    });
    button.addEventListener('mouseenter', () => {
      if (openMenuIndex !== -1 && openMenuIndex !== index) setOpenMenu(index);
    });

    const drop = document.createElement('div');
    drop.className = 'menu-drop';
    for (const item of menu.items) {
      if (item.sep) {
        const sep = document.createElement('div');
        sep.className = 'menu-sep';
        drop.appendChild(sep);
        continue;
      }
      const row = document.createElement('button');
      row.className = 'menu-item';
      row.tabIndex = -1;
      const name = document.createElement('span');
      name.textContent = item.label;
      row.appendChild(name);
      if (item.keys) {
        const keys = document.createElement('span');
        keys.className = 'menu-keys';
        keys.textContent = item.keys;
        row.appendChild(keys);
      }
      row.addEventListener('mousedown', (e) => e.preventDefault());
      row.addEventListener('mouseenter', () => row.focus()); // one highlight, mouse or keys
      row.addEventListener('click', () => {
        closeMenus();
        if (item.cmd) runCommand(item.cmd);
        else if (item.action) quill.menuAction(item.action);
      });
      drop.appendChild(row);
    }

    wrap.appendChild(button);
    wrap.appendChild(drop);
    menubarEl.appendChild(wrap);
  });

  window.addEventListener('mousedown', (e) => {
    if (openMenuIndex !== -1 && !e.target.closest('#menubar')) closeMenus();
  });
  window.addEventListener('blur', closeMenus);
  window.addEventListener('resize', closeMenus); // covers WCO maximize/restore
}

window.__openMenu = (i) => IS_CUSTOM_MENU && setOpenMenu(i); // scripted screenshots

if (IS_CUSTOM_MENU) {
  buildMenubar();

  // The static UI hints are written for macOS; translate them here.
  els.modePill.textContent = 'Markdown · Ctrl+/ to return';
  for (const button of els.bubble.querySelectorAll('button[title]')) {
    button.title = button.title.replace('⌘', 'Ctrl+');
  }

  // An open menu owns the keyboard: capture phase, so the editor never sees
  // these keys — exactly as a native menu would behave.
  window.addEventListener(
    'keydown',
    (e) => {
      if (openMenuIndex === -1) return;
      const items = [...menubarEl.children[openMenuIndex].querySelectorAll('.menu-item')];
      const focused = items.indexOf(document.activeElement);
      const swallow = () => {
        e.preventDefault();
        e.stopPropagation();
      };
      const switchMenu = (dir) => {
        const next = (openMenuIndex + dir + MENUS.length) % MENUS.length;
        setOpenMenu(next);
        menubarEl.children[next].querySelector('.menu-item')?.focus();
      };
      if (e.key === 'Escape' || e.key === 'Tab') {
        swallow();
        closeMenus();
      } else if (e.key === 'ArrowRight') {
        swallow();
        switchMenu(1);
      } else if (e.key === 'ArrowLeft') {
        swallow();
        switchMenu(-1);
      } else if (e.key === 'ArrowDown') {
        swallow();
        (items[focused + 1] || items[0])?.focus();
      } else if (e.key === 'ArrowUp') {
        swallow();
        (focused > 0 ? items[focused - 1] : items[items.length - 1])?.focus();
      } else if (e.key === 'Enter' && focused !== -1) {
        swallow();
        items[focused].click();
      }
    },
    true
  );

  // With no native application menu, these shortcuts need a home here.
  // All in-editor formatting (Ctrl+B/I/E, Ctrl+Alt+1…, Ctrl+Shift+8…) is
  // already bound by Tiptap's keymap, so only app-level commands remain.
  // Match physical keys (e.code) so non-Latin keyboard layouts still work.
  let altArmed = false;
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Alt' && !e.repeat && !e.ctrlKey && !e.shiftKey && !e.metaKey) {
      altArmed = true;
      return;
    }
    altArmed = false;
    if (e.key === 'F11') {
      e.preventDefault();
      quill.menuAction('toggle-fullscreen');
      return;
    }
    if (!e.ctrlKey || e.altKey || e.metaKey) return;
    let cmd = null;
    if (!e.shiftKey && e.code === 'KeyN') cmd = 'new';
    else if (!e.shiftKey && e.code === 'KeyO') cmd = 'open';
    else if (!e.shiftKey && e.code === 'KeyS') cmd = 'save';
    else if (e.shiftKey && e.code === 'KeyS') cmd = 'save-as';
    else if (!e.shiftKey && e.code === 'KeyK') cmd = 'link';
    else if (e.code === 'Slash' || e.key === '/') cmd = 'toggle-source';
    if (cmd) {
      e.preventDefault();
      runCommand(cmd);
    }
  });
  // Windows convention: a lone Alt press (and release) focuses the menu bar.
  window.addEventListener('keyup', (e) => {
    if (e.key === 'Alt' && altArmed) {
      e.preventDefault();
      setOpenMenu(openMenuIndex === -1 ? 0 : -1);
    }
    altArmed = false;
  });
  window.addEventListener('blur', () => {
    altArmed = false;
  });
}

// --- Drag & drop to open ---

window.addEventListener('dragover', (e) => e.preventDefault(), true);
window.addEventListener(
  'drop',
  (e) => {
    const file = e.dataTransfer?.files?.[0];
    if (!file) return;
    if (!/\.(md|markdown|mdown|txt)$/i.test(file.name)) return;
    e.preventDefault();
    e.stopPropagation();
    const filePath = quill.pathForFile(file);
    if (filePath) loadFromPath(filePath);
  },
  true
);

// --- Titlebar hairline on scroll ---

els.scroll.addEventListener('scroll', () => {
  els.titlebar.classList.toggle('scrolled', els.scroll.scrollTop > 8);
});

// --- Init ---

(async () => {
  const pending = await quill.getPendingOpen();
  if (pending) loadDocument(pending.content, pending.path);
  else {
    savedMarkdown = getMarkdown();
    syncState();
  }
})();
