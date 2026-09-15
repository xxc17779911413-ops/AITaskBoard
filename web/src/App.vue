<template>
  <el-container style="height:100vh">
    <el-header class="app-header">
      <div class="logo">task-board</div>
      <el-menu :default-active="view" mode="horizontal" @select="onMenu" style="flex:1;border-bottom:none">
        <el-menu-item index="requirements">需求管理</el-menu-item>
        <el-menu-item index="documents">文档管理</el-menu-item>
        <el-menu-item index="structure">结构探索</el-menu-item>
        <el-menu-item index="audit">操作审计</el-menu-item>
        <el-menu-item index="tree">任务树</el-menu-item>
        <el-menu-item index="attr-defs">属性定义</el-menu-item>
        <el-menu-item index="settings">设置</el-menu-item>
      </el-menu>
    </el-header>
    <el-main style="padding:0;overflow:hidden">
      <RequirementsView v-if="view === 'requirements'" @select="onNodeSelect" />
      <DocumentsView v-if="view === 'documents'" />
      <StructureView v-if="view === 'structure'" @select="onNodeSelect" />
      <AuditView v-if="view === 'audit'" @select="onNodeSelect" />
      <TreeView v-if="view === 'tree'" ref="treeRef" @select="onNodeSelect" />
      <AttrDefsView v-if="view === 'attr-defs'" />
      <SettingsView v-if="view === 'settings'" />
    </el-main>
    <NodeDrawer v-if="selectedNode" :node="selectedNode" :visible="drawerVisible" :initial-tab="drawerTab" @close="drawerVisible = false" @updated="onNodeUpdated" />
  </el-container>
</template>

<script setup>
import { ref, shallowRef } from 'vue'
import RequirementsView from './views/RequirementsView.vue'
import DocumentsView from './views/DocumentsView.vue'
import StructureView from './views/StructureView.vue'
import AuditView from './views/AuditView.vue'
import TreeView from './views/TreeView.vue'
import AttrDefsView from './views/AttrDefsView.vue'
import SettingsView from './views/SettingsView.vue'
import NodeDrawer from './components/NodeDrawer.vue'

const view = ref('tree')
const drawerVisible = ref(false)
const drawerTab = ref('info')
const selectedNode = shallowRef(null)
const treeRef = ref(null)

function onMenu(index) { view.value = index }

function onNodeSelect(node, tab = 'info') {
  selectedNode.value = node
  drawerTab.value = tab
  drawerVisible.value = true
}

function onNodeUpdated() {
  treeRef.value?.refresh()
}
</script>

<style>
body { margin: 0; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; }
.app-header { display:flex; align-items:center; background:#fff; border-bottom:1px solid #e4e7ed; padding:0 16px; height:48px !important; }
.logo { font-size:16px; font-weight:700; color:#409eff; margin-right:24px; white-space:nowrap; }
</style>
