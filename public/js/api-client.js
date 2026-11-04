/*
 * NoteFly API 客户端
 * ------------------------------------------------------------
 * 统一错误契约：任何一次调用都返回同一种结构，调用方只判断 ok。
 *
 *   { ok: true,  status: 200, ...响应体 }
 *   { ok: false, status: 500, error: "可读的中文原因", networkError?: true, body?: 原始响应体 }
 *
 * 覆盖四类失败：
 *   1. HTTP 4xx/5xx（含服务端返回 JSON 错误、返回 HTML 错误页）
 *   2. 网络断开 / 服务已退出（fetch reject）
 *   3. 请求超时（AbortController）
 *   4. 响应不是 JSON（例如 Express 默认错误页）
 *
 * 关键约束：只有 HTTP 2xx 且响应体是合法 JSON 才返回 ok:true。
 * 这让“保存失败”不可能再被上层当成成功。
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.NFApi = factory();
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  const DEFAULT_TIMEOUT = 20000;

  function isPlainObject(v) {
    return v !== null && typeof v === "object" && !Array.isArray(v);
  }

  function pickMessage(body, status) {
    if (isPlainObject(body)) {
      const m = body.error || body.message || body.msg;
      if (m && typeof m === "string") return m;
    }
    if (typeof body === "string" && body.trim()) return body.trim().slice(0, 200);
    if (status) return `HTTP ${status}`;
    return "未知错误";
  }

  /**
   * 把一次 fetch 响应归一成统一结构。独立导出，便于单元测试。
   * @param {{ ok:boolean, status:number }} res 形似 fetch Response
   * @param {string} text 已读取的响应文本
   */
  function normalizeResponse(res, text) {
    const status = (res && res.status) || 0;
    const raw = typeof text === "string" ? text : "";
    let body = null;
    let parsed = false;
    if (raw) {
      try {
        body = JSON.parse(raw);
        parsed = true;
      } catch {
        body = raw;
      }
    }

    const httpOk = !!(res && res.ok);

    if (!httpOk) {
      /* 非 JSON 的错误响应（Express 默认 HTML 错误页 / 网关页面）也要说清楚 */
      const error = parsed && isPlainObject(body)
        ? pickMessage(body, status)
        : raw
          ? `服务返回了非 JSON 错误响应（HTTP ${status}）：${raw.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim().slice(0, 120)}`
          : `请求失败（HTTP ${status}）`;
      return { ok: false, status, error, networkError: false, body };
    }

    if (!parsed) {
      return {
        ok: false,
        status,
        error: raw
          ? `服务返回了非 JSON 响应（HTTP ${status}），可能不是 NoteFly 服务`
          : `服务返回空响应（HTTP ${status}）`,
        networkError: false,
        body: raw,
      };
    }

    if (isPlainObject(body)) return Object.assign({ ok: true, status }, body);
    return { ok: true, status, data: body };
  }

  /**
   * 创建 api 函数
   * @param {{ fetchImpl?:Function, basePath?:string, timeoutMs?:number }} options
   */
  function createApi(options) {
    const opts = options || {};
    const fetchImpl = opts.fetchImpl || (typeof fetch === "function" ? fetch : null);
    const basePath = opts.basePath == null ? "/api" : opts.basePath;
    const timeoutMs = Number(opts.timeoutMs) > 0 ? Number(opts.timeoutMs) : DEFAULT_TIMEOUT;

    return async function api(path, reqOptions) {
      const o = reqOptions || {};
      const url = basePath + path;
      const controller = typeof AbortController === "function" ? new AbortController() : null;
      const limit = Number(o.timeoutMs) > 0 ? Number(o.timeoutMs) : timeoutMs;
      let timer = null;

      if (controller) {
        timer = setTimeout(() => {
          try { controller.abort(); } catch {}
        }, limit);
      }

      const init = {
        method: o.method || "GET",
        headers: Object.assign({ "Content-Type": "application/json" }, o.headers || {}),
        signal: controller ? controller.signal : undefined,
      };
      if (o.body !== undefined && o.body !== null) {
        init.body = typeof o.body === "string" ? o.body : JSON.stringify(o.body);
      }

      let res;
      try {
        if (!fetchImpl) throw new Error("当前环境没有 fetch");
        res = await fetchImpl(url, init);
      } catch (e) {
        const name = e && e.name;
        const aborted = name === "AbortError" || name === "TimeoutError";
        return {
          ok: false,
          status: 0,
          networkError: !aborted,
          timedOut: aborted,
          error: aborted
            ? `请求超时（${Math.round(limit / 1000)} 秒未响应），操作结果未确认`
            : "无法连接 NoteFly 服务（可能已退出），请重启桌面版后重试",
          detail: String((e && e.message) || e),
        };
      } finally {
        if (timer) clearTimeout(timer);
      }

      let text = "";
      try {
        text = await res.text();
      } catch (e) {
        return {
          ok: false,
          status: res.status || 0,
          error: "读取服务响应失败：" + String((e && e.message) || e),
        };
      }
      return normalizeResponse(res, text);
    };
  }

  return { createApi, normalizeResponse, pickMessage, DEFAULT_TIMEOUT };
});
