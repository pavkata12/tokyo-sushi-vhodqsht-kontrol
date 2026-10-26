<script setup>
import { reactive, ref } from "vue";
import { useRouter } from "vue-router";
import { api, setToken } from "../api";
const router = useRouter();
const form = reactive({ user: "", pass: "" });
const err = ref("");
const see = ref(false);
async function login() {
  try {
    const { token } = await api("/api/auth/login", { method: "POST", body: form });
    setToken(token);
    router.push("/");
  } catch (e) { err.value = e.message; }
}
</script>
<template>
  <div class="login">
    <form class="panel" @submit.prevent="login">
      <div class="muted">Дневник за приети храни</div>
      <h1>Входящ контрол</h1>
      <p class="muted">Качване на фактури и стокови, партиди и печат на дневника.</p>
      <label for="intake-user">Потребител</label>
      <input id="intake-user" v-model="form.user" autocomplete="username" autocapitalize="none" spellcheck="false" />
      <label for="intake-pass">Парола</label>
      <div class="pass-field">
        <input id="intake-pass" v-model="form.pass" :type="see ? 'text' : 'password'" autocomplete="current-password" />
        <button type="button" class="pass-toggle" @click="see = !see">{{ see ? "Скрий" : "Покажи" }}</button>
      </div>
      <p class="bad">{{ err }}</p>
      <button class="btn">Влез</button>
    </form>
  </div>
</template>
