const KEY = "intake_token";

export function getToken() {
  return localStorage.getItem(KEY) || sessionStorage.getItem(KEY) || "";
}
export function setToken(token) {
  localStorage.setItem(KEY, token);
  sessionStorage.removeItem(KEY);
}
export function clearToken() {
  localStorage.removeItem(KEY);
  sessionStorage.removeItem(KEY);
}

export async function api(path, opts = {}) {
  const headers = { "Content-Type": "application/json", ...(opts.headers || {}) };
  if (getToken()) headers.Authorization = "Bearer " + getToken();
  const res = await fetch(path, { ...opts, headers, body: opts.body ? JSON.stringify(opts.body) : undefined });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && !path.includes("/auth/login")) {
    clearToken();
    if (!location.pathname.endsWith("/login")) location.replace("/login");
  }
  if (!res.ok) throw new Error(data.error || "Грешка");
  return data;
}
