// 前后端分离部署时，将 apiBase 设为后端地址，例如 "https://read.example.com"。
// 后端需设置 READ_CORS_ORIGINS 包含前端来源。留空表示与前端同源。
window.READ_CONFIG = { apiBase: "" };

// marked-katex-extension 以裸模块名导入 katex，这里注册 import map（须在模块脚本加载前执行）
{
  const base = window.READ_CONFIG.apiBase.replace(/\/$/, "");
  const map = document.createElement("script");
  map.type = "importmap";
  map.textContent = JSON.stringify({ imports: { katex: `${base}/vendor/katex/katex.mjs` } });
  document.currentScript.after(map);
}
