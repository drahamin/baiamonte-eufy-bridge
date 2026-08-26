const esc = (value) => String(value ?? "").replace(/[&<>"']/g, (char) => ({
  "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
}[char]));

class BaiamonteEufySecurityPanel extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: "open" });
    this._events = [];
    this._loading = false;
    this._error = "";
    this._rendered = false;
    this._objectUrls = [];
    this._liveCameras = new Set();
    this._liveTimers = new Map();
    this._visibilityHandler = () => {
      if (document.hidden) void this.stopAllLive();
    };
    this._snapshotBusy = false;
    this._days = 1;
    this._source = "hybrid";
  }

  set hass(value) {
    this._hass = value;
    if (!this._rendered) this.render();
    if (!this._cameraRegistryLoading && !this._cameraIds) this.loadCameraRegistry();
  }

  set panel(value) { this._panel = value; }

  connectedCallback() {
    document.addEventListener("visibilitychange", this._visibilityHandler);
  }

  disconnectedCallback() {
    document.removeEventListener("visibilitychange", this._visibilityHandler);
    void this.stopAllLive();
    this._objectUrls.forEach((url) => URL.revokeObjectURL(url));
    this._objectUrls = [];
  }

  liveLimit() {
    // Match the official phone app's single live view while preserving the E10
    // display's four-tile video wall on tablet/desktop-sized screens.
    return window.matchMedia("(max-width: 900px)").matches ? 1 : 4;
  }

  async stopLive(entityId, button = null, preview = null) {
    if (!this._liveCameras.has(entityId)) return;
    if (button) {
      button.disabled = true;
      button.textContent = "Stopping…";
    }
    const timer = this._liveTimers.get(entityId);
    if (timer) clearTimeout(timer);
    this._liveTimers.delete(entityId);
    this._liveCameras.delete(entityId);
    try {
      await this._hass?.callService("eufy_security", "stop_p2p_livestream", {}, { entity_id: entityId });
    } catch (_error) {
      // The bridge may already have stopped an expired P2P session.
    } finally {
      if (preview) preview.innerHTML = '<span class="camera-placeholder">Camera idle</span>';
      if (button) {
        button.textContent = "Live";
        button.disabled = false;
      }
    }
  }

  async stopAllLive() {
    const active = [...this._liveCameras];
    await Promise.allSettled(active.map((entityId) => this.stopLive(entityId)));
  }

  async loadEvents() {
    if (!this._hass || this._loading) return;
    const days = Number(this.shadowRoot.querySelector("#days")?.value || this._days);
    const source = this.shadowRoot.querySelector("#source")?.value || this._source;
    this._days = days;
    this._source = source;
    while (this._snapshotBusy) {
      await new Promise((resolve) => setTimeout(resolve, 250));
      if (!this.isConnected) return;
    }
    await this.stopAllLive();
    this._loading = true;
    this._error = "";
    this.render();
    try {
      const response = await this._hass.callWS({
        type: "call_service",
        domain: "eufy_security",
        service: "search_events",
        service_data: { days, source, max_results: 100 },
        return_response: true,
      });
      const result = response?.response ?? response;
      this._events = result?.events ?? [];
      this._summary = result;
    } catch (error) {
      this._error = error?.message || "The HomeBase evidence query failed";
    } finally {
      this._loading = false;
      this.render();
    }
  }

  async loadCameraRegistry() {
    this._cameraRegistryLoading = true;
    try {
      const entities = await this._hass.callWS({ type: "config/entity_registry/list" });
      this._cameraIds = new Set(entities
        .filter((entity) => entity.platform === "eufy_security" && entity.entity_id.startsWith("camera."))
        .map((entity) => entity.entity_id));
    } catch (_error) {
      this._cameraIds = new Set();
    } finally {
      this._cameraRegistryLoading = false;
      this.render();
    }
  }

  cameraEntities() {
    if (!this._hass) return [];
    return Object.values(this._hass.states)
      .filter((state) => state.entity_id.startsWith("camera."))
      .filter((state) => {
        if (this._cameraIds?.size) return this._cameraIds.has(state.entity_id);
        const text = `${state.entity_id} ${state.attributes?.friendly_name || ""}`.toLowerCase();
        return text.includes("eufy") || text.includes("homebase") || text.includes("dock");
      })
      .sort((a, b) => (a.attributes?.friendly_name || a.entity_id).localeCompare(b.attributes?.friendly_name || b.entity_id));
  }

  moreInfo(entityId) {
    this.dispatchEvent(new CustomEvent("hass-more-info", {
      bubbles: true, composed: true, detail: { entityId },
    }));
  }

  async loadProtectedImage(button) {
    button.disabled = true;
    button.textContent = "Loading…";
    try {
      const response = await this._hass.fetchWithAuth(button.dataset.image);
      if (!response.ok) throw new Error(`Image request returned ${response.status}`);
      const url = URL.createObjectURL(await response.blob());
      this._objectUrls.push(url);
      const image = document.createElement("img");
      image.alt = "Eufy evidence image";
      image.src = url;
      const figure = button.closest("figure");
      if (figure) figure.prepend(image);
      else button.closest(".media")?.prepend(image);
      button.remove();
    } catch (_error) {
      button.disabled = false;
      button.textContent = "Retry image";
    }
  }

  async loadVideo(button) {
    const media = button.closest(".media");
    button.disabled = true;
    button.textContent = "Downloading from HomeBase…";
    try {
      const response = await this._hass.fetchWithAuth(button.dataset.video);
      if (!response.ok) throw new Error(await response.text());
      const url = URL.createObjectURL(await response.blob());
      this._objectUrls.push(url);
      const video = document.createElement("video");
      video.controls = true;
      video.autoplay = true;
      video.src = url;
      media.replaceChildren(video);
    } catch (error) {
      button.disabled = false;
      button.textContent = error?.message || "Saved video unavailable";
    }
  }

  async startLive(entityId, button) {
    const preview = button.closest(".camera")?.querySelector(".camera-preview");
    if (this._liveCameras.has(entityId)) {
      await this.stopLive(entityId, button, preview);
      return;
    }
    const limit = this.liveLimit();
    if (limit === 1 && this._liveCameras.size) await this.stopAllLive();
    if (this._liveCameras.size >= limit) {
      button.textContent = `${limit} live feed${limit === 1 ? "" : "s"} maximum`;
      return;
    }
    if (this._snapshotBusy) {
      button.textContent = "Waiting for snapshot";
      setTimeout(() => {
        if (!this._liveCameras.has(entityId)) button.textContent = "Live";
      }, 2000);
      return;
    }
    const token = this._hass.states[entityId]?.attributes?.access_token;
    if (!token) {
      button.textContent = "Live token unavailable";
      return;
    }
    button.disabled = true;
    button.textContent = "Starting…";
    try {
      await this._hass.callService("eufy_security", "start_p2p_livestream", {}, { entity_id: entityId });
      this._liveCameras.add(entityId);
      const image = document.createElement("img");
      image.alt = this._hass.states[entityId]?.attributes?.friendly_name || entityId;
      image.src = `/api/camera_proxy_stream/${encodeURIComponent(entityId)}?token=${encodeURIComponent(token)}`;
      preview.replaceChildren(image);
      button.textContent = "Stop";
      this._liveTimers.set(entityId, setTimeout(() => {
        const card = [...this.shadowRoot.querySelectorAll(".camera")]
          .find((item) => item.dataset.entity === entityId);
        void this.stopLive(
          entityId,
          card?.querySelector(".live-button") || null,
          card?.querySelector(".camera-preview") || null,
        );
      }, 5 * 60 * 1000));
    } catch (error) {
      button.textContent = "Live failed — retry";
      preview.innerHTML = `<span class="camera-placeholder">${esc(error?.message || "Camera did not deliver media")}</span>`;
    } finally {
      button.disabled = false;
    }
  }

  async loadCameraSnapshot(card, button) {
    const entityId = card.dataset.entity;
    if (button.disabled || this._snapshotBusy || this._liveCameras.has(entityId)) return;
    const token = this._hass.states[entityId]?.attributes?.access_token;
    if (!token) {
      button.textContent = "Unavailable";
      return;
    }
    this._snapshotBusy = true;
    button.disabled = true;
    button.textContent = "Loading…";
    try {
      const path = `/api/camera_proxy/${encodeURIComponent(entityId)}?token=${encodeURIComponent(token)}`;
      const response = await this._hass.fetchWithAuth(path);
      if (!response.ok) throw new Error(`Snapshot returned ${response.status}`);
      const url = URL.createObjectURL(await response.blob());
      this._objectUrls.push(url);
      const image = document.createElement("img");
      image.alt = this._hass.states[entityId]?.attributes?.friendly_name || entityId;
      image.src = url;
      card.querySelector(".camera-preview").replaceChildren(image);
      button.textContent = "Refresh";
    } catch (_error) {
      button.textContent = "Retry snapshot";
    } finally {
      button.disabled = false;
      this._snapshotBusy = false;
    }
  }

  async staggerCameraSnapshots(generation) {
    const cards = [...this.shadowRoot.querySelectorAll(".camera")];
    for (const card of cards) {
      if (generation !== this._snapshotGeneration || !this.isConnected) return;
      while (this._loading) {
        await new Promise((resolve) => setTimeout(resolve, 1000));
        if (generation !== this._snapshotGeneration || !this.isConnected) return;
      }
      const button = card.querySelector(".snapshot-button");
      if (button && !this._liveCameras.has(card.dataset.entity)) {
        await this.loadCameraSnapshot(card, button);
      }
      await new Promise((resolve) => setTimeout(resolve, 2000));
    }
  }

  render() {
    if (!this._hass) return;
    this._rendered = true;
    const cameras = this.cameraEntities();
    const events = this._events.map((event) => {
      const when = event.start ? new Date(event.start).toLocaleString() : "Time unavailable";
      const ai = event.ai || {};
      const categories = (ai.categories || event.ai_categories || []).map((item) => `<span>${esc(item)}</span>`).join("");
      const aiImages = [...(ai.faces || []), ...(ai.crops || [])]
        .filter((item) => item.image_url)
        .map((item) => `<figure><button class="protected-image-load" data-image="${esc(item.image_url)}">AI image</button><figcaption>${esc(item.recognition || (item.recognized ? "recognized" : (item.categories || []).join(", ")) || "AI crop")}</figcaption></figure>`)
        .join("");
      const thumbnail = event.thumbnail_url
        ? `<button class="protected-image-load" data-image="${esc(event.thumbnail_url)}">Load thumbnail</button>`
        : `<div class="nomedia">${event.video_url ? "Saved HomeBase recording" : "No retrievable media"}</div>`;
      const media = `${thumbnail}${event.video_url ? `<button class="video-load" data-video="${esc(event.video_url)}">Load saved video</button>` : ""}`;
      return `<article class="event-card">
        <div class="media">${media}</div>
        <div class="event-copy"><div class="event-head"><strong>${esc(event.device_name || "Eufy camera")}</strong><time>${esc(when)}</time></div>
        <div class="chips">${categories || "<span>motion event</span>"}</div>
        ${aiImages ? `<div class="ai-images">${aiImages}</div>` : ""}
        <p>${esc(event.source)} · ${esc(event.storage)}${event.favorite ? " · favorite" : ""}${event.viewed ? " · viewed" : ""}</p>
        <details><summary>Complete AI details</summary><pre>${esc(JSON.stringify(ai, null, 2))}</pre></details></div>
      </article>`;
    }).join("");
    const live = cameras.map((camera) => {
      return `<article class="camera" data-entity="${esc(camera.entity_id)}">
        <div class="camera-preview"><span class="camera-placeholder">Camera idle</span></div>
        <div class="camera-foot"><strong>${esc(camera.attributes?.friendly_name || camera.entity_id)}</strong><div><button class="snapshot-button">Snapshot</button><button class="live-button">Live</button><button class="more-button">Controls</button></div></div>
      </article>`;
    }).join("");
    this.shadowRoot.innerHTML = `<style>
      :host{display:block;min-height:100%;background:var(--primary-background-color);color:var(--primary-text-color);font-family:var(--paper-font-body1_-_font-family,system-ui);padding:env(safe-area-inset-top) env(safe-area-inset-right) env(safe-area-inset-bottom) env(safe-area-inset-left)}
      *{box-sizing:border-box}main{max-width:1500px;margin:auto;padding:20px}.hero{display:flex;justify-content:space-between;gap:18px;align-items:end;margin-bottom:18px}h1{font-size:clamp(25px,4vw,42px);margin:0}.sub{color:var(--secondary-text-color);margin:6px 0 0}.toolbar{display:flex;gap:10px;flex-wrap:wrap;align-items:end}.field{display:grid;gap:5px;color:var(--secondary-text-color);font-size:13px}select,button{font:inherit}select,.load{height:42px;border-radius:11px;border:1px solid var(--divider-color);background:var(--card-background-color);color:var(--primary-text-color);padding:0 14px}.load{background:var(--primary-color);color:var(--text-primary-color);border:0;font-weight:700;cursor:pointer}.section{margin:24px 0 10px}.section h2{margin:0 0 4px}.live{display:grid;grid-template-columns:repeat(auto-fit,minmax(260px,1fr));gap:12px}.camera{padding:0;border:1px solid var(--divider-color);border-radius:16px;overflow:hidden;background:var(--card-background-color);color:var(--primary-text-color)}.camera-preview{width:100%;aspect-ratio:16/9;display:grid;place-items:center;background:#05070a}.camera-preview img{width:100%;height:100%;object-fit:cover;display:block}.camera-placeholder{color:#8e98a9;font-size:13px}.camera-foot{display:flex;align-items:center;justify-content:space-between;gap:8px;padding:9px 11px}.camera-foot button,.video-load{border:0;border-radius:9px;padding:8px 10px;margin-left:5px;background:color-mix(in srgb,var(--primary-color) 16%,var(--card-background-color));color:var(--primary-color);font-weight:700;cursor:pointer}.events{display:grid;gap:14px}.event-card{display:grid;grid-template-columns:minmax(260px,40%) 1fr;border:1px solid var(--divider-color);border-radius:17px;overflow:hidden;background:var(--card-background-color)}.media{position:relative;background:#05070a;min-height:180px;display:grid;place-items:center}.media img,.media video{width:100%;height:100%;max-height:430px;object-fit:contain}.media .video-load{position:absolute;bottom:12px;left:12px;background:rgba(12,18,28,.86);color:#fff}.nomedia{color:#99a2b3}.event-copy{padding:16px;min-width:0}.event-head{display:flex;justify-content:space-between;gap:10px}.event-head time,.event-copy p{color:var(--secondary-text-color);font-size:13px}.chips{display:flex;flex-wrap:wrap;gap:6px;margin:11px 0}.chips span{padding:4px 8px;border-radius:999px;background:color-mix(in srgb,var(--primary-color) 15%,transparent);color:var(--primary-color);font-size:12px;font-weight:700}.ai-images{display:flex;gap:8px;overflow:auto;margin:8px 0}.ai-images figure{margin:0;min-width:84px}.ai-images img{width:84px;height:84px;object-fit:cover;border-radius:10px;background:#05070a}.ai-images figcaption{font-size:11px;color:var(--secondary-text-color);max-width:84px}details{border-top:1px solid var(--divider-color);padding-top:10px}summary{cursor:pointer;font-weight:650}pre{white-space:pre-wrap;word-break:break-word;color:var(--secondary-text-color);font-size:12px}.status{padding:24px;border:1px dashed var(--divider-color);border-radius:15px;color:var(--secondary-text-color)}.error{color:var(--error-color)}
      .protected-image-load{border:0;border-radius:9px;padding:9px 12px;background:rgba(12,18,28,.86);color:#fff;font-weight:700;cursor:pointer}
      @media(max-width:720px){main{padding:14px}.hero{align-items:start;display:grid}.event-card{grid-template-columns:1fr}.live{grid-template-columns:1fr}.event-head{display:grid}}
    </style><main>
      <div class="hero"><div><h1>Baiamonte Eufy Security</h1><p class="sub">HomeBase DVR, live cameras, prior events, snapshots, and complete useful AI evidence.</p></div>
      <div class="toolbar"><label class="field">History<select id="days"><option value="1" ${this._days === 1 ? "selected" : ""}>24 hours</option><option value="3" ${this._days === 3 ? "selected" : ""}>3 days</option><option value="7" ${this._days === 7 ? "selected" : ""}>7 days</option><option value="14" ${this._days === 14 ? "selected" : ""}>14 days</option><option value="31" ${this._days === 31 ? "selected" : ""}>31 days</option></select></label><label class="field">Index<select id="source"><option value="hybrid" ${this._source === "hybrid" ? "selected" : ""}>Cloud + HomeBase</option><option value="cloud" ${this._source === "cloud" ? "selected" : ""}>Account cloud</option><option value="local" ${this._source === "local" ? "selected" : ""}>HomeBase local</option></select></label><button class="load" id="load">${this._loading ? "Loading…" : "Load events"}</button></div></div>
      <section class="section"><h2>Live DVR view</h2><p class="sub">${cameras.length} Eufy cameras. Phone view runs one live camera; wide displays support up to four. Feeds stop after five minutes or when this tab is hidden. Controls opens native streaming, PTZ, presets and device actions.</p></section>
      <div class="live">${live || '<div class="status">Waiting for Eufy camera entities.</div>'}</div>
      <section class="section"><h2>Evidence timeline</h2><p class="sub">${this._summary ? `${this._summary.count || 0} indexed events · ${(this._summary.local_homebase_models || []).join(", ") || "account index"}${(this._summary.warnings || []).length ? ` · fallback: ${(this._summary.warnings || []).join(", ")}` : ""}` : "Choose a window and load prior events."}</p></section>
      <div class="events">${this._error ? `<div class="status error">${esc(this._error)}</div>` : this._loading ? '<div class="status">Querying the authenticated account and HomeBase indexes…</div>' : events || '<div class="status">No events loaded.</div>'}</div>
    </main>`;
    this.shadowRoot.querySelector("#load")?.addEventListener("click", () => this.loadEvents());
    this.shadowRoot.querySelectorAll(".video-load").forEach((button) => button.addEventListener("click", () => this.loadVideo(button)));
    this.shadowRoot.querySelectorAll(".protected-image-load").forEach((button) => button.addEventListener("click", () => this.loadProtectedImage(button)));
    this.shadowRoot.querySelectorAll(".camera").forEach((card) => {
      card.querySelector(".more-button")?.addEventListener("click", () => this.moreInfo(card.dataset.entity));
      card.querySelector(".snapshot-button")?.addEventListener("click", (event) => this.loadCameraSnapshot(card, event.currentTarget));
      card.querySelector(".live-button")?.addEventListener("click", (event) => void this.startLive(card.dataset.entity, event.currentTarget));
    });
    const snapshotGeneration = (this._snapshotGeneration || 0) + 1;
    this._snapshotGeneration = snapshotGeneration;
    setTimeout(() => this.staggerCameraSnapshots(snapshotGeneration), 1000);
  }
}

customElements.define("baiamonte-eufy-security-panel", BaiamonteEufySecurityPanel);
