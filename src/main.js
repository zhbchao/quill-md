import { Editor, Extension, Node as TiptapNode } from '@tiptap/core';
import { EditorState, Plugin, PluginKey } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';
import katex from 'katex';
import 'katex/dist/katex.min.css';
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
// --- Math ($…$ and $$…$$, rendered with KaTeX) ---

function renderKatex(el, src, displayMode) {
  try {
    katex.render(src || '\\;', el, { throwOnError: false, displayMode });
  } catch {
    el.textContent = src;
  }
}

// markdown-it rules: conservative TeX-style delimiters. `$x$` matches only
// when the content has no surrounding whitespace and the closing `$` is not
// followed by a digit, so "between $5 and $10" stays plain text.
function markdownItMath(md) {
  md.inline.ruler.after('escape', 'math_inline', (state, silent) => {
    const src = state.src;
    const start = state.pos;
    if (src[start] !== '$' || src[start + 1] === '$') return false;
    if (!src[start + 1] || /\s/.test(src[start + 1])) return false;
    let end = start + 1;
    while ((end = src.indexOf('$', end)) !== -1) {
      if (src[end - 1] === '\\') {
        end += 1;
        continue;
      }
      break;
    }
    if (end === -1) return false;
    const content = src.slice(start + 1, end);
    if (!content || /\s$/.test(content) || content.includes('\n')) return false;
    if (src[end + 1] && /\d/.test(src[end + 1])) return false;
    if (!silent) {
      const token = state.push('math_inline', 'span', 0);
      token.content = content;
    }
    state.pos = end + 1;
    return true;
  });

  md.block.ruler.after('fence', 'math_block', (state, startLine, endLine, silent) => {
    const startPos = state.bMarks[startLine] + state.tShift[startLine];
    const first = state.src.slice(startPos, state.eMarks[startLine]);
    if (!first.startsWith('$$')) return false;
    if (silent) return true;
    let line = startLine;
    let content = first.slice(2).trim();
    if (content.endsWith('$$') && content.length >= 4) {
      content = content.slice(0, -2).trim();
    } else {
      const parts = content ? [content] : [];
      for (line = startLine + 1; line < endLine; line++) {
        const text = state.src.slice(
          state.bMarks[line] + state.tShift[line],
          state.eMarks[line]
        );
        if (text.trim() === '$$') break;
        parts.push(text);
      }
      content = parts.join('\n');
    }
    const token = state.push('math_block', 'div', 0);
    token.content = content;
    token.map = [startLine, line + 1];
    state.line = line + 1;
    return true;
  });

  md.renderer.rules.math_inline = (tokens, idx) =>
    `<span data-math-inline="${md.utils.escapeHtml(tokens[idx].content)}"></span>`;
  md.renderer.rules.math_block = (tokens, idx) =>
    `<div data-math-block="${md.utils.escapeHtml(tokens[idx].content)}"></div>`;
}

function mathNodeView(displayMode) {
  return ({ node, getPos, editor: ed }) => {
    const dom = document.createElement(displayMode ? 'div' : 'span');
    dom.className = displayMode ? 'math-block' : 'math-inline';
    let current = node;
    renderKatex(dom, current.attrs.src, displayMode);
    dom.addEventListener('dblclick', () => {
      openMathDialog(current.attrs.src, displayMode, (src) => {
        ed.chain()
          .focus()
          .command(({ tr }) => {
            tr.setNodeMarkup(getPos(), undefined, { src });
            return true;
          })
          .run();
      });
    });
    return {
      dom,
      update: (n) => {
        if (n.type.name !== current.type.name) return false;
        current = n;
        renderKatex(dom, n.attrs.src, displayMode);
        return true;
      },
      // KaTeX owns everything inside this atom node.
      ignoreMutation: () => true,
    };
  };
}

const MathInline = TiptapNode.create({
  name: 'mathInline',
  group: 'inline',
  inline: true,
  atom: true,
  addAttributes() {
    return { src: { default: '' } };
  },
  parseHTML() {
    return [
      {
        tag: 'span[data-math-inline]',
        getAttrs: (el) => ({ src: el.getAttribute('data-math-inline') || '' }),
      },
    ];
  },
  renderHTML({ node }) {
    return ['span', { 'data-math-inline': node.attrs.src }];
  },
  addNodeView() {
    return mathNodeView(false);
  },
  addStorage() {
    return {
      markdown: {
        serialize(state, node) {
          state.write(`$${node.attrs.src}$`);
        },
        parse: {},
      },
    };
  },
});

const MathBlock = TiptapNode.create({
  name: 'mathBlock',
  group: 'block',
  atom: true,
  addAttributes() {
    return { src: { default: '' } };
  },
  parseHTML() {
    return [
      {
        tag: 'div[data-math-block]',
        getAttrs: (el) => ({ src: el.getAttribute('data-math-block') || '' }),
      },
    ];
  },
  renderHTML({ node }) {
    return ['div', { 'data-math-block': node.attrs.src }];
  },
  addNodeView() {
    return mathNodeView(true);
  },
  addStorage() {
    return {
      markdown: {
        serialize(state, node) {
          state.write(`$$\n${node.attrs.src}\n$$`);
          state.closeBlock(node);
        },
        parse: {},
      },
    };
  },
});

// --- Mermaid (rendered live below ```mermaid code blocks) ---

let mermaidMod = null;
let mermaidSeq = 0;

function mermaidTheme() {
  return matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'neutral';
}

async function renderMermaid(el, src) {
  if (!src.trim()) {
    el.textContent = 'Empty diagram';
    el.classList.add('mermaid-error');
    return;
  }
  const id = `mmd-${++mermaidSeq}`;
  try {
    if (!mermaidMod) {
      mermaidMod = (await import('mermaid')).default;
      mermaidMod.initialize({
        startOnLoad: false,
        securityLevel: 'strict',
        theme: mermaidTheme(),
        fontFamily: 'inherit',
      });
    }
    const { svg } = await mermaidMod.render(id, src);
    el.innerHTML = svg;
    el.classList.remove('mermaid-error');
  } catch (err) {
    document.getElementById(`d${id}`)?.remove();
    el.textContent = String((err && err.message) || err).split('\n')[0];
    el.classList.add('mermaid-error');
  }
}

// Re-render diagrams when the system theme flips.
matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
  if (!mermaidMod) return;
  mermaidMod.initialize({
    startOnLoad: false,
    securityLevel: 'strict',
    theme: mermaidTheme(),
    fontFamily: 'inherit',
  });
  for (const wrap of document.querySelectorAll('.mermaid-wrap')) {
    const code = wrap.querySelector('code');
    const preview = wrap.querySelector('.mermaid-preview');
    if (code && preview) renderMermaid(preview, code.textContent);
  }
});

// --- Find & Replace ---

const searchKey = new PluginKey('quillSearch');
const searchState = { query: '', matches: [], active: -1 };

const SearchHighlight = Extension.create({
  name: 'searchHighlight',
  addProseMirrorPlugins() {
    return [
      new Plugin({
        key: searchKey,
        props: {
          decorations(state) {
            if (!searchState.query || !searchState.matches.length) return DecorationSet.empty;
            return DecorationSet.create(
              state.doc,
              searchState.matches.map((m, i) =>
                Decoration.inline(m.from, m.to, {
                  class: i === searchState.active ? 'search-hit search-hit-active' : 'search-hit',
                })
              )
            );
          },
        },
      }),
    ];
  },
});

const QuillKeymap = Extension.create({
  name: 'quillKeymap',
  priority: 1000,
  addKeyboardShortcuts() {
    return {
      'Mod-Shift-x': () => this.editor.commands.toggleStrike(),
      'Mod-Shift-s': () => true,
      'Mod-Alt-t': () =>
        this.editor.commands.insertTable({ rows: 3, cols: 3, withHeaderRow: true }),
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
  findBar: document.getElementById('find-bar'),
  findInput: document.getElementById('find-input'),
  findCount: document.getElementById('find-count'),
  replaceInput: document.getElementById('replace-input'),
  statusMsg: document.getElementById('status-msg'),
  mathOverlay: document.getElementById('math-overlay'),
  mathInput: document.getElementById('math-input'),
  mathPreview: document.getElementById('math-preview'),
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
    CodeBlockLowlight.extend({
      // ```mermaid blocks get a live diagram preview below the code.
      addNodeView() {
        return ({ node }) => {
          const dom = document.createElement('div');
          const pre = document.createElement('pre');
          const code = document.createElement('code');
          pre.appendChild(code);
          dom.appendChild(pre);
          const preview = document.createElement('div');
          preview.className = 'mermaid-preview';
          preview.contentEditable = 'false';
          dom.appendChild(preview);
          let timer = null;
          let lastSrc = null;
          const refresh = (n) => {
            const isMermaid = n.attrs.language === 'mermaid';
            code.className = n.attrs.language ? `language-${n.attrs.language}` : '';
            dom.className = isMermaid ? 'mermaid-wrap' : '';
            preview.style.display = isMermaid ? '' : 'none';
            if (!isMermaid || n.textContent === lastSrc) return;
            lastSrc = n.textContent;
            clearTimeout(timer);
            timer = setTimeout(() => renderMermaid(preview, lastSrc), 300);
          };
          refresh(node);
          return {
            dom,
            contentDOM: code,
            update: (n) => {
              if (n.type.name !== 'codeBlock') return false;
              refresh(n);
              return true;
            },
            // The async SVG swap mutates our own DOM; without this,
            // ProseMirror's DOMObserver redraws the nodeview in a loop.
            ignoreMutation: (m) => m.target === preview || preview.contains(m.target),
          };
        };
      },
    }).configure({ lowlight }),
    Link.configure({
      openOnClick: false,
      autolink: true,
      HTMLAttributes: { rel: null, target: null },
    }),
    // Keep the Markdown-relative src in the document; resolve it against the
    // document's folder only for display.
    Image.extend({
      renderHTML({ HTMLAttributes }) {
        return ['img', { ...HTMLAttributes, src: resolveImageSrc(HTMLAttributes.src) }];
      },
    }),
    MathInline,
    MathBlock,
    Table.configure({ resizable: false }),
    TableRow,
    // Exactly one paragraph per cell: anything richer (a second paragraph from
    // pressing Enter) has no Markdown form, and tiptap-markdown's html:false
    // fallback would replace the whole table with "[table]" in the saved file.
    TableCell.extend({ content: 'paragraph' }),
    TableHeader.extend({ content: 'paragraph' }),
    QuillKeymap,
    SearchHighlight,
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
    handlePaste(view, event) {
      const image = [...(event.clipboardData?.files || [])].find((f) =>
        f.type.startsWith('image/')
      );
      if (image) {
        event.preventDefault();
        void insertImageFile(image);
        return true;
      }
      return false;
    },
    handleDrop(view, event, slice, moved) {
      if (moved) return false;
      const image = [...(event.dataTransfer?.files || [])].find((f) =>
        f.type.startsWith('image/')
      );
      if (image) {
        event.preventDefault();
        const pos = view.posAtCoords({ left: event.clientX, top: event.clientY })?.pos;
        void insertImageFile(image, pos);
        return true;
      }
      return false;
    },
  },
  onUpdate: () => {
    markDirtyNow();
    scheduleStateSync();
    scheduleDraft();
    if (!els.findBar.hidden) {
      computeMatches();
      refreshSearch();
      updateFindCount();
    }
  },
  onSelectionUpdate: () => updateBubbleState(),
});

// tiptap-markdown parses via markdown-it; teach it the math delimiters.
markdownItMath(editor.storage.markdown.parser.md);

const getMarkdown = () => editor.storage.markdown.getMarkdown();

// YAML front matter has no ProseMirror form — hold it aside verbatim and
// re-prepend on save, so metadata survives the round-trip untouched.
let docFrontMatter = '';

function splitFrontMatter(markdown) {
  const m = /^---\r?\n[\s\S]*?\r?\n---\r?\n?/.exec(markdown);
  return m ? { front: m[0], body: markdown.slice(m[0].length) } : { front: '', body: markdown };
}

function currentMarkdown() {
  return sourceMode ? els.source.value : docFrontMatter + getMarkdown();
}

// Resolve a Markdown-relative image path against the open document's folder
// for display. Handled with string ops: no node modules in the renderer.
function resolveImageSrc(src) {
  if (!src || /^[a-z][a-z0-9+.-]*:/i.test(src)) return src; // http:, data:, file:…
  if (!currentPath) return src;
  const sep = currentPath.includes('\\') ? '\\' : '/';
  const dir = currentPath.slice(0, currentPath.lastIndexOf(sep));
  const rel = sep === '\\' ? src.replace(/\//g, '\\') : src;
  const full = src.startsWith('/') ? src : dir + sep + rel;
  const posix = full.replace(/\\/g, '/');
  return encodeURI('file://' + (posix.startsWith('/') ? '' : '/') + posix)
    .replace(/#/g, '%23')
    .replace(/\?/g, '%3F');
}

async function insertImageFile(file, pos) {
  if (!currentPath) {
    flashStatus('Save the document first to add images');
    return;
  }
  const ext = (file.type.split('/')[1] || 'png').replace('jpeg', 'jpg');
  const bytes = new Uint8Array(await file.arrayBuffer());
  const result = await quill.saveImage(currentPath, ext, bytes);
  if (!result) return;
  const image = { type: 'image', attrs: { src: result.relPath } };
  if (typeof pos === 'number') editor.chain().focus().insertContentAt(pos, image).run();
  else editor.chain().focus().insertContent(image).run();
}

// Replace content and reset undo history so a freshly opened
// document can't be "undone" back into the previous one.
function loadDocument(markdown, filePath, keepDraft = false) {
  currentPath = filePath || null; // set first: image srcs resolve against it
  const { front, body } = splitFrontMatter(markdown);
  docFrontMatter = front;
  editor.commands.setContent(body, false);
  const { state, view } = editor;
  view.updateState(
    EditorState.create({ doc: state.doc, plugins: state.plugins, schema: state.schema })
  );
  if (sourceMode) els.source.value = docFrontMatter + getMarkdown();
  savedMarkdown = currentMarkdown();
  if (!keepDraft) quill.updateDraft({ dirty: false });
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

// --- Status flash (transient, quiet) ---

let statusTimer = null;
function flashStatus(text, ms = 4000) {
  els.statusMsg.textContent = text;
  els.statusMsg.hidden = false;
  clearTimeout(statusTimer);
  statusTimer = setTimeout(() => {
    els.statusMsg.hidden = true;
  }, ms);
}

// --- Find & Replace UI ---

function refreshSearch() {
  editor.view.dispatch(editor.state.tr.setMeta(searchKey, true));
}

function computeMatches() {
  const q = searchState.query.toLowerCase();
  const matches = [];
  if (q) {
    editor.state.doc.descendants((node, pos) => {
      if (!node.isTextblock) return true;
      const text = node.textBetween(0, node.content.size, '￼').toLowerCase();
      let i = 0;
      while ((i = text.indexOf(q, i)) !== -1) {
        matches.push({ from: pos + 1 + i, to: pos + 1 + i + q.length });
        i += q.length; // non-overlapping: overlaps would corrupt replace-all
      }
      return false;
    });
  }
  searchState.matches = matches;
  if (!matches.length) searchState.active = -1;
  else if (searchState.active < 0 || searchState.active >= matches.length) searchState.active = 0;
}

function updateFindCount() {
  els.findCount.textContent = searchState.matches.length
    ? `${searchState.active + 1} of ${searchState.matches.length}`
    : els.findInput.value
      ? 'Not found'
      : '';
}

function scrollToActive() {
  const m = searchState.matches[searchState.active];
  if (!m) return;
  try {
    const coords = editor.view.coordsAtPos(m.from);
    els.scroll.scrollTop += coords.top - els.scroll.clientHeight / 2;
  } catch {
    /* position vanished mid-edit */
  }
}

function updateFind(scroll = true) {
  searchState.query = els.findInput.value;
  computeMatches();
  refreshSearch();
  updateFindCount();
  if (scroll) scrollToActive();
}

function openFind(withReplace) {
  if (sourceMode) toggleSource();
  const wasHidden = els.findBar.hidden;
  els.findBar.hidden = false;
  els.findBar.classList.toggle('with-replace', Boolean(withReplace));
  const { from, to } = editor.state.selection;
  const selected = editor.state.doc.textBetween(from, to, ' ');
  if (selected && selected.length < 100) els.findInput.value = selected;
  els.findInput.focus();
  els.findInput.select();
  if (!wasHidden || els.findInput.value) updateFind();
}

function closeFind() {
  if (els.findBar.hidden) return;
  els.findBar.hidden = true;
  searchState.query = '';
  computeMatches();
  refreshSearch();
  editor.commands.focus();
}

function findStep(dir) {
  const n = searchState.matches.length;
  if (!n) return;
  searchState.active = (searchState.active + dir + n) % n;
  refreshSearch();
  updateFindCount();
  scrollToActive();
}

function replaceActive() {
  const m = searchState.matches[searchState.active];
  if (!m) return;
  const replacement = els.replaceInput.value;
  editor
    .chain()
    .command(({ tr }) => {
      tr.insertText(replacement, m.from, m.to);
      return true;
    })
    .run();
  updateFind();
}

function replaceAll() {
  if (!searchState.matches.length) return;
  const replacement = els.replaceInput.value;
  const count = searchState.matches.length;
  editor
    .chain()
    .command(({ tr }) => {
      for (let i = searchState.matches.length - 1; i >= 0; i--) {
        const m = searchState.matches[i];
        tr.insertText(replacement, m.from, m.to);
      }
      return true;
    })
    .run();
  updateFind();
  flashStatus(`Replaced ${count} ${count === 1 ? 'occurrence' : 'occurrences'}`);
}

els.findInput.addEventListener('input', () => updateFind());
els.findInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    e.preventDefault();
    findStep(e.shiftKey ? -1 : 1);
  } else if (e.key === 'Escape') {
    e.preventDefault();
    closeFind();
  }
});
els.replaceInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    e.preventDefault();
    replaceActive();
  } else if (e.key === 'Escape') {
    e.preventDefault();
    closeFind();
  }
});
document.getElementById('find-next').addEventListener('click', () => findStep(1));
document.getElementById('find-prev').addEventListener('click', () => findStep(-1));
document.getElementById('find-close').addEventListener('click', closeFind);
document.getElementById('find-toggle-replace').addEventListener('click', () => {
  els.findBar.classList.toggle('with-replace');
  if (els.findBar.classList.contains('with-replace')) els.replaceInput.focus();
});
document.getElementById('replace-one').addEventListener('click', replaceActive);
document.getElementById('replace-all').addEventListener('click', replaceAll);

window.__openFind = (q) => {
  openFind(false);
  els.findInput.value = q;
  updateFind();
};

// --- Math dialog ---

let mathDialogApply = null;

function openMathDialog(initial, displayMode, onApply) {
  els.mathInput.value = initial || '';
  mathDialogApply = onApply;
  els.mathOverlay.hidden = false;
  renderKatex(els.mathPreview, els.mathInput.value, displayMode);
  els.mathPreview.dataset.display = displayMode ? '1' : '';
  els.mathInput.focus();
  els.mathInput.select();
}

function closeMathDialog(apply) {
  if (els.mathOverlay.hidden) return;
  els.mathOverlay.hidden = true;
  const src = els.mathInput.value.trim();
  const cb = mathDialogApply;
  mathDialogApply = null;
  if (apply && cb && src) cb(src);
  else editor.commands.focus();
}

els.mathInput.addEventListener('input', () => {
  renderKatex(els.mathPreview, els.mathInput.value, Boolean(els.mathPreview.dataset.display));
});
els.mathInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    closeMathDialog(true);
  } else if (e.key === 'Escape') {
    e.preventDefault();
    closeMathDialog(false);
  }
});
els.mathOverlay.addEventListener('mousedown', (e) => {
  if (e.target === els.mathOverlay) closeMathDialog(false);
});

function insertMath(displayMode) {
  if (sourceMode) return;
  openMathDialog('', displayMode, (src) => {
    editor
      .chain()
      .focus()
      .insertContent({ type: displayMode ? 'mathBlock' : 'mathInline', attrs: { src } })
      .run();
  });
}

// --- Export ---

function docTitle() {
  return currentPath ? basename(currentPath).replace(/\.[^.]+$/, '') : 'Untitled';
}

async function doExportPdf() {
  if (sourceMode) toggleSource();
  closeFind();
  const result = await quill.exportPdf(`${docTitle()}.pdf`);
  if (result) flashStatus(`Exported ${basename(result.path)}`);
}

async function doExportHtml() {
  if (sourceMode) toggleSource();
  closeFind();
  const body = els.editor
    .querySelector('.ProseMirror')
    .innerHTML.replace(/ contenteditable="[^"]*"/g, '')
    .replace(/ draggable="[^"]*"/g, '');
  const css = [...document.styleSheets]
    .flatMap((sheet) => {
      try {
        return [...sheet.cssRules].map((rule) => rule.cssText);
      } catch {
        return [];
      }
    })
    .join('\n');
  const html = [
    '<!doctype html>',
    '<html><head><meta charset="utf-8">',
    `<title>${docTitle().replace(/</g, '&lt;')}</title>`,
    `<style>${css}</style>`,
    '<style>body{height:auto;overflow:auto;max-width:768px;margin:3rem auto;padding:0 32px}.ProseMirror{outline:none}</style>',
    '</head><body>',
    `<div class="ProseMirror content">${body}</div>`,
    '</body></html>',
  ].join('\n');
  const result = await quill.exportHtml(`${docTitle()}.html`, html);
  if (result) flashStatus(`Exported ${basename(result.path)}`);
}

// --- Crash-recovery draft (debounced mirror of the working copy) ---

let draftTimer = null;
function scheduleDraft() {
  clearTimeout(draftTimer);
  draftTimer = setTimeout(() => {
    quill.updateDraft({ path: currentPath, markdown: currentMarkdown(), dirty: isDirty() });
  }, 800);
}

// --- Source mode ---

function autosizeSource() {
  if (!sourceMode) return;
  els.source.style.height = 'auto';
  els.source.style.height = `${els.source.scrollHeight}px`;
}

function toggleSource() {
  closeLinkDialog(false);
  if (!sourceMode) {
    closeFind();
    els.source.value = docFrontMatter + getMarkdown();
    els.editor.hidden = true;
    els.source.hidden = false;
    sourceMode = true;
    autosizeSource();
    els.source.focus();
  } else {
    const { front, body } = splitFrontMatter(els.source.value);
    sourceMode = false;
    docFrontMatter = front;
    els.source.hidden = true;
    els.editor.hidden = false;
    editor.commands.setContent(body, false);
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
  scheduleDraft();
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
  clearTimeout(draftTimer);
  quill.updateDraft({ dirty: false });
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
    case 'find-open': return openFind(false);
    case 'find-replace': return openFind(true);
    case 'find-next': return findStep(1);
    case 'find-prev': return findStep(-1);
    case 'export-pdf': return void doExportPdf();
    case 'export-html': return void doExportHtml();
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
    case 'tableInsert':
      return chain().insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run();
    case 'tableRowAbove': return chain().addRowBefore().run();
    case 'tableRowBelow': return chain().addRowAfter().run();
    case 'tableRowDelete': return chain().deleteRow().run();
    case 'tableColBefore': return chain().addColumnBefore().run();
    case 'tableColAfter': return chain().addColumnAfter().run();
    case 'tableColDelete': return chain().deleteColumn().run();
    case 'tableDelete': return chain().deleteTable().run();
    case 'mathInsert': return insertMath(false);
    case 'mathBlockInsert': return insertMath(true);
    case 'mermaidInsert':
      return chain()
        .insertContent({
          type: 'codeBlock',
          attrs: { language: 'mermaid' },
          content: [
            {
              type: 'text',
              text: 'graph TD\n  A[Start] --> B{Choice}\n  B -->|yes| C[Ship it]\n  B -->|no| D[Iterate]',
            },
          ],
        })
        .run();
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
    // Table creation must produce valid Markdown (never the [table] fallback).
    editor.commands.setContent('', false);
    editor.commands.insertTable({ rows: 2, cols: 2, withHeaderRow: true });
    const tableOut = getMarkdown();
    const tableInsert = tableOut.includes('| --- | --- |') && !tableOut.includes('[table]');
    // Front matter, math, mermaid, and relative images round-trip intact.
    loadDocument(
      [
        '---',
        'title: t',
        '---',
        '',
        '# Body',
        '',
        '![alt](assets/pic.png)',
        '',
        'Inline $e=mc^2$ math.',
        '',
        '$$\\int_0^1 x dx$$',
        '',
        '```mermaid',
        'graph TD',
        '  A --> B',
        '```',
      ].join('\n'),
      '/tmp/quill-selftest/doc.md'
    );
    const richOut = currentMarkdown();
    const fmOk = richOut.startsWith('---\ntitle: t\n---\n') && richOut.includes('# Body');
    const mathOk =
      richOut.includes('$e=mc^2$') &&
      richOut.includes('$$\n\\int_0^1 x dx\n$$') &&
      Boolean(els.editor.querySelector('.katex'));
    const mermaidOk =
      richOut.includes('```mermaid') && Boolean(els.editor.querySelector('.mermaid-preview'));
    const img = els.editor.querySelector('img');
    const imageOk =
      Boolean(img) && img.getAttribute('src') === 'file:///tmp/quill-selftest/assets/pic.png';
    window.__openFind('body');
    const findOk = searchState.matches.length === 1;
    closeFind();
    loadDocument('', null);
    const ok = Boolean(
      roundTrip && dom && tableInsert && fmOk && mathOk && mermaidOk && imageOk && findOk
    );
    quill.smokeResult(
      ok,
      ok
        ? ''
        : `roundTrip=${roundTrip} dom=${Boolean(dom)} tableInsert=${tableInsert} ` +
            `fm=${fmOk} math=${mathOk} mermaid=${mermaidOk} image=${imageOk} find=${findOk} ` +
            `rich=${JSON.stringify(richOut)}`
    );
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
      { recents: true },
      { sep: true },
      { label: 'Save', cmd: 'save', keys: 'Ctrl+S' },
      { label: 'Save As…', cmd: 'save-as', keys: 'Ctrl+Shift+S' },
      { sep: true },
      { label: 'Export as PDF…', cmd: 'export-pdf' },
      { label: 'Export as HTML…', cmd: 'export-html' },
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
      { label: 'Find…', cmd: 'find-open', keys: 'Ctrl+F' },
      { label: 'Find Next', cmd: 'find-next', keys: 'Ctrl+G' },
      { label: 'Find Previous', cmd: 'find-prev', keys: 'Ctrl+Shift+G' },
      { label: 'Find and Replace…', cmd: 'find-replace', keys: 'Ctrl+Alt+F' },
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
      { sep: true },
      { label: 'Math…', cmd: 'mathInsert', keys: 'Ctrl+Alt+M' },
      { label: 'Math Block…', cmd: 'mathBlockInsert' },
      { label: 'Mermaid Diagram', cmd: 'mermaidInsert' },
    ],
  },
  {
    label: 'Table',
    items: [
      { label: 'Insert Table', cmd: 'tableInsert', keys: 'Ctrl+Alt+T', when: 'notInTable' },
      { sep: true },
      { label: 'Add Row Above', cmd: 'tableRowAbove', when: 'inTable' },
      { label: 'Add Row Below', cmd: 'tableRowBelow', when: 'inTable' },
      { label: 'Delete Row', cmd: 'tableRowDelete', when: 'inTable' },
      { sep: true },
      { label: 'Add Column Before', cmd: 'tableColBefore', when: 'inTable' },
      { label: 'Add Column After', cmd: 'tableColAfter', when: 'inTable' },
      { label: 'Delete Column', cmd: 'tableColDelete', when: 'inTable' },
      { sep: true },
      { label: 'Delete Table', cmd: 'tableDelete', when: 'inTable' },
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

function updateMenuDisabled(wrap) {
  const inTable = !sourceMode && editor.isActive('table');
  for (const row of wrap.querySelectorAll('.menu-item[data-when]')) {
    const ok = row.dataset.when === 'inTable' ? inTable : !sourceMode && !inTable;
    row.classList.toggle('disabled', !ok);
  }
}

async function populateRecents(container) {
  const recents = await quill.getRecents();
  container.textContent = '';
  const addRow = (label, title, onClick) => {
    const row = document.createElement('button');
    row.className = 'menu-item';
    row.tabIndex = -1;
    if (title) row.title = title;
    const name = document.createElement('span');
    name.textContent = label;
    row.appendChild(name);
    row.addEventListener('mousedown', (e) => e.preventDefault());
    row.addEventListener('mouseenter', () => row.focus());
    row.addEventListener('click', () => {
      closeMenus();
      onClick();
    });
    container.appendChild(row);
    return row;
  };
  if (!recents.length) return;
  const sep = document.createElement('div');
  sep.className = 'menu-sep';
  container.appendChild(sep);
  for (const p of recents.slice(0, 8)) {
    addRow(basename(p), p, () => loadFromPath(p));
  }
  const clear = addRow('Clear Recent Files', '', () => {
    quill.clearRecents();
  });
  clear.classList.add('menu-item-secondary');
}

function setOpenMenu(index) {
  openMenuIndex = index;
  [...menubarEl.children].forEach((wrap, i) => {
    wrap.classList.toggle('open', i === index);
    if (i === index) {
      updateMenuDisabled(wrap);
      const recents = wrap.querySelector('.menu-recents');
      if (recents) void populateRecents(recents);
    }
  });
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
      if (item.recents) {
        const container = document.createElement('div');
        container.className = 'menu-recents';
        drop.appendChild(container);
        continue;
      }
      const row = document.createElement('button');
      row.className = 'menu-item';
      row.tabIndex = -1;
      if (item.when) row.dataset.when = item.when;
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
      const items = [
        ...menubarEl.children[openMenuIndex].querySelectorAll('.menu-item:not(.disabled)'),
      ];
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
    if (e.ctrlKey && e.altKey && !e.metaKey && e.code === 'KeyF') {
      e.preventDefault();
      runCommand('find-replace');
      return;
    }
    if (!e.ctrlKey || e.altKey || e.metaKey) return;
    let cmd = null;
    if (!e.shiftKey && e.code === 'KeyN') cmd = 'new';
    else if (!e.shiftKey && e.code === 'KeyO') cmd = 'open';
    else if (!e.shiftKey && e.code === 'KeyS') cmd = 'save';
    else if (e.shiftKey && e.code === 'KeyS') cmd = 'save-as';
    else if (!e.shiftKey && e.code === 'KeyK') cmd = 'link';
    else if (!e.shiftKey && e.code === 'KeyF') cmd = 'find-open';
    else if (e.code === 'KeyG') cmd = e.shiftKey ? 'find-prev' : 'find-next';
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
  const { file, draft } = (await quill.getPendingOpen()) || {};
  const draftMatches = Boolean(draft) && (draft.path || null) === (file ? file.path : null);
  if (file) loadDocument(file.content, file.path, draftMatches);
  else {
    savedMarkdown = currentMarkdown();
    syncState();
  }
  if (draftMatches && draft.markdown !== currentMarkdown()) {
    // The last session ended (or crashed) with unsaved changes — restore them
    // on top of the on-disk baseline, leaving the document marked Edited.
    const { front, body } = splitFrontMatter(draft.markdown);
    docFrontMatter = front;
    editor.commands.setContent(body, false);
    markDirtyNow();
    syncState();
    scheduleDraft();
    flashStatus('Recovered unsaved changes');
  } else if (draft && !draftMatches) {
    quill.updateDraft({ dirty: false }); // stale draft for a different document
  }
})();
