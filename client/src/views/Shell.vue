<script setup>
import { onMounted, ref } from "vue";
import { RouterView, useRouter } from "vue-router";
import { api, clearToken } from "../api";

const router = useRouter();
const site = ref("Обект");
onMounted(() => {
  api("/api/site").then((data) => { if (data.label) site.value = data.label; }).catch(() => {});
});
function logout() {
  api("/api/auth/logout", { method: "POST" }).catch(() => {});
  clearToken();
  router.replace("/login");
}
</script>
<template>
  <div class="shell">
    <header class="top no-print">
      <div>
        <b>Входящ контрол</b>
        <span class="muted">{{ site }}</span>
      </div>
      <button class="btn ghost" type="button" @click="logout">Изход</button>
    </header>
    <main class="main">
      <RouterView />
    </main>
  </div>
</template>
