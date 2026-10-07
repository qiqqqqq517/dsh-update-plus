/**
 * dsh-update-plus — client half (the settings panel).
 *
 * A plain ModuleLoader bundle: no build step, matching how the host loads plugin
 * client halves. The panel is a view over the host's JSON API; every decision
 * (which feed, which artifact, whether a restart is safe) is made there.
 *
 * Layout note — the restart control is deliberately the element directly under
 * the update controls: check the channel, download the build, then restart into
 * it, in that reading order.
 *
 * @module dsh-update-plus/client
 */
window.__ModuleLoader__.load({ id: "dsh-update-plus", factory: (require) => {
  var module = { exports: {} }
  var exports = module.exports
  Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" })

  const react = require("react")
  const h = react.createElement
  const { useCallback, useEffect, useRef, useState } = react

  const name = "dsh-update-plus"
  const inject = ["slots", "locale"]
  const NS = "settings.dsh-update-plus"
  const ROUTE = "/dsh-update-plus/api"
  let translate = key => key

  // -------------------------------------------------------------------------
  // Strings
  // -------------------------------------------------------------------------
  const zh = {
    nav: "更新与重启",
    title: "更新与重启",
    lead: "检查 DeepSeek Harness 桌面端更新、直接下载官方安装包，并重启应用与 Host。",
    loading: "正在读取…",
    failed: "出错了：",
    retry: "重试",

    installTitle: "当前安装",
    installMissing: "没有找到 DeepSeek Harness 安装目录。请在下面手动指定。",
    installApp: "应用版本",
    installDsh: "Harness 版本",
    installRoot: "安装目录",
    installLauncher: "启动程序",
    installUpdater: "自带更新配置",
    installPackaged: "打包安装（app.asar）",
    installUnpacked: "目录安装（resources/app）",
    unknown: "未知",

    channelTitle: "更新通道",
    channelHint: "稳定版 = 官方正式通道（latest）；测试版 = 预发布通道（beta）；每日构建 = 官方当前实际发布的 nightly 通道。官方尚未发布某个通道时，面板会明确标出「未发布」，不会假装有更新。",
    "channel.stable": "稳定版",
    "channel.beta": "测试版",
    "channel.nightly": "每日构建",
    "channel.unpublished": "未发布",
    "channel.error": "读取失败",
    "channel.upToDate": "已是最新",
    "channel.updateAvailable": "有新版本",
    "channel.inferred": "官网直链",

    check: "检查更新",
    checking: "正在检查…",
    download: "直接下载最新版本",
    downloading: "正在下载…",
    cancel: "取消下载",
    verify: "正在校验…",
    verified: "SHA-512 校验通过",
    notVerified: "官方清单未提供校验值",
    downloadDone: "下载完成",
    downloadedTo: "已保存到",
    openFile: "打开安装包",
    checkFirst: "先点「检查更新」，或直接点「直接下载最新版本」。",
    sizeLabel: "大小",
    releasedLabel: "发布时间",

    restartTitle: "重启",
    restart: "重启应用与 Host",
    restartHint: "关闭 DSH Desktop 并重新启动它——Host 随之重启，插件与配置全部重新加载。",
    restartWarn: "重启会强制关闭当前应用；正在进行的回复会被中断（会话记录已实时落盘）。",
    restartUnsupported: "这个重启方式目前只支持 Windows。",
    restarting: "已安排重启，倒计时结束后应用将关闭并重新打开。",
    restartLog: "重启日志",

    settingsTitle: "设置",
    downloadDir: "下载目录",
    installRootOverride: "手动指定安装目录",
    installRootHint: "留空则自动探测（从 Host 自己的位置向上查找 resources/app.asar）。",
    restartDelay: "重启前等待（秒）",
    save: "保存",
    saved: "已保存",
  }

  const en = {
    nav: "Update & Restart",
    title: "Update & Restart",
    lead: "Check for DeepSeek Harness desktop updates, download the official installer directly, and restart the app together with its Host.",
    loading: "Loading…",
    failed: "Failed: ",
    retry: "Retry",

    installTitle: "Installed build",
    installMissing: "No DeepSeek Harness installation was found. Set the directory manually below.",
    installApp: "App version",
    installDsh: "Harness version",
    installRoot: "Install directory",
    installLauncher: "Launcher",
    installUpdater: "Bundled update config",
    installPackaged: "Packaged (app.asar)",
    installUnpacked: "Directory (resources/app)",
    unknown: "unknown",

    channelTitle: "Update channel",
    channelHint: "Stable = the official release channel (latest); Beta = prerelease (beta); Nightly = what the vendor actually publishes today. A channel the vendor has not published is labelled \"not published\" rather than reported as an update.",
    "channel.stable": "Stable",
    "channel.beta": "Beta",
    "channel.nightly": "Nightly",
    "channel.unpublished": "not published",
    "channel.error": "feed error",
    "channel.upToDate": "up to date",
    "channel.updateAvailable": "update available",
    "channel.inferred": "official link",

    check: "Check for updates",
    checking: "Checking…",
    download: "Download the latest now",
    downloading: "Downloading…",
    cancel: "Cancel download",
    verify: "Verifying…",
    verified: "SHA-512 verified",
    notVerified: "the official manifest carries no digest",
    downloadDone: "Download complete",
    downloadedTo: "Saved to",
    openFile: "Open installer",
    checkFirst: "Press \"Check for updates\", or go straight to \"Download the latest now\".",
    sizeLabel: "Size",
    releasedLabel: "Published",

    restartTitle: "Restart",
    restart: "Restart app and Host",
    restartHint: "Closes DSH Desktop and starts it again — the Host goes with it, so plugins and configuration are reloaded from scratch.",
    restartWarn: "The restart force-closes the running app; an in-flight reply is interrupted (the session log is written continuously).",
    restartUnsupported: "This restart path currently supports Windows only.",
    restarting: "Restart scheduled; the app will close and reopen when the countdown ends.",
    restartLog: "Restart log",

    settingsTitle: "Settings",
    downloadDir: "Download directory",
    installRootOverride: "Installation directory override",
    installRootHint: "Leave empty to auto-detect (walking up from the Host's own location to resources/app.asar).",
    restartDelay: "Delay before restart (seconds)",
    save: "Save",
    saved: "Saved",
  }

  // -------------------------------------------------------------------------
  // Styles (inline and theme-agnostic: these panels sit in both a light and a
  // dark shell, and the plugin has no access to the shell's CSS modules)
  // -------------------------------------------------------------------------
  const styles = {
    wrap: { display: "flex", flexDirection: "column", gap: "18px", fontSize: "13px", lineHeight: "1.6" },
    lead: { margin: "0", opacity: "0.75" },
    group: { display: "flex", flexDirection: "column", gap: "8px", borderTop: "1px solid rgba(128,128,128,.25)", paddingTop: "14px" },
    groupTitle: { margin: "0", fontWeight: "600", fontSize: "13px" },
    row: { display: "flex", alignItems: "center", gap: "10px", flexWrap: "wrap" },
    hint: { margin: "0", opacity: "0.65", fontSize: "12px" },
    error: { color: "#e5534b" },
    ok: { color: "#3fb950" },
    button: { padding: "5px 12px", borderRadius: "6px", border: "1px solid rgba(128,128,128,.4)", background: "transparent", color: "inherit", cursor: "pointer", fontSize: "13px" },
    buttonPrimary: { padding: "5px 14px", borderRadius: "6px", border: "1px solid rgba(128,128,128,.4)", background: "rgba(128,128,128,.18)", color: "inherit", cursor: "pointer", fontSize: "13px", fontWeight: "600" },
    buttonDisabled: { opacity: "0.5", cursor: "default" },
    segment: { display: "flex", gap: "0", border: "1px solid rgba(128,128,128,.4)", borderRadius: "6px", overflow: "hidden" },
    segmentItem: { padding: "4px 12px", border: "none", background: "transparent", color: "inherit", cursor: "pointer", fontSize: "13px" },
    segmentActive: { background: "rgba(128,128,128,.28)", fontWeight: "600" },
    badge: { padding: "1px 8px", borderRadius: "999px", border: "1px solid rgba(128,128,128,.4)", fontSize: "11px" },
    code: { fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace", fontSize: "12px", opacity: "0.85", wordBreak: "break-all" },
    bar: { height: "6px", borderRadius: "999px", background: "rgba(128,128,128,.25)", overflow: "hidden" },
    barFill: { height: "100%", background: "currentColor", opacity: "0.55", transition: "width .2s linear" },
    kv: { display: "grid", gridTemplateColumns: "auto 1fr", gap: "2px 12px", fontSize: "12px" },
    kvKey: { opacity: "0.6", whiteSpace: "nowrap" },
    input: { padding: "4px 8px", borderRadius: "6px", border: "1px solid rgba(128,128,128,.4)", background: "transparent", color: "inherit", fontSize: "12px", minWidth: "320px", flex: "1" },
  }

  // -------------------------------------------------------------------------
  // API
  // -------------------------------------------------------------------------
  async function call(action, body) {
    const method = body === undefined ? "GET" : "POST"
    const response = await fetch(`${ROUTE}?action=${encodeURIComponent(action)}`, {
      method,
      headers: body === undefined ? undefined : { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
      credentials: "same-origin",
      cache: "no-store",
    })
    const text = await response.text()
    let payload
    try {
      payload = JSON.parse(text)
    } catch {
      throw new Error(`HTTP ${response.status}: ${text.slice(0, 200)}`)
    }
    if (payload.ok !== true) throw new Error(payload.error || `HTTP ${response.status}`)
    return payload
  }

  // -------------------------------------------------------------------------
  // Small presentational helpers
  // -------------------------------------------------------------------------
  function formatSize(bytes) {
    if (typeof bytes !== "number" || !Number.isFinite(bytes) || bytes <= 0) return ""
    const units = ["B", "KB", "MB", "GB"]
    let value = bytes
    let unit = 0
    while (value >= 1024 && unit < units.length - 1) { value /= 1024; unit += 1 }
    return `${value >= 100 || unit === 0 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`
  }

  function formatDate(value) {
    if (typeof value !== "string" || value === "") return ""
    const parsed = new Date(value)
    return Number.isNaN(parsed.getTime()) ? value : parsed.toLocaleString()
  }

  function button(label, onClick, options) {
    const opts = options || {}
    const disabled = opts.disabled === true
    return h("button", {
      type: "button",
      style: { ...(opts.primary ? styles.buttonPrimary : styles.button), ...(disabled ? styles.buttonDisabled : {}) },
      disabled,
      onClick: disabled ? undefined : onClick,
      title: opts.title,
    }, label)
  }

  function kvRow(t, key, value) {
    if (value === undefined || value === null || value === "") return null
    return [h("span", { key: `${key}-k`, style: styles.kvKey }, t(key)), h("span", { key: `${key}-v`, style: styles.code }, String(value))]
  }

  // -------------------------------------------------------------------------
  // The panel
  // -------------------------------------------------------------------------
  function SettingsRoot() {
    const t = translate
    const [state, setState] = useState(null)
    const [error, setError] = useState("")
    const [busy, setBusy] = useState("")
    const [download, setDownload] = useState(null)
    const [notice, setNotice] = useState("")
    const pollRef = useRef(null)

    const refresh = useCallback(() => {
      setError("")
      return call("state").then(payload => {
        setState(payload)
        if (payload.download !== undefined && payload.download !== null) setDownload(payload.download)
      }).catch(failure => setError(String(failure && failure.message ? failure.message : failure)))
    }, [])

    useEffect(() => { refresh() }, [refresh])

    // Poll only while something is actually moving: an idle panel must not spin
    // a timer against the host forever.
    useEffect(() => {
      const active = download !== null && download !== undefined && download.active === true
      if (!active) {
        if (pollRef.current !== null) { clearInterval(pollRef.current); pollRef.current = null }
        return undefined
      }
      if (pollRef.current !== null) return undefined
      pollRef.current = setInterval(() => {
        call("progress").then(payload => {
          setDownload(payload.download)
          if (payload.download !== null && payload.download !== undefined && payload.download.active !== true) {
            refresh().catch(() => {})
          }
        }).catch(() => { /* a failed poll surfaces on the next manual refresh */ })
      }, 400)
      return () => { if (pollRef.current !== null) { clearInterval(pollRef.current); pollRef.current = null } }
    }, [download, refresh])

    const act = useCallback((label, run) => {
      setBusy(label)
      setError("")
      setNotice("")
      return run().catch(failure => setError(String(failure && failure.message ? failure.message : failure)))
        .then(() => setBusy(""))
    }, [])

    if (state === null) {
      return h("div", { style: styles.wrap }, [
        h("p", { key: "l", style: styles.lead }, t("loading")),
        error !== "" ? h("p", { key: "e", style: styles.error }, `${t("failed")}${error}`) : null,
      ])
    }

    const install = state.install || {}
    const settings = state.settings || {}
    const channel = settings.channel || "nightly"
    const result = state.lastResult || null
    const channels = (result && Array.isArray(result.channels)) ? result.channels : []
    const selected = channels.find(item => item.id === channel)
    const downloading = download !== null && download !== undefined && download.active === true

    const pickChannel = next => {
      act("channel", async () => {
        const payload = await call("settings", { settings: { channel: next } })
        setState(current => ({ ...current, settings: payload.settings, install: payload.install || current.install }))
      })
    }

    const channelRow = feature => h("div", { key: feature.id, style: styles.row }, [
      h("span", { style: { ...styles.code, minWidth: "150px" } }, feature.manifest),
      h("span", { style: styles.badge }, feature.available
        ? (feature.version || t("unknown"))
        : (feature.reason === "channel-not-published" ? t("channel.unpublished") : t("channel.error"))),
      feature.available && feature.upToDate === true ? h("span", { style: { ...styles.badge, ...styles.ok } }, t("channel.upToDate")) : null,
      feature.available && feature.upToDate === false ? h("span", { style: { ...styles.badge, ...styles.ok } }, t("channel.updateAvailable")) : null,
      feature.source === "official-link" ? h("span", { style: styles.badge }, t("channel.inferred")) : null,
      typeof feature.size === "number" ? h("span", { style: styles.hint }, `${t("sizeLabel")} ${formatSize(feature.size)}`) : null,
      feature.releaseDate ? h("span", { style: styles.hint }, `${t("releasedLabel")} ${formatDate(feature.releaseDate)}`) : null,
      feature.detail !== undefined && feature.available !== true ? h("span", { style: styles.hint }, feature.detail) : null,
    ])

    return h("div", { style: styles.wrap }, [
      h("p", { key: "lead", style: styles.lead }, t("lead")),

      // ---- installed build ------------------------------------------------
      h("div", { key: "install", style: styles.group }, [
        h("p", { key: "t", style: styles.groupTitle }, t("installTitle")),
        install.found === true
          ? h("div", { key: "kv", style: styles.kv }, [
            ...kvRow(t, "installApp", `${install.appVersion || t("unknown")}${install.packed ? ` · ${t("installPackaged")}` : ` · ${t("installUnpacked")}`}`),
            ...kvRow(t, "installDsh", install.bundledDshVersion),
            ...kvRow(t, "installRoot", install.root),
            ...kvRow(t, "installLauncher", install.launcher),
            ...kvRow(t, "installUpdater", install.updater === undefined ? undefined : `${install.updater.channel || "?"} → ${install.updater.url || "?"}`),
          ])
          : h("p", { key: "missing", style: styles.error }, t("installMissing")),
      ]),

      // ---- channel + check -------------------------------------------------
      h("div", { key: "update", style: styles.group }, [
        h("p", { key: "t", style: styles.groupTitle }, t("channelTitle")),
        h("div", { key: "seg", style: styles.segment }, ["stable", "beta", "nightly"].map(id =>
          h("button", {
            key: id,
            type: "button",
            style: { ...styles.segmentItem, ...(id === channel ? styles.segmentActive : {}) },
            disabled: downloading,
            onClick: () => pickChannel(id),
          }, t(`channel.${id}`)))),
        h("p", { key: "h", style: styles.hint }, t("channelHint")),

        h("div", { key: "actions", style: styles.row }, [
          button(busy === "check" ? t("checking") : t("check"), () => act("check", async () => {
            const payload = await call("check", {})
            setState(current => ({ ...current, lastResult: payload }))
          }), { primary: true, disabled: busy !== "" }),
          button(downloading ? t("downloading") : t("download"), () => act("download", async () => {
            const payload = await call("download", { channel })
            setDownload(payload.download)
          }), { disabled: busy !== "" || downloading }),
          downloading ? button(t("cancel"), () => act("cancel", async () => {
            await call("cancel", {})
          }), { disabled: busy !== "" }) : null,
        ]),

        channels.length > 0
          ? h("div", { key: "results", style: { display: "flex", flexDirection: "column", gap: "6px" } },
            channels.map(feature => channelRow(feature)))
          : h("p", { key: "idle", style: styles.hint }, t("checkFirst")),

        download !== null && download !== undefined
          ? h("div", { key: "dl", style: { display: "flex", flexDirection: "column", gap: "6px" } }, [
            h("div", { key: "bar", style: styles.bar }, [h("div", { key: "f", style: { ...styles.barFill, width: `${download.percent || 0}%` } })]),
            h("p", { key: "line", style: styles.hint }, [
              `${download.phase === "downloading" ? t("downloading") : download.phase === "verifying" ? t("verify") : download.phase === "done" ? t("downloadDone") : download.phase}`,
              ` · ${download.percent || 0}%`,
              download.total ? ` · ${formatSize(download.received)} / ${formatSize(download.total)}` : "",
              download.version ? ` · ${download.version}` : "",
            ].join("")),
            download.phase === "done" ? h("p", { key: "ok", style: styles.ok }, `${t("verified")}${download.verified === true ? "" : ` — ${t("notVerified")}`}`) : null,
            download.file ? h("p", { key: "f", style: styles.code }, `${t("downloadedTo")} ${download.file}`) : null,
            download.error ? h("p", { key: "err", style: styles.error }, download.error) : null,
            download.phase === "done" ? button(t("openFile"), () => act("open", async () => {
              await call("openFile", { file: download.file })
            }), { disabled: busy !== "" }) : null,
          ])
          : null,

        // ---- restart: directly below the update controls -------------------
        h("div", { key: "restart", style: { ...styles.row, marginTop: "6px", paddingTop: "10px", borderTop: "1px dashed rgba(128,128,128,.3)" } }, [
          button(t("restart"), () => {
            if (typeof window !== "undefined" && typeof window.confirm === "function") {
              if (!window.confirm(`${t("restart")}?\n\n${t("restartWarn")}`)) return
            }
            act("restart", async () => {
              const payload = await call("restart", { delayMs: (settings.restartDelayMs || 3000) })
              setNotice(payload.note || t("restarting"))
            })
          }, { primary: true, disabled: busy !== "" || downloading }),
        ]),
        h("p", { key: "rh", style: styles.hint }, t("restartHint")),
        h("p", { key: "rw", style: styles.hint }, t("restartWarn")),
      ]),

      // ---- settings --------------------------------------------------------
      h("div", { key: "settings", style: styles.group }, [
        h("p", { key: "t", style: styles.groupTitle }, t("settingsTitle")),
        h("div", { key: "dir", style: styles.row }, [
          h("span", { key: "l", style: styles.kvKey }, t("downloadDir")),
          h("input", {
            key: "i",
            style: styles.input,
            defaultValue: settings.downloadDir || "",
            disabled: downloading,
            onBlur: event => {
              const value = event.target.value
              if (value === (settings.downloadDir || "")) return
              act("settings", async () => {
                const payload = await call("settings", { settings: { downloadDir: value } })
                setState(current => ({ ...current, settings: payload.settings }))
              })
            },
          }),
        ]),
        h("div", { key: "root", style: styles.row }, [
          h("span", { key: "l", style: styles.kvKey }, t("installRootOverride")),
          h("input", {
            key: "i",
            style: styles.input,
            defaultValue: settings.installRoot || "",
            onBlur: event => {
              const value = event.target.value
              if (value === (settings.installRoot || "")) return
              act("settings", async () => {
                const payload = await call("settings", { settings: { installRoot: value } })
                setState(current => ({ ...current, settings: payload.settings, install: payload.install || current.install }))
              })
            },
          }),
        ]),
        h("p", { key: "rh", style: styles.hint }, t("installRootHint")),
        h("div", { key: "delay", style: styles.row }, [
          h("span", { key: "l", style: styles.kvKey }, t("restartDelay")),
          h("input", {
            key: "i",
            type: "number",
            min: 1,
            max: 60,
            style: { ...styles.input, minWidth: "80px", flex: "0 0 auto" },
            defaultValue: Math.round((settings.restartDelayMs || 3000) / 1000),
            onBlur: event => {
              const seconds = Number(event.target.value)
              if (!Number.isFinite(seconds) || seconds <= 0) return
              act("settings", async () => {
                const payload = await call("settings", { settings: { restartDelayMs: Math.round(seconds * 1000) } })
                setState(current => ({ ...current, settings: payload.settings }))
              })
            },
          }),
        ]),
      ]),

      // ---- status line -----------------------------------------------------
      h("div", { key: "status", style: styles.row }, [
        notice !== "" ? h("span", { key: "n", style: styles.ok }, notice) : null,
        error !== "" ? h("span", { key: "e", style: styles.error }, `${t("failed")}${error}`) : null,
        error !== "" ? button(t("retry"), () => refresh()) : null,
      ]),
      state.settingsPath ? h("p", { key: "p", style: styles.hint }, state.settingsPath) : null,
    ])
  }

  // -------------------------------------------------------------------------
  // Registration
  // -------------------------------------------------------------------------
  function apply(ctx) {
    ctx.effect(() => ctx.locale.register(NS, { zh, en }), "dsh-update-plus: dictionaries")
    const t = ctx.locale.bind(NS)
    translate = t
    ctx.slots.inject("settings.section", () => ctx.slots.register({
      name: "settings.section",
      id: "dsh-update-plus",
      // Below the host's own rows (its furthest sits at 40).
      order: 70,
      label: () => t("nav"),
      locale: NS,
      inject: () => ({ t }),
    }, SettingsRoot))
  }

  exports.name = name
  exports.inject = inject
  exports.apply = apply
  return module.exports
}})
