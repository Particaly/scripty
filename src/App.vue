<script setup lang="ts">
import { onMounted, ref } from 'vue'
import Hello from './Hello/index.vue'
import Read from './Read/index.vue'
import Write from './Write/index.vue'

const route = ref('scripty')
const enterAction = ref<any>({})

onMounted(() => {
  window.ztools.onPluginEnter((action) => {
    window.services.lifecycleProbe.record('plugin-enter', { code: action.code })
    route.value = action.code
    enterAction.value = action
  })
  window.ztools.onPluginOut((processExit) => {
    window.services.lifecycleProbe.record('plugin-out', { processExit })
    route.value = ''
  })
})
</script>

<template>
  <Hello v-if="route === 'scripty'" :enter-action="enterAction" />
  <Read v-if="route === 'read'" :enter-action="enterAction" />
  <Write v-if="route === 'write'" :enter-action="enterAction" />
</template>
