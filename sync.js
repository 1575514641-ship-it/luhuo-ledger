// 撸货记账 · 云同步数据层
// 协议与五行理财的 sync.js 完全同源：Cloudflare Worker KV，/load + /save，按 userId+secret 隔离。
// 差异点：身份常量独立命名（数据与理财站物理隔离）；同步码前缀 LUHUO1；
// 理财站的 /api/sync 反代已放开 CORS(*)，这里直接跨域调用，无需自有代理。
// 加载顺序：index.html -> sync.js -> app.js
(function () {
  "use strict";

  const WORKER_URL_KEY = "luhuo-sync-endpoint-v1";
  const IDENTITY_KEY = "luhuo-sync-identity-v1";
  const DEFAULT_BASE = "https://www0706.netlify.app/api/sync";

  // ---- 工具函数 ----

  function bytesToBase64Url(bytes) {
    let binary = "";
    bytes.forEach((byte) => { binary += String.fromCharCode(byte); });
    return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
  }

  function base64UrlToBytes(text) {
    const padded = text.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(text.length / 4) * 4, "=");
    const binary = atob(padded);
    return Uint8Array.from(binary, (ch) => ch.charCodeAt(0));
  }

  function randomToken(byteLength) {
    const bytes = new Uint8Array(byteLength);
    crypto.getRandomValues(bytes);
    return bytesToBase64Url(bytes);
  }

  function normalizeIdentity(input) {
    if (!input || typeof input !== "object") return null;
    const userId = String(input.userId || input.user_id || "").trim();
    const secret = String(input.secret || "").trim();
    if (!userId || !secret || secret.length < 24) return null;
    return { version: 1, userId, secret, createdAt: input.createdAt || new Date().toISOString() };
  }

  function getIdentity() {
    try {
      const saved = normalizeIdentity(JSON.parse(localStorage.getItem(IDENTITY_KEY) || "null"));
      if (saved) return saved;
    } catch { /* fall through */ }
    const identity = {
      version: 1,
      userId: crypto.randomUUID(),
      secret: randomToken(32),
      createdAt: new Date().toISOString(),
    };
    saveIdentity(identity);
    return identity;
  }

  function saveIdentity(identity) {
    localStorage.setItem(IDENTITY_KEY, JSON.stringify(identity));
  }

  function encodeSyncCode(identity) {
    const payload = JSON.stringify({ v: 1, userId: identity.userId, secret: identity.secret });
    return "LUHUO1." + bytesToBase64Url(new TextEncoder().encode(payload));
  }

  function parseSyncCode(code) {
    const clean = String(code || "").trim();
    if (!clean) throw new Error("同步码不能为空");
    let payload = clean;
    if (clean.startsWith("LUHUO1.")) {
      const bytes = base64UrlToBytes(clean.slice("LUHUO1.".length));
      payload = new TextDecoder().decode(bytes);
    }
    const identity = normalizeIdentity(JSON.parse(payload));
    if (!identity) throw new Error("同步码格式不正确");
    return identity;
  }

  // ---- 同步 API ----

  function getBase() {
    const saved = localStorage.getItem(WORKER_URL_KEY) || "";
    return saved || DEFAULT_BASE;
  }

  function friendlyError(status, text) {
    const body = String(text || "");
    if (status === 401 || status === 403) {
      return "同步码校验失败，请确认两台设备使用同一个同步码。";
    }
    if (status >= 500) {
      return "云同步暂时失败，数据仍保存在本机，请稍后重试。";
    }
    return "云同步失败，数据仍保存在本机：" + body.slice(0, 120);
  }

  async function apiFetch(endpoint, body) {
    const base = getBase().replace(/\/+$/, "");
    const res = await fetch(base + endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      cache: "no-store",
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(friendlyError(res.status, text));
    }
    return res.json();
  }

  async function loadRecord() {
    const identity = getIdentity();
    const result = await apiFetch("/load", { userId: identity.userId, secret: identity.secret });
    if (!result.found) return null;
    return { data: result.data, updatedAt: result.updatedAt };
  }

  async function saveRecord(data, updatedAt) {
    const identity = getIdentity();
    const result = await apiFetch("/save", {
      userId: identity.userId,
      secret: identity.secret,
      data,
      updatedAt: updatedAt || new Date().toISOString(),
    });
    return { data, updatedAt: result.updatedAt };
  }

  // ---- 对外接口 ----

  window.luhuoSync = {
    endpointLabel() {
      return getBase();
    },

    setEndpoint(url) {
      const clean = String(url || "").replace(/\/$/, "");
      localStorage.setItem(WORKER_URL_KEY, clean);
      getIdentity();
    },

    isConfigured() {
      return !!getBase();
    },

    getSyncCode() {
      return encodeSyncCode(getIdentity());
    },

    applySyncCode(code) {
      const identity = parseSyncCode(code);
      saveIdentity(identity);
      return identity;
    },

    resetIdentity() {
      const identity = {
        version: 1,
        userId: crypto.randomUUID(),
        secret: randomToken(32),
        createdAt: new Date().toISOString(),
      };
      saveIdentity(identity);
      return identity;
    },

    async loadData() {
      const record = await loadRecord();
      return record ? record.data : null;
    },

    loadRecord,

    async saveData(data, updatedAt) {
      return saveRecord(data, updatedAt);
    },

    setStatus(status, detail) {
      const el = document.querySelector("#syncStatus");
      if (!el) return;
      el.className = "sync-badge " + status;
      const labels = { online: "云同步", syncing: "同步中", offline: "本地", error: "同步失败" };
      el.textContent = labels[status] || status;
      el.title = detail || "";
    },
  };
})();
