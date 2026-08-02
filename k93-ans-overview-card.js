
const IMPORTANCE_LEVELS = ["low", "normal", "high", "critical"];

const BUILTIN_CHANNEL_KEYS = ["info", "alert", "event", "reminder", "security", "system"];

const LOCALE_TAG = { en: "en", no: "nb-NO" };

const STRINGS = {
  en: {
    unacknowledged: "Unacknowledged",
    history: "History",
    nothing: "Nothing to show",
    acknowledge: "Acknowledge",
    delete: "Delete",
    clear_history: "Clear",
    confirm_clear_history: "Clear all history? This can't be undone.",
    today: "Today",
    yesterday: "Yesterday",
    importance: { low: "Low", normal: "Normal", high: "High", critical: "Critical" },
  },
  no: {
    unacknowledged: "Ikke bekreftet",
    history: "Historikk",
    nothing: "Ingenting å vise",
    acknowledge: "Bekreft",
    delete: "Slett",
    clear_history: "Tøm",
    confirm_clear_history: "Tøm all historikk? Dette kan ikke angres.",
    today: "I dag",
    yesterday: "I går",
    importance: { low: "Lav", normal: "Normal", high: "Høy", critical: "Kritisk" },
  },
};

function esc(value) {
  return String(value ?? "").replace(/[&<>"']/g, (c) => (
    { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]
  ));
}

function importanceRank(level) {
  const idx = IMPORTANCE_LEVELS.indexOf(level);
  return idx === -1 ? IMPORTANCE_LEVELS.indexOf("normal") : idx;
}

function matchesFilter(record, channels, minImportance, channelMode) {
  if (record.show_in_history === false) return false;
  const hasList = Boolean(channels && channels.length);
  const recordChannels = (Array.isArray(record.channels) && record.channels.length
    ? record.channels
    : [record.channel]
  ).map((c) => String(c || "").toLowerCase());
  const inList = hasList && channels.some((c) => recordChannels.includes(String(c).toLowerCase()));
  const channelOk = channelMode === "exclude" ? !inList : !hasList || inList;
  const importanceOk = importanceRank(record.importance) >= importanceRank(minImportance || "low");
  return channelOk && importanceOk;
}

function formatRelativeTime(iso, locale, lang) {
  if (!iso) return "";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;

  const strings = STRINGS[lang] || STRINGS.en;
  const time = date.toLocaleTimeString(locale, { hour: "2-digit", minute: "2-digit" });
  const startOfDay = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const diffDays = Math.round((startOfDay(new Date()) - startOfDay(date)) / 86400000);

  if (diffDays === 0) return `${strings.today} ${time}`;
  if (diffDays === 1) return `${strings.yesterday} ${time}`;
  if (diffDays > 1 && diffDays < 7) return `${date.toLocaleDateString(locale, { weekday: "long" })} ${time}`;
  return `${date.toLocaleDateString(locale)} ${time}`;
}

class K93AnsOverviewCard extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: "open" });
    this._notifications = [];
    this._subscribed = false;
    this._unsubscribe = null;
    this._lightboxSrc = null;

    this.shadowRoot.addEventListener("click", (event) => {
      const ackButton = event.target.closest("[data-ack-id]");
      if (ackButton) {
        this._acknowledge(ackButton.dataset.ackId);
        return;
      }
      const deleteButton = event.target.closest("[data-delete-id]");
      if (deleteButton) {
        this._delete(deleteButton.dataset.deleteId);
        return;
      }
      if (event.target.closest("[data-clear-history]")) {
        this._clearHistory();
        return;
      }
      const lightboxTrigger = event.target.closest("[data-lightbox-src]");
      if (lightboxTrigger) {
        this._lightboxSrc = lightboxTrigger.dataset.lightboxSrc;
        this._render();
        return;
      }
      if (event.target.closest("[data-lightbox-close]")) {
        this._lightboxSrc = null;
        this._render();
      }
    });
  }

  setConfig(config) {
    this._config = {
      title: "Notifications",
      title_icon: null,
      title_font_size: 1.1,
      title_icon_size: 24,
      title_icon_color: null,
      title_icon_background: null,
      language: "auto",
      show_unacknowledged: true,
      show_history: true,
      show_channel: true,
      show_importance: true,
      show_clear_history: true,
      show_delete_button: true,
      image_display_mode: "thumbnail",
      history_channels: [],
      history_channels_mode: "include",
      history_min_importance: "low",
      show_ticker: false,
      ticker_limit: 10,
      ticker_font_size: 0.85,
      ticker_speed: 1,
      max_items: 50,
      card_height: null,
      card_background_color: null,
      card_border_radius: null,
      card_border_color: null,
      card_border_width: null,
      ...config,
    };
    this._render();
  }

  set hass(hass) {
    this._hass = hass;
    if (!this._subscribed) {
      this._subscribed = true;
      this._subscribe();
      this._fetchList();
      this._render();
    }
  }

  _lang() {
    const configured = this._config?.language;
    if (configured && configured !== "auto") return configured;
    const hassLang = this._hass?.language || "";
    return /^n[bno]/i.test(hassLang) ? "no" : "en";
  }

  _t(key) {
    const strings = STRINGS[this._lang()] || STRINGS.en;
    return strings[key] ?? STRINGS.en[key] ?? key;
  }

  getCardSize() {
    const cfg = this._config;
    if (cfg?.card_height) {
      return Math.max(1, Math.round(cfg.card_height / 50));
    }
    if (!cfg?.show_unacknowledged && !cfg?.show_history) {
      return cfg?.show_ticker ? 2 : 1;
    }
    const base = cfg?.show_ticker ? 3 : 2;
    return base + Math.min(this._notifications.length, cfg?.max_items ?? 5);
  }

  disconnectedCallback() {
    if (this._unsubscribe) {
      this._unsubscribe();
      this._unsubscribe = null;
      this._subscribed = false;
    }
  }

  async _subscribe() {
    try {
      this._unsubscribe = await this._hass.connection.subscribeMessage(
        (msg) => {
          if (msg.notification) this._onUpdate(msg.notification);
          if (msg.deleted_ids) this._onDelete(msg.deleted_ids);
        },
        { type: "k93_ans/subscribe" }
      );
    } catch (err) {
      console.error("k93-ans-overview-card: failed to subscribe", err);
    }
  }

  async _fetchList() {
    try {
      const cfg = this._config || {};
      const limit = cfg.max_items ?? 50;
      const fetches = [
        this._hass.callWS({ type: "k93_ans/list", include_acknowledged: true, limit }),
      ];
      if (cfg.history_channels && cfg.history_channels.length) {
        fetches.push(
          this._hass.callWS({
            type: "k93_ans/list",
            include_acknowledged: true,
            limit,
            channels: cfg.history_channels,
            channel_mode: cfg.history_channels_mode || "include",
            min_importance: cfg.history_min_importance,
          })
        );
      }
      const results = await Promise.all(fetches);
      const byId = new Map();
      for (const result of results) {
        for (const record of result.notifications) byId.set(record.id, record);
      }
      this._notifications = [...byId.values()].sort(
        (a, b) => new Date(b.created) - new Date(a.created)
      );
      this._render();
    } catch (err) {
      console.error("k93-ans-overview-card: failed to load notifications", err);
    }
  }

  _onUpdate(record) {
    const idx = this._notifications.findIndex((n) => n.id === record.id);
    if (idx >= 0) {
      this._notifications = [
        ...this._notifications.slice(0, idx),
        record,
        ...this._notifications.slice(idx + 1),
      ];
    } else {
      this._notifications = [record, ...this._notifications];
    }
    this._render();
  }

  _onDelete(deletedIds) {
    const idSet = new Set(deletedIds);
    this._notifications = this._notifications.filter((n) => !idSet.has(n.id));
    this._render();
  }

  async _acknowledge(notificationId) {
    try {
      await this._hass.callWS({ type: "k93_ans/acknowledge", notification_id: notificationId });
    } catch (err) {
      console.error("k93-ans-overview-card: failed to acknowledge", err);
    }
  }

  async _delete(notificationId) {
    try {
      await this._hass.callWS({ type: "k93_ans/delete", notification_ids: [notificationId] });
    } catch (err) {
      console.error("k93-ans-overview-card: failed to delete", err);
    }
  }

  async _clearHistory() {
    if (!window.confirm(this._t("confirm_clear_history"))) return;
    try {
      await this._hass.callWS({ type: "k93_ans/clear_history", include_unacknowledged: false });
    } catch (err) {
      console.error("k93-ans-overview-card: failed to clear history", err);
    }
  }

  _channelColor(record) {
    const hass = this._hass;
    if (!hass) return "";
    const cached = this._channelSensorId && hass.states[this._channelSensorId];
    const channels = cached
      ? cached.attributes.channels
      : (() => {
          for (const stateObj of Object.values(hass.states)) {
            if (stateObj.entity_id.startsWith("sensor.k93_ans") && Array.isArray(stateObj.attributes?.channels)) {
              this._channelSensorId = stateObj.entity_id;
              return stateObj.attributes.channels;
            }
          }
          return null;
        })();
    if (!Array.isArray(channels)) return "";
    const recordChannel = String(record.channel || "").toLowerCase();
    const match = channels.find((c) => String(c.key).toLowerCase() === recordChannel);
    return (match && match.color) || "";
  }

  _renderItem(record, locale) {
    const imageMode = this._config.image_display_mode || "thumbnail";
    const showThumbnail = Boolean(record.image) && imageMode === "thumbnail";
    const showFullImage = Boolean(record.image) && imageMode === "full";

    let leftHtml;
    if (showThumbnail) {
      leftHtml = `<img class="row-image" data-lightbox-src="${esc(record.image)}" src="${esc(record.image)}" alt="" loading="lazy" />`;
    } else {
      const icon = record.icon || "mdi:bell-outline";
      const channelColor = this._channelColor(record);
      leftHtml = icon.startsWith("mdi:")
        ? `<ha-icon icon="${esc(icon)}"${channelColor ? ` style="color: ${esc(channelColor)};"` : ""}></ha-icon>`
        : `<img class="thumb" src="${esc(icon)}" alt="" />`;
    }

    const fullImageHtml = showFullImage
      ? `<img class="row-image-full" data-lightbox-src="${esc(record.image)}" src="${esc(record.image)}" alt="" loading="lazy" />`
      : "";

    const ackButton = (record.requires_ack && !record.acknowledged)
      ? `<button class="ack" data-ack-id="${esc(record.id)}">${esc(this._t("acknowledge"))}</button>`
      : "";

    const deleteButton = (this._config.show_delete_button && (!record.requires_ack || record.acknowledged))
      ? `<button class="delete" data-delete-id="${esc(record.id)}" title="${esc(this._t("delete"))}" aria-label="${esc(this._t("delete"))}"><ha-icon icon="mdi:trash-can-outline"></ha-icon></button>`
      : "";

    const importanceHtml = this._config.show_importance
      ? (() => {
          const label = (STRINGS[this._lang()] || STRINGS.en).importance[record.importance]
            || record.importance;
          return `<span class="importance importance-${esc(record.importance)}">${esc(label)}</span>`;
        })()
      : "";

    const metaParts = [];
    if (this._config.show_channel) {
      const channelLabel = Array.isArray(record.channels) && record.channels.length
        ? record.channels.join(", ")
        : record.channel;
      metaParts.push(esc(channelLabel));
    }
    metaParts.push(esc(formatRelativeTime(record.created, locale, this._lang())));

    return `
      <div class="item">
        <div class="icon${showThumbnail ? " icon-image" : ""}">${leftHtml}</div>
        <div class="body">
          <div class="row1">
            <span class="title">${esc(record.title)}</span>
            ${importanceHtml}
          </div>
          <div class="message">${esc(record.message)}</div>
          <div class="meta">${metaParts.join(" &middot; ")}</div>
          ${fullImageHtml}
        </div>
        ${ackButton}${deleteButton}
      </div>
    `;
  }

  _renderLightbox() {
    if (!this._lightboxSrc) return "";
    return `
      <div class="lightbox-overlay" data-lightbox-close>
        <img class="lightbox-image" src="${esc(this._lightboxSrc)}" alt="" />
      </div>
    `;
  }

  _titleIconHtml() {
    const cfg = this._config;
    if (!cfg.title_icon) return "";
    const size = Number(cfg.title_icon_size) || 24;
    const color = cfg.title_icon_color || "var(--primary-text-color)";
    const background = cfg.title_icon_background || "transparent";
    return `
      <span class="title-icon" style="width: ${size}px; height: ${size}px; background: ${esc(background)};">
        <ha-icon icon="${esc(cfg.title_icon)}" style="color: ${esc(color)}; --mdc-icon-size: ${Math.round(size * 0.6)}px;"></ha-icon>
      </span>
    `;
  }

  _tickerItemHtml(record, locale, lang) {
    const icon = record.icon || "mdi:bell-outline";
    const channelColor = this._channelColor(record);
    const iconHtml = icon.startsWith("mdi:")
      ? `<ha-icon class="ticker-icon" icon="${esc(icon)}"${channelColor ? ` style="color: ${esc(channelColor)};"` : ""}></ha-icon>`
      : `<img class="ticker-icon-img" src="${esc(icon)}" alt="" />`;
    return (
      `<span class="ticker-item">${iconHtml}` +
      `<span class="ticker-text">${esc(formatRelativeTime(record.created, locale, lang))} : ${esc(record.message)}</span></span>`
    );
  }

  _renderTicker(locale, lang) {
    const cfg = this._config;
    if (!cfg.show_ticker) return "";

    const items = (this._notifications || [])
      .filter((n) => matchesFilter(n, cfg.history_channels, cfg.history_min_importance, cfg.history_channels_mode))
      .slice(0, cfg.ticker_limit ?? 10);

    if (!items.length) return "";

    const sep = `<span class="ticker-sep">&bull;</span>`;
    const group = items.map((n) => this._tickerItemHtml(n, locale, lang)).join(sep) + sep;
    const speed = Number(cfg.ticker_speed) || 1;
    const BASE_LOOP_SECONDS = Math.min(items.length * 5, 120);
    const duration = Math.max(4, BASE_LOOP_SECONDS / speed);
    const fontSize = Number(cfg.ticker_font_size) || 0.85;

    const iconHtml = this._titleIconHtml();

    return `
      <div class="ticker-wrap">
        ${iconHtml}
        <div class="ticker-viewport">
          <div class="ticker-track" style="animation-duration: ${duration}s; font-size: ${fontSize}em;">
            ${group}${group}
          </div>
        </div>
      </div>
    `;
  }

  _render() {
    if (!this.shadowRoot || !this._config) return;

    const cfg = this._config;
    const lang = this._lang();
    const locale = LOCALE_TAG[lang] || undefined;
    const all = this._notifications || [];
    const unacknowledged = all.filter(
      (n) => n.requires_ack && !n.acknowledged && n.show_in_history !== false
    );
    const history = all.filter((n) => matchesFilter(n, cfg.history_channels, cfg.history_min_importance, cfg.history_channels_mode));

    const sections = [];
    if (cfg.show_unacknowledged) {
      sections.push({
        key: "unacknowledged",
        label: `${this._t("unacknowledged")}${unacknowledged.length ? ` (${unacknowledged.length})` : ""}`,
        items: unacknowledged,
      });
    }
    if (cfg.show_history) {
      sections.push({ key: "history", label: this._t("history"), items: history });
    }

    const body = sections
      .map((section) => {
        const clearButton = (section.key === "history" && cfg.show_clear_history && section.items.length)
          ? `<button class="clear-history" data-clear-history>${esc(this._t("clear_history"))}</button>`
          : "";
        return `
          <div class="section">
            <div class="section-title-row">
              <div class="section-title">${esc(section.label)}</div>
              ${clearButton}
            </div>
            ${
              section.items.length
                ? section.items.map((item) => this._renderItem(item, locale)).join("")
                : `<div class="empty">${esc(this._t("nothing"))}</div>`
            }
          </div>
        `;
      })
      .join("");

    const tickerHtml = this._renderTicker(locale, lang);
    const iconInTicker = Boolean(cfg.show_ticker && cfg.title_icon && tickerHtml);
    const headerIconHtml = iconInTicker ? "" : this._titleIconHtml();

    const cardThemeStyles = [];
    if (cfg.card_height) cardThemeStyles.push(`height: ${Number(cfg.card_height)}px`);
    if (cfg.card_background_color) cardThemeStyles.push(`background: ${cfg.card_background_color}`);
    if (cfg.card_border_radius != null && cfg.card_border_radius !== "") {
      cardThemeStyles.push(`border-radius: ${Number(cfg.card_border_radius)}px`);
    }
    if (cfg.card_border_color || (cfg.card_border_width != null && cfg.card_border_width !== "")) {
      cardThemeStyles.push(`border-style: solid`);
      if (cfg.card_border_color) cardThemeStyles.push(`border-color: ${cfg.card_border_color}`);
      if (cfg.card_border_width != null && cfg.card_border_width !== "") {
        cardThemeStyles.push(`border-width: ${Number(cfg.card_border_width)}px`);
      }
    }
    if (!this._built) {
      this.shadowRoot.innerHTML = `
      <style>
        :host { display: block; }

        /* No background/border/box-shadow overrides in this stylesheet: by default ha-card's own
           theme-driven styling is left untouched, which is what makes the card look like a native
           part of the dashboard instead of a custom skin. card_background_color/card_border_*
           are opt-in overrides applied as an inline style attribute directly on <ha-card> instead
           (see cardThemeStyles below) - a plain style attribute on a custom element's host always
           wins over that element's own internal :host{} rules, which is also how tools like
           card-mod work. */
        ha-card {
          display: flex;
          flex-direction: column;
          overflow: hidden;
        }

        .card-header {
          flex: 0 0 auto;
          display: flex;
          align-items: center;
          gap: 8px;
          padding: 16px 16px 8px;
          font-weight: 500;
        }
        .title-icon {
          display: inline-flex;
          align-items: center;
          justify-content: center;
          border-radius: 999px;
          flex-shrink: 0;
        }

        .ticker-wrap {
          flex: 0 0 auto;
          display: flex;
          align-items: center;
          gap: 8px;
          width: 100%;
          padding: 10px 16px;
          border-bottom: 1px solid var(--divider-color);
          box-sizing: border-box;
        }
        .ticker-viewport {
          flex: 1 1 auto;
          min-width: 0;
          overflow: hidden;
          white-space: nowrap;
          /* Fades the scrolling text to transparent at both edges of the viewport (fixed
             positions, not tied to scroll offset) instead of clipping it abruptly. */
          -webkit-mask-image: linear-gradient(to right, transparent 0, black 24px, black calc(100% - 24px), transparent 100%);
          mask-image: linear-gradient(to right, transparent 0, black 24px, black calc(100% - 24px), transparent 100%);
        }
        .ticker-track {
          display: inline-block;
          white-space: nowrap;
          animation-name: k93-ticker;
          animation-timing-function: linear;
          animation-iteration-count: infinite;
          color: var(--primary-text-color);
          line-height: 1.4;
        }
        .ticker-item {
          display: inline-flex;
          align-items: center;
          gap: 6px;
          line-height: 1;
          vertical-align: middle;
        }
        .ticker-text {
          display: inline-flex;
          align-items: center;
          line-height: 1;
        }
        .ticker-icon {
          --mdc-icon-size: 1em;
          display: inline-flex;
          align-items: center;
          justify-content: center;
          width: 1em;
          height: 1em;
          color: var(--primary-text-color);
          flex-shrink: 0;
        }
        .ticker-icon-img {
          display: inline-block;
          width: 1em;
          height: 1em;
          border-radius: 50%;
          object-fit: cover;
          flex-shrink: 0;
          vertical-align: middle;
        }
        .ticker-sep {
          display: inline-flex;
          align-items: center;
          margin: 0 12px;
          opacity: 0.5;
        }
        @keyframes k93-ticker {
          from { transform: translateX(0); }
          to { transform: translateX(-50%); }
        }

        .scroll-area {
          flex: 1 1 auto;
          min-height: 0;
          overflow-y: auto;
          scrollbar-width: thin;
        }
        .scroll-area:empty { display: none; }

        .section-title-row {
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 8px;
          padding: 10px 12px 6px 16px;
        }
        .section-title {
          font-size: 0.78em;
          font-weight: 700;
          text-transform: uppercase;
          letter-spacing: 0.6px;
          color: var(--secondary-text-color);
        }
        .clear-history {
          border: none;
          border-radius: 8px;
          padding: 3px 8px;
          font-size: 0.72em;
          font-weight: 600;
          color: var(--secondary-text-color);
          background: transparent;
          cursor: pointer;
          transition: background 0.15s ease, color 0.15s ease;
        }
        .clear-history:hover {
          background: color-mix(in srgb, var(--error-color, #ff453a) 12%, transparent);
          color: var(--error-color, #ff453a);
        }
        .empty {
          padding: 4px 16px 14px;
          color: var(--secondary-text-color);
          font-size: 0.9em;
        }
        .item {
          display: flex;
          align-items: flex-start;
          gap: 12px;
          padding: 10px 16px;
          border-bottom: 1px solid var(--divider-color);
          transition: background 0.15s ease;
        }
        .item:hover { background: color-mix(in srgb, var(--primary-text-color, #000) 4%, transparent); }
        .icon {
          display: flex;
          align-items: center;
          justify-content: center;
          width: 24px;
          height: 24px;
          color: var(--secondary-text-color);
          flex-shrink: 0;
          margin-top: 2px;
        }
        .thumb { width: 22px; height: 22px; border-radius: 5px; object-fit: cover; }
        /* A picture (record.image) gets a bigger box than the plain icon slot, sized to the
           image's own aspect ratio (max-width/max-height with natural width/height) rather than
           object-fit: cover, so nothing about it is cropped. */
        .icon-image { width: auto; height: auto; max-width: 64px; max-height: 64px; }
        .row-image {
          display: block;
          max-width: 64px;
          max-height: 64px;
          width: auto;
          height: auto;
          border-radius: 8px;
          cursor: zoom-in;
        }
        .row-image-full {
          display: block;
          width: 100%;
          max-width: 100%;
          height: auto;
          border-radius: 8px;
          margin-top: 8px;
          cursor: zoom-in;
        }
        .lightbox-overlay {
          position: fixed;
          inset: 0;
          background: rgba(0, 0, 0, 0.85);
          display: flex;
          align-items: center;
          justify-content: center;
          padding: 24px;
          box-sizing: border-box;
          z-index: 1000;
          cursor: zoom-out;
        }
        .lightbox-image {
          max-width: 100%;
          max-height: 100%;
          border-radius: 8px;
          box-shadow: 0 8px 32px rgba(0, 0, 0, 0.5);
        }
        .body { flex: 1; min-width: 0; }
        .row1 { display: flex; justify-content: space-between; gap: 8px; align-items: baseline; }
        .title {
          flex: 1;
          min-width: 0;
          font-weight: 600;
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
        }
        .importance {
          flex-shrink: 0;
          font-size: 0.72em;
          white-space: nowrap;
          color: var(--secondary-text-color);
        }
        .importance-high, .importance-critical { color: var(--error-color, #ff453a); }
        .message { color: var(--primary-text-color); font-size: 0.95em; margin-top: 2px; }
        .meta { color: var(--secondary-text-color); font-size: 0.78em; margin-top: 4px; }
        .ack {
          align-self: center;
          border: none;
          border-radius: 8px;
          padding: 6px 12px;
          font-size: 0.78em;
          font-weight: 600;
          color: var(--primary-color, #0a84ff);
          cursor: pointer;
          background: color-mix(in srgb, var(--primary-color, #0a84ff) 12%, transparent);
          transition: background 0.15s ease;
          flex-shrink: 0;
        }
        .ack:hover { background: color-mix(in srgb, var(--primary-color, #0a84ff) 20%, transparent); }
        .delete {
          align-self: center;
          display: flex;
          align-items: center;
          justify-content: center;
          border: none;
          border-radius: 8px;
          padding: 6px;
          color: var(--secondary-text-color);
          background: transparent;
          cursor: pointer;
          transition: background 0.15s ease, color 0.15s ease;
          flex-shrink: 0;
        }
        .delete ha-icon { --mdc-icon-size: 18px; }
        .delete:hover {
          background: color-mix(in srgb, var(--error-color, #ff453a) 12%, transparent);
          color: var(--error-color, #ff453a);
        }
      </style>
      <ha-card>
        <div class="ticker-host"></div>
        <div class="card-header"></div>
        <div class="scroll-area"></div>
      </ha-card>
      <div class="lightbox-host"></div>
      `;
      this._built = true;
      this._cardEl = this.shadowRoot.querySelector("ha-card");
      this._tickerHostEl = this.shadowRoot.querySelector(".ticker-host");
      this._headerEl = this.shadowRoot.querySelector(".card-header");
      this._scrollAreaEl = this.shadowRoot.querySelector(".scroll-area");
      this._lightboxHostEl = this.shadowRoot.querySelector(".lightbox-host");
    }

    if (cardThemeStyles.length) {
      this._cardEl.setAttribute("style", cardThemeStyles.join("; "));
    } else {
      this._cardEl.removeAttribute("style");
    }

    if (tickerHtml !== this._lastTickerHtml) {
      this._lastTickerHtml = tickerHtml;
      this._tickerHostEl.innerHTML = tickerHtml;
    }

    this._headerEl.setAttribute("style", `font-size: ${Number(cfg.title_font_size) || 1.1}em;`);
    this._headerEl.innerHTML = `${headerIconHtml}<span>${esc(cfg.title)}</span>`;

    this._scrollAreaEl.innerHTML = body;
    this._lightboxHostEl.innerHTML = this._renderLightbox();
  }

  static getStubConfig() {
    return {
      title: "Notifications",
      title_icon: null,
      title_font_size: 1.1,
      title_icon_size: 24,
      title_icon_color: null,
      title_icon_background: null,
      language: "auto",
      show_unacknowledged: true,
      show_history: true,
      show_channel: true,
      show_importance: true,
      show_clear_history: true,
      show_delete_button: true,
      image_display_mode: "thumbnail",
      history_channels: [],
      history_channels_mode: "include",
      history_min_importance: "low",
      show_ticker: false,
      ticker_limit: 10,
      ticker_font_size: 0.85,
      ticker_speed: 1,
      max_items: 50,
      card_height: null,
      card_background_color: null,
      card_border_radius: null,
      card_border_color: null,
      card_border_width: null,
    };
  }

  static getConfigElement() {
    return document.createElement("k93-ans-overview-card-editor");
  }
}

class K93AnsOverviewCardEditor extends HTMLElement {
  setConfig(config) {
    this._config = config;
    this._updateForm();
  }

  set hass(hass) {
    this._hass = hass;
    this._updateForm();
  }

  connectedCallback() {
    if (!this._form) {
      this._form = document.createElement("ha-form");
      this._form.computeLabel = (item) => K93AnsOverviewCardEditor.LABELS[item.name] || item.name;
      this._form.addEventListener("value-changed", (ev) => {
        ev.stopPropagation();
        this._config = ev.detail.value;
        this.dispatchEvent(
          new CustomEvent("config-changed", {
            detail: { config: this._config },
            bubbles: true,
            composed: true,
          })
        );
      });
      this.appendChild(this._form);
    }
    this._updateForm();
  }

  _channelOptions() {
    const hass = this._hass;
    if (hass) {
      const cached = this._channelSensorId && hass.states[this._channelSensorId];
      const channels = cached
        ? cached.attributes.channels
        : (() => {
            for (const stateObj of Object.values(hass.states)) {
              if (stateObj.entity_id.startsWith("sensor.k93_ans") && Array.isArray(stateObj.attributes?.channels)) {
                this._channelSensorId = stateObj.entity_id;
                return stateObj.attributes.channels;
              }
            }
            return null;
          })();
      if (Array.isArray(channels)) {
        return channels.map((c) => ({
          value: c.key,
          label: c.enabled === false ? `${c.name} (${c.key}, disabled)` : `${c.name} (${c.key})`,
        }));
      }
    }
    return BUILTIN_CHANNEL_KEYS.map((key) => ({ value: key, label: key }));
  }

  _schema() {
    const importanceOptions = IMPORTANCE_LEVELS.map((value) => ({
      value,
      label: STRINGS.en.importance[value],
    }));
    const channelSelector = {
      select: { multiple: true, custom_value: true, options: this._channelOptions() },
    };
    const importanceSelector = { select: { options: importanceOptions } };
    const languageSelector = {
      select: {
        options: [
          { value: "auto", label: "Automatic (match Home Assistant)" },
          { value: "en", label: "English" },
          { value: "no", label: "Norsk" },
        ],
      },
    };
    const imageDisplayModeSelector = {
      select: {
        options: [
          { value: "thumbnail", label: "Thumbnail to the left" },
          { value: "full", label: "Full-size, under the notification" },
          { value: "none", label: "Do not display" },
        ],
      },
    };
    const channelModeSelector = {
      select: {
        options: [
          { value: "include", label: "Show only selected channels" },
          { value: "exclude", label: "Hide selected channels" },
        ],
      },
    };

    return [
      { name: "title", selector: { text: {} } },
      { name: "title_icon", selector: { icon: {} } },
      {
        name: "title_font_size",
        selector: { number: { min: 0.5, max: 3, step: 0.05, mode: "box" } },
      },
      {
        name: "title_icon_size",
        selector: { number: { min: 12, max: 64, step: 1, mode: "box", unit_of_measurement: "px" } },
      },
      { name: "title_icon_color", selector: { text: {} } },
      { name: "title_icon_background", selector: { text: {} } },
      { name: "language", selector: languageSelector },
      { name: "show_unacknowledged", selector: { boolean: {} } },
      { name: "show_history", selector: { boolean: {} } },
      { name: "show_channel", selector: { boolean: {} } },
      { name: "show_importance", selector: { boolean: {} } },
      { name: "show_clear_history", selector: { boolean: {} } },
      { name: "show_delete_button", selector: { boolean: {} } },
      { name: "image_display_mode", selector: imageDisplayModeSelector },
      { name: "history_channels_mode", selector: channelModeSelector },
      { name: "history_channels", selector: channelSelector },
      { name: "history_min_importance", selector: importanceSelector },
      { name: "show_ticker", selector: { boolean: {} } },
      { name: "ticker_limit", selector: { number: { min: 1, max: 500, mode: "box" } } },
      {
        name: "ticker_font_size",
        selector: { number: { min: 0.5, max: 3, step: 0.05, mode: "box" } },
      },
      {
        name: "ticker_speed",
        selector: { number: { min: 0.25, max: 4, step: 0.25, mode: "box" } },
      },
      { name: "max_items", selector: { number: { min: 1, max: 500, mode: "box" } } },
      {
        name: "card_height",
        selector: { number: { min: 60, max: 2000, step: 10, mode: "box", unit_of_measurement: "px" } },
      },
      { name: "card_background_color", selector: { text: {} } },
      {
        name: "card_border_radius",
        selector: { number: { min: 0, max: 100, step: 1, mode: "box", unit_of_measurement: "px" } },
      },
      { name: "card_border_color", selector: { text: {} } },
      {
        name: "card_border_width",
        selector: { number: { min: 0, max: 20, step: 1, mode: "box", unit_of_measurement: "px" } },
      },
    ];
  }

  _updateForm() {
    if (!this._form || !this._config) return;
    this._form.hass = this._hass;
    const schema = this._schema();
    const schemaJson = JSON.stringify(schema);
    if (schemaJson !== this._schemaJson) {
      this._schemaJson = schemaJson;
      this._form.schema = schema;
    }
    this._form.data = this._config;
  }
}

K93AnsOverviewCardEditor.LABELS = {
  title: "Title",
  title_icon: "Title icon",
  title_font_size: "Title font size (em)",
  title_icon_size: "Title icon size (px)",
  title_icon_color: "Title icon color (CSS color, blank = theme text color)",
  title_icon_background: "Title icon backdrop (CSS color, blank = none)",
  language: "Language",
  show_unacknowledged: "Show unacknowledged section",
  show_history: "Show history section",
  show_channel: "Show channel on each notification",
  show_importance: "Show importance on each notification",
  show_clear_history: "Show \"Clear\" button on the History section",
  show_delete_button: "Show delete button on history rows",
  image_display_mode: "Image display mode",
  history_channels_mode: "Channel filter mode for History + ticker",
  history_channels: "Channels for History + ticker (empty = no filter; suggests configured channels)",
  history_min_importance: "Minimum importance for History + ticker",
  show_ticker: "Show scrolling ticker",
  ticker_limit: "Ticker: max items (separate from \"Max records fetched\" below)",
  ticker_font_size: "Ticker: font size (em)",
  ticker_speed: "Ticker: scroll speed (x)",
  max_items: "Max records fetched (History; ticker uses its own limit above)",
  card_height: "Card height (px, blank = auto)",
  card_background_color: "Card background color override (CSS color, blank = theme default)",
  card_border_radius: "Card corner radius override (px, blank = theme default)",
  card_border_color: "Card border color override (CSS color, blank = theme default)",
  card_border_width: "Card border width override (px, blank = theme default)",
};

customElements.define("k93-ans-overview-card", K93AnsOverviewCard);
customElements.define("k93-ans-overview-card-editor", K93AnsOverviewCardEditor);

window.customCards = window.customCards || [];
window.customCards.push({
  type: "k93-ans-overview-card",
  name: "K93 ANS Overview Card",
  description: "Shows K93 ANS notification history and unacknowledged notifications.",
});
