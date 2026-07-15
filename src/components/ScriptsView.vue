<script setup lang="ts">
import { onMounted, ref } from 'vue'
import type { ScriptSummary, SelectedScriptFile } from '../types/api'
import type { ScriptLanguage } from '../types/domain'

const emit = defineEmits<{
  (event: 'feedback', type: 'success' | 'error', message: string): void
}>()

const scripts = ref<ScriptSummary[]>([])
const selection = ref<SelectedScriptFile | null>(null)
const importVisible = ref(false)
const editorVisible = ref(false)
const editingScriptId = ref<string | null>(null)
const importing = ref(false)
const saving = ref(false)
const name = ref('')
const note = ref('')
const content = ref('')
const language = ref<ScriptLanguage>('javascript')
const languageOptions = [
  { label: 'JavaScript', value: 'javascript' },
  { label: 'Python', value: 'python' },
  { label: 'PowerShell', value: 'powershell' },
  { label: 'Shell', value: 'shell' }
]
const languageLabels: Record<ScriptLanguage, string> = {
  javascript: 'JavaScript',
  python: 'Python',
  powershell: 'PowerShell',
  shell: 'Shell'
}

/** Loads managed script summaries from preload without exposing source paths or hashes. */
async function loadScripts() {
  const result = await window.scripty?.scripts?.list()
  if (!result) return
  if (result.ok === true) scripts.value = result.data
  else emit('feedback', 'error', result.error.message)
}

/** Opens a blank built-in source editor for a new managed script. */
function openCreateEditor() {
  editingScriptId.value = null
  name.value = ''
  note.value = ''
  content.value = ''
  language.value = 'javascript'
  editorVisible.value = true
}

/** Loads one managed source into the editor; the renderer never receives its filesystem path. */
async function openEditEditor(script: ScriptSummary) {
  const result = await window.scripty?.scripts?.get(script.id)
  if (!result) return
  if (result.ok === false) return emit('feedback', 'error', result.error.message)
  editingScriptId.value = script.id
  name.value = result.data.name
  note.value = result.data.note
  content.value = result.data.content
  language.value = result.data.language
  editorVisible.value = true
}

/** Creates or updates managed source atomically and refreshes summaries after persistence succeeds. */
async function saveSource() {
  const api = window.scripty?.scripts
  if (!api || saving.value) return
  saving.value = true
  const input = { name: name.value, note: note.value, content: content.value, language: language.value }
  const result = editingScriptId.value
    ? await api.update(editingScriptId.value, input)
    : await api.create(input)
  saving.value = false
  if (result.ok === false) return emit('feedback', 'error', result.error.message)
  editorVisible.value = false
  await loadScripts()
  emit('feedback', 'success', editingScriptId.value ? '脚本源码已更新' : '脚本已创建')
}

/** Opens the host picker, then hydrates an import preview from its short-lived selection token. */
async function chooseImportFile() {
  const result = await window.scripty?.scripts?.chooseImportFile()
  if (!result) return
  if (result.ok === false) return emit('feedback', 'error', result.error.message)
  if (!result.data) return
  selection.value = result.data
  name.value = result.data.displayName.replace(/\.[^.]+$/, '')
  language.value = result.data.detectedLanguage ?? 'javascript'
  note.value = ''
  importVisible.value = true
}

/** Consumes the selected token once and refreshes summaries after the managed copy is committed. */
async function importScript() {
  if (!selection.value || !window.scripty?.scripts || importing.value) return
  importing.value = true
  const result = await window.scripty.scripts.importSelected(selection.value.selectionToken, {
    name: name.value,
    language: language.value,
    note: note.value
  })
  importing.value = false
  if (result.ok === false) return emit('feedback', 'error', result.error.message)
  importVisible.value = false
  selection.value = null
  await loadScripts()
  emit('feedback', 'success', `已导入“${result.data.name}”的托管副本`)
}

/** Formats byte counts for the import preview without revealing the original source path. */
function formatSize(size: number) {
  if (size < 1024) return `${size} B`
  return `${(size / 1024).toFixed(1)} KiB`
}

onMounted(loadScripts)
</script>

<template>
  <section class="scripts-view" aria-labelledby="scripts-heading">
    <ZDrawer v-model:show="editorVisible" placement="right" width="600" trap-focus auto-focus>
      <ZDrawerContent :title="editingScriptId ? '编辑脚本源码' : '新建脚本'" closable>
        <form class="script-editor" @submit.prevent="saveSource">
          <p v-if="editingScriptId" class="managed-copy-notice" role="note">
            当前编辑的是 Scripty 托管副本，保存不会修改最初导入的外部文件。
          </p>
          <div class="script-editor__meta">
            <label><span>脚本名称</span><ZInput v-model="name" placeholder="脚本名称" /></label>
            <label><span>语言</span><ZSelect v-model="language" :options="languageOptions" :disabled="Boolean(editingScriptId)" /></label>
          </div>
          <label><span>备注</span><ZInput v-model="note" placeholder="可选备注" maxlength="500" /></label>
          <label class="source-editor-label">
            <span>源码</span>
            <textarea v-model="content" class="source-editor" spellcheck="false" aria-label="脚本源码" />
          </label>
        </form>
        <template #footer>
          <div class="drawer-actions">
            <ZButton type="default" @click="editorVisible = false">取消</ZButton>
            <ZButton type="primary" :loading="saving" :disabled="!name.trim()" @click="saveSource">保存源码</ZButton>
          </div>
        </template>
      </ZDrawerContent>
    </ZDrawer>

    <ZModal v-model:show="importVisible" :mask-closable="false" trap-focus auto-focus>
      <div v-if="selection" class="import-form">
        <h3>导入本地脚本</h3>
        <div class="import-preview">
          <strong>{{ selection.displayName }}</strong>
          <span>{{ formatSize(selection.size) }} · 原文件路径不会暴露给页面</span>
        </div>
        <label><span>脚本名称</span><ZInput v-model="name" placeholder="脚本名称" /></label>
        <label><span>脚本语言</span><ZSelect v-model="language" :options="languageOptions" /></label>
        <label><span>备注</span><ZInput v-model="note" type="textarea" maxlength="500" /></label>
        <div class="drawer-actions">
          <ZButton type="default" @click="importVisible = false">取消</ZButton>
          <ZButton type="primary" :loading="importing" :disabled="!name.trim()" @click="importScript">复制到 Scripty</ZButton>
        </div>
      </div>
    </ZModal>

    <div class="section-heading">
      <div>
        <h2 id="scripts-heading">托管脚本</h2>
      </div>
      <div class="section-heading__actions">
        <ZButton type="default" @click="openCreateEditor">新建脚本</ZButton>
        <ZButton type="primary" @click="chooseImportFile">导入本地脚本</ZButton>
      </div>
    </div>

    <div class="view-body">
    <div v-if="scripts.length === 0" class="empty-state">
      <div class="empty-state__mark" aria-hidden="true">S</div>
      <h3>还没有脚本</h3>
      <p>选择本地 JavaScript、Python、PowerShell 或 Shell 文件并复制到托管目录。</p>
    </div>
    <ul v-else class="script-list">
      <li v-for="script in scripts" :key="script.id" class="script-row">
        <div><strong>{{ script.name }}</strong><p>{{ script.note || '暂无备注' }}</p></div>
        <div class="script-row__actions">
          <ZTag type="info" size="small">{{ languageLabels[script.language] }}</ZTag>
          <ZButton type="text" size="small" @click="openEditEditor(script)">编辑源码</ZButton>
        </div>
      </li>
    </ul>
    </div>
  </section>
</template>
