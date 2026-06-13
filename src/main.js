import { Editor } from '@tiptap/core';
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
    TableCell,
    TableHeader,
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
  onUpdate: () => scheduleStateSync(),
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

function scheduleStateSync() {
  clearTimeout(dirtyTimer);
  dirtyTimer = setTimeout(syncState, 200);
}

function syncState() {
  const dirty = isDirty();
  els.docEdited.hidden = !dirty;
  els.docName.textContent = currentPath ? basename(currentPath) : 'Untitled';
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
  autosizeSource();
  scheduleStateSync();
});

// --- File operations ---

async function doSave(saveAs = false) {
  const markdown = currentMarkdown();
  const result = await quill.save(saveAs ? null : currentPath, markdown);
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
    loadDocument(file.content, file.path);
  } catch {
    /* unreadable file: ignore */
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
    ].join('\n');
    editor.commands.setContent(sample, false);
    const out = getMarkdown();
    const roundTrip =
      out.includes('# Title') &&
      out.includes('**bold**') &&
      out.includes('- [ ] open task') &&
      out.includes('- [x] done task') &&
      out.includes('> a quote') &&
      out.includes('```js');
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
