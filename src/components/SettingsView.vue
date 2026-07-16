<script setup lang="ts">
import { onMounted, ref } from 'vue'
import type { SettingsView } from '../types/api'
import type { ScriptLanguage } from '../types/domain'

const emit = defineEmits<{
  (event: 'feedback', type: 'success' | 'error', message: string): void
}>()

const settings = ref<SettingsView | null>(null)
const selecting = ref<ScriptLanguage | null>(null)
const languageRows: Array<{ language: ScriptLanguage; label: string; fallback: string }> = [
  { language: 'javascript', label: 'JavaScript', fallback: 'node' },
  { language: 'python', label: 'Python', fallback: 'python' },
  { language: 'powershell', label: 'PowerShell', fallback: 'powershell' },
  { language: 'shell', label: 'Shell', fallback: 'sh' }
]

/** Loads device-local interpreter defaults from preload. */
async function loadSettings() {
  const result = await window.scripty?.settings?.get()
  if (!result) return
  if (result.ok === true) settings.value = result.data
  else emit('feedback', 'error', result.error.message)
}

/** Persists manually entered interpreter commands or absolute paths for all supported languages. */
async function saveSettings() {
  if (!settings.value || !window.scripty?.settings) return
  const { updatedAt, ...input } = settings.value
  const result = await window.scripty.settings.update(input)
  if (result.ok === false) return emit('feedback', 'error', result.error.message)
  settings.value = result.data
  emit('feedback', 'success', '默认解释器已保存')
}

/** Selects and validates a local interpreter file through a short-lived preload token. */
async function chooseInterpreter(language: ScriptLanguage) {
  const api = window.scripty?.settings
  if (!api || !settings.value) return
  selecting.value = language
  const selection = await api.chooseInterpreter(language)
  if (selection.ok === false) {
    selecting.value = null
    return emit('feedback', 'error', selection.error.message)
  }
  if (!selection.data) {
    selecting.value = null
    return
  }
  const validation = await api.validateInterpreter(language, selection.data.selectionToken)
  selecting.value = null
  if (validation.ok === false) return emit('feedback', 'error', validation.error.message)
  await loadSettings()
  emit('feedback', 'success', `${languageRows.find(row => row.language === language)?.label} 解释器已更新`)
}

onMounted(loadSettings)
</script>

<template>
  <section class="settings-view" aria-labelledby="settings-heading">
    <div class="section-heading">
      <div><h2 id="settings-heading">解释器设置</h2></div>
      <ZButton type="primary" :disabled="!settings" @click="saveSettings">保存设置</ZButton>
    </div>
    <div v-if="settings" class="interpreter-settings">
      <div v-for="row in languageRows" :key="row.language" class="interpreter-row">
        <div class="interpreter-row__label"><strong>{{ row.label }}</strong><span>默认命令：{{ row.fallback }}</span></div>
        <ZInput v-model="settings.defaultInterpreters[row.language]" :placeholder="row.fallback" />
        <ZButton type="default" :loading="selecting === row.language" @click="chooseInterpreter(row.language)">选择文件</ZButton>
      </div>
    </div>
  </section>
</template>

<style scoped lang="scss">
.settings-view {
  padding-top: 0;
}

.interpreter-settings {
  display: grid;
  gap: 12px;
}

.interpreter-row {
  display: grid;
  grid-template-columns: 150px minmax(160px, 420px) auto;
  align-items: center;
  gap: 14px;
  padding: 16px 18px;
  border: 1px solid var(--border-color);
  border-radius: 14px;
  background: var(--card-bg);
}

.interpreter-row__label {
  display: grid;
  gap: 4px;
}

.interpreter-row__label span {
  color: var(--text-secondary);
  font-size: 12px;
}

@media (max-width: 760px) {
  .interpreter-row {
    grid-template-columns: 1fr;
  }
}
</style>
