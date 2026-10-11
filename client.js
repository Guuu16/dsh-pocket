/*
 * dsh-pocket — the in-GUI settings section.
 *
 * Registers one page under Settings → 远程访问 so the relay can be configured
 * where every other preference lives, instead of by opening a URL. The page
 * talks to the same `/pocket/api/config` endpoint the standalone settings page
 * uses, so both surfaces stay in step.
 *
 * Loaded by the shell's module loader; React comes from the browser module
 * table. Styling uses only dsw theme tokens so the page follows light/dark.
 */

window.__ModuleLoader__.load({
  id: "dsh-pocket",
  factory(require) {
    const React = require("react");
    const h = React.createElement;
    const { useState, useEffect, useCallback, useRef } = React;

    /* Every theme token carries a fallback, and the primary button's colours
       are hard-coded. `--dsw-alias-*` is not guaranteed to be defined in the
       frame this page renders in — when it is missing, `background: var(...)`
       is an invalid declaration and the button falls back to a white UA
       default with white text. */
    const CSS = `
.dshp { display: flex; flex-direction: column; gap: 18px; padding: 4px 0 32px; max-width: 620px; }
.dshp h3 { margin: 0; font-size: 15px; font-weight: 600; color: var(--dsw-alias-label-primary, #e7ebf3); }
.dshp p { margin: 0; font-size: 13px; line-height: 1.6; color: var(--dsw-alias-label-secondary, #8b95a7); }
.dshp-card { padding: 14px 16px; border: 1px solid var(--dsw-alias-border-l1, #252b36); border-radius: 12px;
  background: var(--dsw-alias-bg-layer-1, #161a21); display: flex; flex-direction: column; gap: 10px; }
.dshp-row { display: flex; align-items: center; gap: 8px; font-size: 13px; }
.dshp-k { min-width: 92px; color: var(--dsw-alias-label-secondary, #8b95a7); }
.dshp-v { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12.5px;
  color: var(--dsw-alias-label-primary, #e7ebf3); word-break: break-all; }
.dshp-pill { padding: 1px 9px; border-radius: 999px; border: 1px solid var(--dsw-alias-border-l1, #252b36);
  font-size: 12px; color: var(--dsw-alias-label-secondary, #8b95a7); }
.dshp-pill.on { color: #3fb27f; border-color: #3fb27f; }
.dshp-pill.off { color: #d9a441; border-color: #d9a441; }
.dshp label { display: block; font-size: 12.5px; color: var(--dsw-alias-label-secondary, #8b95a7); margin-bottom: 5px; }
.dshp input, .dshp select { width: 100%; height: 34px; padding: 0 10px; font: inherit; font-size: 13px;
  color: var(--dsw-alias-label-primary, #e7ebf3); background: var(--dsw-alias-bg-layer-2, #1b2130);
  border: 1px solid var(--dsw-alias-border-l1, #252b36); border-radius: 8px; }
.dshp input:focus, .dshp select:focus { outline: none; border-color: #3f63f5; }
.dshp-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }
.dshp-actions { display: flex; align-items: center; gap: 10px; margin-top: 2px; }
.dshp button { height: 34px; padding: 0 14px; font: inherit; font-size: 13px; border-radius: 8px; cursor: pointer;
  border: 1px solid var(--dsw-alias-border-l1, #39445a); background: var(--dsw-alias-bg-layer-2, #1c2333);
  color: var(--dsw-alias-label-primary, #e8ecf5); }
.dshp button.primary { background: #3f63f5 !important; border-color: #3f63f5 !important; color: #ffffff !important;
  font-weight: 600; text-shadow: 0 1px 1px rgba(0,0,0,.22); }
.dshp button:hover { filter: brightness(1.1); }
.dshp button:disabled { opacity: .55; cursor: default; }
.dshp-note { font-size: 12px; color: var(--dsw-alias-label-secondary, #8b95a7); }
.dshp-err { font-size: 12.5px; color: #ff7a7a; }
.dshp-ok { color: #3fb27f; font-weight: 600; }
.dshp-bad { color: #ff7a7a; }
.dshp-wait { color: #d9a441; }
.dshp-ok-card { border-color: #3fb27f !important; }
.dshp-url { display: block; padding: 9px 11px; border-radius: 8px; font-size: 12.5px; word-break: break-all;
  font-family: ui-monospace, Menlo, monospace; background: var(--dsw-alias-bg-layer-2, #1b2130);
  border: 1px solid var(--dsw-alias-border-l1, #252b36); color: var(--dsw-alias-label-primary, #e7ebf3); }
`;

    const MODES = [
      { value: "off", label: "关闭（只在本机 / 局域网可用）" },
      { value: "ssh", label: "SSH 反向隧道（需要一台你能登录的服务器）" },
      { value: "cloudflare", label: "Cloudflare 隧道（零配置，不需要服务器）" },
    ];

    function Pill({ on, children }) {
      return h("span", { className: "dshp-pill" + (on ? " on" : " off") }, children);
    }

    function Row({ label, children }) {
      return h("div", { className: "dshp-row" }, h("span", { className: "dshp-k" }, label), children);
    }

    function Field({ label, children }) {
      return h("div", null, h("label", null, label), children);
    }

    function RemoteAccess() {
      const [state, setState] = useState(null);
      const [draft, setDraft] = useState(null);
      const [busy, setBusy] = useState(false);
      const [note, setNote] = useState("");
      const [error, setError] = useState("");
      const timer = useRef(undefined);

      /**
       * Take a server snapshot.
       *
       * `syncDraft` is the whole point: the status strip polls every few
       * seconds, and populating the form from a poll would overwrite whatever
       * the user is editing — a selection made in the dropdown would spring
       * back to the stored value within one poll interval. Only the initial
       * load and an explicit save may touch the form.
       */
      const adopt = useCallback((data, syncDraft) => {
        setState(data);
        if (syncDraft !== true) return;
        setDraft({
          mode: data.relay.mode,
          host: data.relay.host,
          user: data.relay.user,
          sshPort: data.relay.sshPort,
          remotePort: data.relay.remotePort,
          password: "",
        });
      }, []);

      const load = useCallback(async (syncDraft) => {
        try {
          const res = await fetch("/pocket/api/config", { credentials: "same-origin" });
          if (!res.ok) throw new Error("HTTP " + res.status);
          adopt(await res.json(), syncDraft);
        } catch (e) {
          setError("读取配置失败：" + e.message);
        }
      }, [adopt]);

      useEffect(() => {
        load(true);
        timer.current = setInterval(() => load(false), 4000);
        return () => clearInterval(timer.current);
      }, [load]);

      const save = useCallback(async () => {
        setBusy(true);
        setError("");
        setNote("");
        try {
          const res = await fetch("/pocket/api/config", {
            method: "POST",
            credentials: "same-origin",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(draft),
          });
          if (!res.ok) throw new Error("HTTP " + res.status);
          adopt(await res.json(), true);
          // No fixed message here: the status strip below is derived from the
          // live tunnel state, so it reports progress and success by itself.
        } catch (e) {
          setError("保存失败：" + e.message);
        } finally {
          setBusy(false);
        }
      }, [draft, adopt]);

      const rotate = useCallback(async () => {
        setBusy(true);
        setError("");
        try {
          const res = await fetch("/pocket/api/rotate", { method: "POST", credentials: "same-origin" });
          if (!res.ok) throw new Error("HTTP " + res.status);
          adopt(await res.json(), false);
          setNote("已换新密钥，之前配对的设备全部失效。");
        } catch (e) {
          setError("换密钥失败：" + e.message);
        } finally {
          setBusy(false);
        }
      }, [adopt]);

      if (draft === null || state === null) {
        return h("div", { className: "dshp" }, h("style", null, CSS), h("p", null, error === "" ? "加载中…" : error));
      }

      const set = (patch) => setDraft(Object.assign({}, draft, patch));
      const key = state.accessKey;
      const status = state.status;
      const publicUrl = status.publicUrl;
      const tunnelUp = status.tunnel === "up";
      const tunnelFailed = status.tunnel === "失败" || status.tunnel === "端口被拒";

      /* Derived from the live status on every render, so it can never get stuck:
         the poll keeps updating status, and this line follows it. */
      const tunnelLine = tunnelUp
        ? h("span", { className: "dshp-ok" }, "✓ 已连接")
        : tunnelFailed
          ? h("span", { className: "dshp-bad" }, "✗ " + (status.error === undefined ? "连接失败" : status.error))
          : h("span", { className: "dshp-wait" }, (status.tunnel === "关闭" ? "未启用" : status.tunnel) + "…");

      return h("div", { className: "dshp" },
        h("style", null, CSS),
        h("h3", null, "远程访问"),
        h("p", null, "手机访问的就是 dsh 本身的界面——同一份工作区、同一份聊天记录。这里配置从外网进来的路径。"),

        h("div", { className: "dshp-card" },
          Row({ label: "网关", children: h(Pill, { on: status.gateway === "listening" }, status.gateway === "listening" ? "监听中 :" + state.port : status.gateway) }),
          Row({ label: "中继隧道", children: tunnelLine }),
          Row({ label: "访问密钥", children: h("span", { className: "dshp-v" }, key) }),
          h("div", { className: "dshp-actions" },
            h("button", { type: "button", onClick: rotate, disabled: busy }, "换一把密钥"),
            h("span", { className: "dshp-note" }, "所有已配对设备会立即失效")
          )
        ),

        h("div", { className: "dshp-card" + (tunnelUp ? " dshp-ok-card" : "") },
          h("h3", null, tunnelUp ? "公网地址 · 已就绪" : "公网地址"),
          publicUrl
            ? h("code", { className: "dshp-url" }, publicUrl + "/?k=" + key)
            : h("p", null, tunnelFailed ? "没有拿到公网地址。" : "尚未建立公网入口。"),
          h("p", { className: "dshp-note" }, tunnelUp
            ? "把上面这一整行（含 ?k=）发到手机上打开，然后加进主屏。"
            : "不在同一网络时用这个。必须带 ?k=，第一次打开会换成 cookie。")
        ),

        h("div", { className: "dshp-card" },
          h("h3", null, "局域网地址"),
          state.lanUrls.length === 0
            ? h("p", null, "没有检测到局域网地址。")
            : state.lanUrls.map((url, i) => h("code", { className: "dshp-url", key: i }, url + "/?k=" + key)),
          h("p", { className: "dshp-note" }, "手机和这台机器同一个 WiFi 时直接用这个，最快。")
        ),

        h("div", { className: "dshp-card" },
          h("h3", null, "中继服务器"),
          h(Field, { label: "方式" },
            h("select", { value: draft.mode, onChange: (e) => set({ mode: e.target.value }) },
              MODES.map((m) => h("option", { key: m.value, value: m.value }, m.label))
            )
          ),
          draft.mode === "ssh" ? h(React.Fragment, null,
            h("div", { className: "dshp-grid" },
              h(Field, { label: "服务器地址" },
                h("input", { value: draft.host, placeholder: "203.0.113.10", onChange: (e) => set({ host: e.target.value }) })
              ),
              h(Field, { label: "用户名" },
                h("input", { value: draft.user, placeholder: "root", onChange: (e) => set({ user: e.target.value }) })
              )
            ),
            h(Field, { label: "密码（首次用于装公钥，之后自动清掉；留空则用现有密钥）" },
              h("input", { type: "password", value: draft.password, placeholder: state.relay.password === "" ? "" : "已保存", onChange: (e) => set({ password: e.target.value }) })
            ),
            h("div", { className: "dshp-grid" },
              h(Field, { label: "SSH 端口" },
                h("input", { type: "number", value: draft.sshPort, onChange: (e) => set({ sshPort: e.target.value }) })
              ),
              h(Field, { label: "服务器上暴露的端口" },
                h("input", { type: "number", value: draft.remotePort, onChange: (e) => set({ remotePort: e.target.value }) })
              )
            ),
            h("p", { className: "dshp-note" }, "服务器需要 GatewayPorts clientspecified，并在云平台安全组放行该端口。")
          ) : null,
          h("div", { className: "dshp-actions" },
            h("button", { type: "button", className: "primary", onClick: save, disabled: busy }, busy ? "处理中…" : "保存并连接"),
            note === "" ? null : h("span", { className: "dshp-note" }, note)
          ),
          error === "" ? null : h("div", { className: "dshp-err" }, error)
        )
      );
    }

    return {
      inject: ["slots"],
      apply(ctx) {
        ctx.slots.inject("settings.section", () =>
          ctx.slots.register(
            { name: "settings.section", id: "dsh-pocket", order: 60, label: "远程访问" },
            RemoteAccess
          )
        );
      },
    };
  },
});
