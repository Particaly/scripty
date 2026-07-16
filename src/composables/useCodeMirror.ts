import { EditorState, Compartment } from '@codemirror/state'
import { EditorView, keymap, lineNumbers, highlightActiveLine, highlightActiveLineGutter } from '@codemirror/view'
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands'
import { bracketMatching, indentOnInput } from '@codemirror/language'
import { javascript } from '@codemirror/lang-javascript'
import { python } from '@codemirror/lang-python'
import { StreamLanguage } from '@codemirror/language'
import { shell } from '@codemirror/legacy-modes/mode/shell'
import { powerShell } from '@codemirror/legacy-modes/mode/powershell'
import { cmTheme } from './cmTheme'
import { cmAutocomplete } from './cmCompletion'
import type { ScriptLanguage } from '../types/domain'

/**
 * Returns the CodeMirror language extension for a Scripty language. JavaScript
 * and Python ship first-class Lezer grammars; PowerShell and shell reuse the
 * CodeMirror 5 stream parsers wrapped via StreamLanguage (no official CM6 package
 * exists for them yet).
 */
function languageExtension(language: ScriptLanguage) {
  switch (language) {
    case 'javascript':
      return javascript()
    case 'python':
      return python()
    case 'powershell':
      return StreamLanguage.define(powerShell)
    case 'shell':
      return StreamLanguage.define(shell)
    default:
      return javascript()
  }
}

export interface CreateEditorOptions {
  /** Initial document text. */
  doc: string
  /** Scripty language driving syntax highlighting + completion. */
  language: ScriptLanguage
  /** Called with the latest document whenever the user edits it. */
  onChange: (doc: string) => void
  /** Called when the user presses the platform save shortcut (Ctrl/Cmd+S). */
  onSave: () => void
}

export interface CodeMirrorHandle {
  /** The underlying EditorView; null after destroy. */
  view: EditorView
  /** Reconfigures syntax highlighting + completion to match a new language. */
  setLanguage: (language: ScriptLanguage) => void
  /** Replaces the whole document. Does not move the scroll position. */
  setDoc: (doc: string) => void
  /** Tears down the editor and releases DOM listeners. */
  destroy: () => void
}

/**
 * Creates a CodeMirror 6 editor mounted into `parent`. The editor is fully owned
 * by the caller: it must call `destroy()` (typically in `onBeforeUnmount`).
 *
 * Document sync is one-way (CM -> caller via onChange); the caller mirrors it
 * back into its own ref so save/autosave logic is unaffected. `setDoc` is used
 * to push external content (e.g. loading an existing script) without producing
 * a feedback loop.
 */
export function createEditor(parent: HTMLElement, options: CreateEditorOptions): CodeMirrorHandle {
  const languageCompartment = new Compartment()
  const themeCompartment = new Compartment()

  const { doc, language, onChange, onSave } = options

  const saveKeymap = keymap.of([
    {
      key: 'Mod-s',
      preventDefault: true,
      run: () => {
        onSave()
        return true
      }
    }
  ])

  const syncListener = EditorView.updateListener.of((update) => {
    if (update.docChanged) onChange(update.state.doc.toString())
  })

  const languageExts = () => [
    languageExtension(language),
    cmAutocomplete(() => currentLanguage)
  ]

  let currentLanguage = language

  const view = new EditorView({
    state: EditorState.create({
      doc,
      extensions: [
        lineNumbers(),
        history(),
        bracketMatching(),
        indentOnInput(),
        highlightActiveLine(),
        highlightActiveLineGutter(),
        keymap.of([...defaultKeymap, ...historyKeymap]),
        saveKeymap,
        languageCompartment.of(languageExts()),
        themeCompartment.of(cmTheme()),
        syncListener,
        EditorView.lineWrapping
      ]
    }),
    parent
  })

  return {
    view,
    setLanguage(next: ScriptLanguage) {
      currentLanguage = next
      view.dispatch({
        effects: languageCompartment.reconfigure([languageExtension(next), cmAutocomplete(() => currentLanguage)])
      })
    },
    setDoc(nextDoc: string) {
      if (nextDoc === view.state.doc.toString()) return
      view.dispatch({
        changes: { from: 0, to: view.state.doc.length, insert: nextDoc }
      })
    },
    destroy() {
      view.destroy()
    }
  }
}
