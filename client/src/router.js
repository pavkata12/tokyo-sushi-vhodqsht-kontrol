import { createRouter, createWebHistory } from "vue-router";
import { getToken } from "./api";
import Login from "./views/Login.vue";
import Shell from "./views/Shell.vue";

const router = createRouter({
  history: createWebHistory(),
  scrollBehavior() { return { top: 0 }; },
  routes: [
    { path: "/login", component: Login },
    {
      path: "/",
      component: Shell,
      children: [
        { path: "", component: () => import("./views/Intake.vue") }
      ]
    }
  ]
});

router.beforeEach((to) => {
  if (to.path !== "/login" && !getToken()) return "/login";
  if (to.path === "/login" && getToken()) return "/";
});

export default router;
