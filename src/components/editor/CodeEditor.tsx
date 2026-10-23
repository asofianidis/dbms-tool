import { forwardRef, useEffect, useImperativeHandle, useRef } from 'react'
import {
  autocompletion,
  closeBrackets,
  closeBracketsKeymap,
  completionKeymap,
  type CompletionSource
} from '@codemirror/autocomplete'
import {
  defaultKeymap,
  history,
  historyKeymap,
  indentWithTab,
  toggleComment
} from '@codemirror/commands'
import { javascript } from '@codemirror/lang-javascript'
import { json } from '@codemirror/lang-json'
import { MSSQL, MySQL, PostgreSQL, sql, type SQLNamespace, SQLite } from '@codemirror/lang-sql'
import {
  bracketMatching,
  foldGutter,
  foldKeymap,
  HighlightStyle,
  indentOnInput,
  syntaxHighlighting
} from '@codemirror/language'
import { lintGutter, setDiagnostics, type Diagnostic } from '@codemirror/lint'
import { highlightSelectionMatches, search, searchKeymap } from '@codemirror/search'
import { Compartment, EditorState, Prec, type Extension } from '@codemirror/state'
import {
  crosshairCursor,
  drawSelection,
  dropCursor,
  EditorView,
  highlightActiveLine,
  highlightActiveLineGutter,
  highlightSpecialChars,
  keymap,
  lineNumbers,
  placeholder as placeholderExt,
  rectangularSelection,
  type KeyBinding
} from '@codemirror/view'
import { tags as t } from '@lezer/highlight'
import type { Dialect } from '@/lib/engines'

export type EditorLanguage =
  { kind: 'sql'; dialect: Dialect } | { kind: 'mongo' } | { kind: 'json' } | { kind: 'text' }

export interface CodeEditorHandle {
  view: () => EditorView | null
  text: () => string
  /** Selected text, or null when the selection is empty */
  selection: () => { text: string; from: number; to: number } | null
  cursor: () => number
  focus: () => void
  setText: (text: string) => void
  replaceRange: (from: number, to: number, text: string) => void
  showError: (from: number, to: number, message: string) => void
  clearErrors: () => void
}

interface Props {
  value: string
  onChange?: (value: string) => void
  language: EditorLanguage
  /** SQL completion schema or Mongo collection names */
  completion?: SQLNamespace
  defaultSchema?: string
  extraCompletion?: CompletionSource
  keys?: KeyBinding[]
  fontSize?: number
  wordWrap?: boolean
  readOnly?: boolean
  lineNumbers?: boolean
  placeholder?: string
  className?: string
  autoFocus?: boolean
  onCursor?: (info: { line: number; col: number; selected: number }) => void
}

const highlight = HighlightStyle.define([
  {
    tag: [t.keyword, t.operatorKeyword, t.modifier, t.controlKeyword],
    color: 'var(--color-syn-keyword)'
  },
  { tag: [t.string, t.special(t.string), t.regexp], color: 'var(--color-syn-string)' },
  { tag: [t.number, t.bool, t.null, t.atom], color: 'var(--color-syn-number)' },
  {
    tag: [t.comment, t.lineComment, t.blockComment],
    color: 'var(--color-syn-comment)',
    fontStyle: 'italic'
  },
  { tag: [t.typeName, t.className, t.standard(t.name)], color: 'var(--color-syn-type)' },
  { tag: [t.function(t.variableName), t.function(t.propertyName)], color: 'var(--color-syn-fn)' },
  { tag: [t.propertyName, t.special(t.name)], color: 'var(--color-syn-prop)' },
  { tag: [t.operator, t.punctuation, t.bracket, t.separator], color: 'var(--color-syn-operator)' },
  { tag: [t.variableName, t.name], color: 'var(--color-fg)' },
  { tag: t.special(t.variableName), color: 'var(--color-syn-number)' },
  { tag: t.invalid, color: 'var(--color-danger)' }
])

const theme = EditorView.theme(
  {
    '&': { color: 'var(--color-fg)', backgroundColor: 'transparent' },
    '.cm-content': {
      fontFamily: 'var(--font-mono)',
      caretColor: 'var(--color-accent)',
      padding: '8px 0'
    },
    '.cm-scroller': { fontFamily: 'var(--font-mono)', lineHeight: '1.6' },
    '.cm-cursor, .cm-dropCursor': {
      borderLeftColor: 'var(--color-accent)',
      borderLeftWidth: '2px'
    },
    '&.cm-focused .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection': {
      backgroundColor: 'color-mix(in srgb, var(--color-accent) 22%, transparent) !important'
    },
    '.cm-activeLine': {
      backgroundColor: 'color-mix(in srgb, var(--color-bright) 3%, transparent)'
    },
    '.cm-gutters': {
      backgroundColor: 'transparent',
      color: 'var(--color-faint)',
      border: 'none',
      paddingLeft: '4px'
    },
    '.cm-activeLineGutter': { backgroundColor: 'transparent', color: 'var(--color-muted)' },
    '.cm-lineNumbers .cm-gutterElement': { padding: '0 10px 0 6px', minWidth: '32px' },
    '.cm-foldGutter .cm-gutterElement': { color: 'var(--color-faint)', padding: '0 2px' },
    '.cm-matchingBracket': {
      backgroundColor: 'color-mix(in srgb, var(--color-accent) 18%, transparent)',
      outline: 'none'
    },
    '.cm-selectionMatch': {
      backgroundColor: 'color-mix(in srgb, var(--color-bright) 9%, transparent)'
    },
    '.cm-searchMatch': {
      backgroundColor: 'rgb(242 184 75 / 0.25)',
      outline: '1px solid rgb(242 184 75 / 0.5)'
    },
    '.cm-searchMatch.cm-searchMatch-selected': { backgroundColor: 'rgb(242 184 75 / 0.45)' },
    '.cm-placeholder': { color: 'var(--color-faint)' },
    '.cm-tooltip': {
      backgroundColor: 'var(--color-raised)',
      border: '1px solid var(--color-line-strong)',
      borderRadius: '8px',
      boxShadow: '0 16px 40px var(--shadow)',
      overflow: 'hidden'
    },
    '.cm-tooltip-autocomplete > ul': {
      fontFamily: 'var(--font-mono)',
      fontSize: '12px',
      maxHeight: '18em'
    },
    '.cm-tooltip-autocomplete > ul > li': { padding: '2px 10px 2px 6px !important' },
    '.cm-completionDetail': {
      color: 'var(--color-faint)',
      fontStyle: 'normal',
      marginLeft: '12px'
    },
    '.cm-completionMatchedText': { color: 'var(--color-accent)', textDecoration: 'none' },
    '.cm-panels': { backgroundColor: 'var(--color-panel)', color: 'var(--color-fg)' },
    '.cm-panels-bottom': { borderTop: '1px solid var(--color-line)' },
    '.cm-panels-top': { borderBottom: '1px solid var(--color-line)' },
    '.cm-search': { fontFamily: 'var(--font-sans)', fontSize: '12px', padding: '6px 8px' },
    '.cm-search input, .cm-search button': {
      backgroundColor: 'var(--color-canvas)',
      border: '1px solid var(--color-line-strong)',
      borderRadius: '5px',
      color: 'var(--color-bright)',
      backgroundImage: 'none',
      padding: '2px 8px'
    },
    '.cm-search label': { color: 'var(--color-muted)' },
    '.cm-diagnostic-error': { borderLeftColor: 'var(--color-danger)' },
    '.cm-lintRange-error': {
      backgroundImage: 'none',
      textDecoration: 'underline wavy var(--color-danger)',
      textUnderlineOffset: '3px'
    },
    '.cm-lint-marker-error': { content: 'none' },
    '.cm-foldPlaceholder': {
      backgroundColor: 'var(--color-hover)',
      border: 'none',
      color: 'var(--color-muted)',
      padding: '0 6px'
    }
  },
  { dark: true }
)

const DIALECTS = { postgres: PostgreSQL, mysql: MySQL, tsql: MSSQL, sqlite: SQLite }

function languageExtension(
  language: EditorLanguage,
  completion: SQLNamespace | undefined,
  defaultSchema: string | undefined,
  extra: CompletionSource | undefined
): Extension {
  if (language.kind === 'sql') {
    const ext = sql({
      dialect: DIALECTS[language.dialect],
      schema: completion,
      defaultSchema,
      upperCaseKeywords: true
    })
    return extra ? [ext, ext.language.data.of({ autocomplete: extra })] : ext
  }
  if (language.kind === 'json') return json()
  if (language.kind === 'text') return []
  const js = javascript()
  return extra ? [js, js.language.data.of({ autocomplete: extra })] : js
}

export const CodeEditor = forwardRef<CodeEditorHandle, Props>(function CodeEditor(
  {
    value,
    onChange,
    language,
    completion,
    defaultSchema,
    extraCompletion,
    keys,
    fontSize = 13,
    wordWrap = false,
    readOnly = false,
    lineNumbers: showLineNumbers = true,
    placeholder,
    className,
    autoFocus,
    onCursor
  },
  ref
) {
  const host = useRef<HTMLDivElement>(null)
  const viewRef = useRef<EditorView | null>(null)
  const langCompartment = useRef(new Compartment())
  const keysCompartment = useRef(new Compartment())
  const optsCompartment = useRef(new Compartment())
  const onChangeRef = useRef(onChange)
  const onCursorRef = useRef(onCursor)
  onChangeRef.current = onChange
  onCursorRef.current = onCursor

  useEffect(() => {
    if (!host.current) return
    const view = new EditorView({
      parent: host.current,
      state: EditorState.create({
        doc: value,
        extensions: [
          showLineNumbers ? [lineNumbers(), foldGutter(), highlightActiveLineGutter()] : [],
          highlightSpecialChars(),
          history(),
          drawSelection(),
          dropCursor(),
          EditorState.allowMultipleSelections.of(true),
          indentOnInput(),
          bracketMatching(),
          closeBrackets(),
          autocompletion({ activateOnTyping: true, icons: true }),
          rectangularSelection(),
          crosshairCursor(),
          highlightActiveLine(),
          highlightSelectionMatches(),
          search({ top: true }),
          lintGutter(),
          syntaxHighlighting(highlight),
          theme,
          placeholder ? placeholderExt(placeholder) : [],
          keysCompartment.current.of(Prec.highest(keymap.of(keys ?? []))),
          keymap.of([
            ...closeBracketsKeymap,
            ...defaultKeymap,
            ...searchKeymap,
            ...historyKeymap,
            ...foldKeymap,
            ...completionKeymap,
            { key: 'Mod-/', run: toggleComment },
            indentWithTab
          ]),
          langCompartment.current.of(
            languageExtension(language, completion, defaultSchema, extraCompletion)
          ),
          optsCompartment.current.of([
            EditorView.editable.of(!readOnly),
            EditorState.readOnly.of(readOnly),
            wordWrap ? EditorView.lineWrapping : [],
            EditorView.theme({ '&': { fontSize: `${fontSize}px` } })
          ]),
          EditorView.updateListener.of((update) => {
            if (update.docChanged) {
              onChangeRef.current?.(update.state.doc.toString())
              // Edits invalidate the error underline
              update.view.dispatch(setDiagnostics(update.state, []))
            }
            if (update.selectionSet || update.docChanged || update.focusChanged) {
              const sel = update.state.selection.main
              const line = update.state.doc.lineAt(sel.head)
              onCursorRef.current?.({
                line: line.number,
                col: sel.head - line.from + 1,
                selected: Math.abs(sel.to - sel.from)
              })
            }
          })
        ]
      })
    })
    viewRef.current = view
    if (autoFocus) view.focus()
    return () => {
      view.destroy()
      viewRef.current = null
    }
    // The editor is created once; props below are pushed through compartments
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    viewRef.current?.dispatch({
      effects: langCompartment.current.reconfigure(
        languageExtension(language, completion, defaultSchema, extraCompletion)
      )
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    language.kind,
    language.kind === 'sql' ? language.dialect : '',
    completion,
    defaultSchema,
    extraCompletion
  ])

  useEffect(() => {
    viewRef.current?.dispatch({
      effects: keysCompartment.current.reconfigure(Prec.highest(keymap.of(keys ?? [])))
    })
  }, [keys])

  useEffect(() => {
    viewRef.current?.dispatch({
      effects: optsCompartment.current.reconfigure([
        EditorView.editable.of(!readOnly),
        EditorState.readOnly.of(readOnly),
        wordWrap ? EditorView.lineWrapping : [],
        EditorView.theme({ '&': { fontSize: `${fontSize}px` } })
      ])
    })
  }, [readOnly, wordWrap, fontSize])

  // Accept external value changes (file open, format) without clobbering local typing
  useEffect(() => {
    const view = viewRef.current
    if (view && view.state.doc.toString() !== value) {
      view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: value } })
    }
  }, [value])

  useImperativeHandle(ref, () => ({
    view: () => viewRef.current,
    text: () => viewRef.current?.state.doc.toString() ?? '',
    selection: () => {
      const view = viewRef.current
      if (!view) return null
      const { from, to } = view.state.selection.main
      if (from === to) return null
      return { text: view.state.sliceDoc(from, to), from, to }
    },
    cursor: () => viewRef.current?.state.selection.main.head ?? 0,
    focus: () => viewRef.current?.focus(),
    setText: (text) => {
      const view = viewRef.current
      if (view) view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: text } })
    },
    replaceRange: (from, to, text) => {
      viewRef.current?.dispatch({ changes: { from, to, insert: text } })
    },
    showError: (from, to, message) => {
      const view = viewRef.current
      if (!view) return
      const len = view.state.doc.length
      const a = Math.max(0, Math.min(from, len))
      const b = Math.max(a, Math.min(to, len))
      const diagnostics: Diagnostic[] = [
        { from: a, to: b === a ? Math.min(len, a + 1) : b, severity: 'error', message }
      ]
      view.dispatch(setDiagnostics(view.state, diagnostics))
      view.dispatch({ selection: { anchor: a }, scrollIntoView: true })
    },
    clearErrors: () => {
      const view = viewRef.current
      if (view) view.dispatch(setDiagnostics(view.state, []))
    }
  }))

  return <div ref={host} className={className} />
})
