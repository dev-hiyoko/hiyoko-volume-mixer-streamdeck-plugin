// Generates the key image (as an SVG data URI).
// - Mute: a speaker, with a red slash when muted.
// - Volume up/down: each key is one half of a single fader (up = top half,
//   down = bottom half). The knob sits at the current volume, so an up key
//   stacked over a down key reads as one continuous fader.

const WHITE = "#f4f4f5";
const MUTED = "#b9b9c0";
const FAINT = "#4a4a52";
const TRACK = "#3a3a40";
const RED = "#ff5a5a";
const GREEN = "#5ad48a";
const AMBER = "#ffcf5a";
const BG = "#151517";
const STROKE = "#34343a";
const FONT = "Segoe UI, system-ui, sans-serif";

export type KeyImageOptions =
  | { kind: "volume"; direction: "up" | "down"; name: string; percent: number; count?: number }
  | { kind: "mute"; name: string; muted: boolean; count?: number; icon?: string }
  | { kind: "empty"; name: string }
  | { kind: "offline" }
  | { kind: "restart"; status: "idle" | "working" | "ok" | "error" }
  | {
      kind: "music";
      /** Playlist name, or a placeholder when the key has not been configured. */
      name: string;
      shuffle: boolean;
      /** "working" covers the ~2s a playlist start takes — see apple-music.ts. */
      status: "unset" | "idle" | "playing" | "paused" | "working" | "error";
    };

/**
 * Monochrome glyphs selectable per app for the mute key, so same-looking app
 * keys can be told apart without resorting to colourful app icons. IDs must
 * match the picker in ui/action-settings.html. A `<g>` wrapper centres a 0–24
 * glyph in the key; some glyphs carve detail with the background colour.
 */
const MUTE_ICONS: Record<string, (color: string) => string> = {
  music: (c) =>
    `<circle cx="8" cy="18" r="3.5" fill="${c}"/><rect x="11" y="4" width="2" height="14" fill="${c}"/>` +
    `<path d="M13 4 q6 1 6 7 q-3 -4 -6 -4 Z" fill="${c}"/>`,
  game: (c) =>
    `<rect x="2" y="8" width="20" height="11" rx="5.5" fill="${c}"/>` +
    `<rect x="5.5" y="12.4" width="5" height="1.6" fill="${BG}"/><rect x="7.2" y="10.7" width="1.6" height="5" fill="${BG}"/>` +
    `<circle cx="16" cy="12" r="1.3" fill="${BG}"/><circle cx="18.5" cy="14.5" r="1.3" fill="${BG}"/>`,
  chat: (c) =>
    `<path d="M3 4 H21 a2 2 0 0 1 2 2 V15 a2 2 0 0 1 -2 2 H10 L5 21 V17 H3 a2 2 0 0 1 -2 -2 V6 a2 2 0 0 1 2 -2 Z" fill="${c}"/>`,
  globe: (c) =>
    `<circle cx="12" cy="12" r="10" fill="none" stroke="${c}" stroke-width="2"/>` +
    `<ellipse cx="12" cy="12" rx="4" ry="10" fill="none" stroke="${c}" stroke-width="1.6"/>` +
    `<line x1="2" y1="12" x2="22" y2="12" stroke="${c}" stroke-width="1.6"/>`,
  video: (c) =>
    `<rect x="2" y="3" width="20" height="18" rx="4" fill="none" stroke="${c}" stroke-width="2"/>` +
    `<path d="M10 8 L16 12 L10 16 Z" fill="${c}"/>`,
  mic: (c) =>
    `<rect x="9" y="2" width="6" height="12" rx="3" fill="${c}"/>` +
    `<path d="M5 11 a7 7 0 0 0 14 0" fill="none" stroke="${c}" stroke-width="2"/>` +
    `<line x1="12" y1="18" x2="12" y2="22" stroke="${c}" stroke-width="2"/><line x1="8" y1="22" x2="16" y2="22" stroke="${c}" stroke-width="2"/>`,
  headphones: (c) =>
    `<path d="M3 14 V12 a9 9 0 0 1 18 0 V14" fill="none" stroke="${c}" stroke-width="2"/>` +
    `<rect x="2" y="13" width="4.5" height="8" rx="2" fill="${c}"/><rect x="17.5" y="13" width="4.5" height="8" rx="2" fill="${c}"/>`,
  terminal: (c) =>
    `<rect x="2" y="3" width="20" height="18" rx="3" fill="none" stroke="${c}" stroke-width="2"/>` +
    `<path d="M6 9 L9 12 L6 15" fill="none" stroke="${c}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>` +
    `<line x1="11" y1="15" x2="16" y2="15" stroke="${c}" stroke-width="2" stroke-linecap="round"/>`,
  bell: (c) =>
    `<path d="M12 2 a6 6 0 0 1 6 6 c0 6 2 8 3 9 H3 c1 -1 3 -3 3 -9 a6 6 0 0 1 6 -6 Z" fill="${c}"/>` +
    `<path d="M9.5 20 a2.5 2.5 0 0 0 5 0" fill="${c}"/>`,
  star: (c) => `<path d="M12 1 L15 9 L23 9 L16.5 14 L19 22 L12 17 L5 22 L7.5 14 L1 9 L9 9 Z" fill="${c}"/>`,
  heart: (c) => `<path d="M12 21 C3 14 3 6 8 5 C11 4.5 12 7 12 7 C12 7 13 4.5 16 5 C21 6 21 14 12 21 Z" fill="${c}"/>`,
};

/** Returns the mute-key glyph for an icon id, centred; falls back to a speaker. */
function muteGlyph(icon: string | undefined, muted: boolean, color: string): string {
  if (!icon || icon === "speaker") {
    // Default keeps the speaker's "waves when audible" look.
    return speaker(color, !muted);
  }
  const draw = MUTE_ICONS[icon];
  if (!draw) {
    return speaker(color, !muted);
  }
  return `<g transform="translate(22,20) scale(1.17)">${draw(color)}</g>`;
}

const FADER = { top: 21, bottom: 59, cx: 36, trackW: 4, knobW: 26, knobH: 8 };

function esc(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function label(name: string, count?: number): string {
  const base = count && count > 1 ? `${name.trim()}×${count}` : name.trim();
  const clipped = base.length > 10 ? `${base.slice(0, 9)}…` : base;
  return esc(clipped);
}

function speaker(color: string, withWaves: boolean): string {
  const waves = withWaves
    ? `<path d="M16 8 a4 4 0 0 1 0 8" fill="none" stroke="${color}" stroke-width="2" stroke-linecap="round"/>` +
      `<path d="M16 5 a7 7 0 0 1 0 14" fill="none" stroke="${color}" stroke-width="2" stroke-linecap="round"/>`
    : "";
  return `<g transform="translate(21,18) scale(1.25)"><path d="M4 9 L8 9 L13 4 L13 20 L8 15 L4 15 Z" fill="${color}"/>${waves}</g>`;
}

/** Renders one half of a shared fader. `level` is 0–1; `half` picks the range. */
function faderHalf(half: "top" | "bottom", level: number): string {
  const { top, bottom, cx, trackW, knobW, knobH } = FADER;
  const height = bottom - top;
  const lv = Math.max(0, Math.min(1, level));
  const x = cx - trackW / 2;
  const track = `<rect x="${x}" y="${top}" width="${trackW}" height="${height}" rx="${trackW / 2}" fill="${TRACK}"/>`;

  let fill = "";
  let knob = "";
  const drawKnob = (y: number): string =>
    `<rect x="${cx - knobW / 2}" y="${y - knobH / 2}" width="${knobW}" height="${knobH}" rx="${knobH / 2}" fill="${WHITE}" stroke="#0d0d0f" stroke-width="1.5"/>`;
  const drawFill = (fromY: number): string =>
    `<rect x="${x}" y="${fromY}" width="${trackW}" height="${bottom - fromY}" rx="${trackW / 2}" fill="${WHITE}"/>`;

  if (half === "top") {
    if (lv >= 0.5) {
      const knobY = bottom - ((lv - 0.5) / 0.5) * height;
      fill = drawFill(knobY);
      knob = drawKnob(knobY);
    }
    // lv < 0.5: this half is above the level — empty track only.
  } else {
    if (lv >= 0.5) {
      fill = drawFill(top); // whole lower half is filled; knob lives on the top key
    } else {
      const knobY = bottom - (lv / 0.5) * height;
      fill = drawFill(knobY);
      knob = drawKnob(knobY);
    }
  }
  return track + fill + knob;
}

function nameText(text: string): string {
  return `<text x="36" y="14" text-anchor="middle" font-family="${FONT}" font-size="11" fill="${MUTED}">${text}</text>`;
}

function bottomText(text: string, color: string, bold = false): string {
  return `<text x="36" y="67" text-anchor="middle" font-family="${FONT}" font-size="${bold ? 15 : 12}" font-weight="${bold ? 700 : 400}" fill="${color}">${text}</text>`;
}

function frame(inner: string): string {
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 72 72" width="72" height="72">` +
    `<rect x="2" y="2" width="68" height="68" rx="14" fill="${BG}" stroke="${STROKE}" stroke-width="2"/>` +
    `${inner}</svg>`;
  return `data:image/svg+xml;base64,${Buffer.from(svg, "utf8").toString("base64")}`;
}

/** A circular refresh arrow, centred, for the audio-server restart key. */
function refreshGlyph(color: string): string {
  return (
    `<g transform="translate(36,38)">` +
    `<path d="M 11 -5 A 13 13 0 1 0 13 6" fill="none" stroke="${color}" stroke-width="4.5" stroke-linecap="round"/>` +
    `<path d="M 6 -13 L 17 -8 L 8 0 Z" fill="${color}"/>` +
    `</g>`
  );
}

/** Play triangle / pause bars / a spinner-ish dot, centred like the other glyphs. */
function transportGlyph(status: "unset" | "idle" | "playing" | "paused" | "working" | "error", color: string): string {
  if (status === "playing") {
    // Showing a pause symbol while playing: the glyph says what the next press
    // does, which is what the user is deciding when they look at the key.
    return `<g transform="translate(36,38)"><rect x="-11" y="-13" width="7.5" height="26" rx="2" fill="${color}"/><rect x="3.5" y="-13" width="7.5" height="26" rx="2" fill="${color}"/></g>`;
  }
  if (status === "working") {
    return (
      `<g transform="translate(36,38)">` +
      `<circle cx="0" cy="0" r="13" fill="none" stroke="${TRACK}" stroke-width="4"/>` +
      `<path d="M 0 -13 A 13 13 0 0 1 11 6" fill="none" stroke="${color}" stroke-width="4" stroke-linecap="round"/>` +
      `</g>`
    );
  }
  if (status === "error") {
    return (
      `<g transform="translate(36,38)">` +
      `<line x1="-10" y1="-10" x2="10" y2="10" stroke="${color}" stroke-width="4.5" stroke-linecap="round"/>` +
      `<line x1="10" y1="-10" x2="-10" y2="10" stroke="${color}" stroke-width="4.5" stroke-linecap="round"/>` +
      `</g>`
    );
  }
  return `<g transform="translate(36,38)"><path d="M -9 -13 L 13 0 L -9 13 Z" fill="${color}"/></g>`;
}

/** Crossing arrows, bottom-right, shown only when the key starts shuffled. */
function shuffleBadge(active: boolean): string {
  const c = active ? GREEN : FAINT;
  return (
    `<g transform="translate(58,20) scale(0.62)">` +
    `<path d="M-12 -8 L-4 -8 L8 8 L14 8" fill="none" stroke="${c}" stroke-width="3.4" stroke-linecap="round" stroke-linejoin="round"/>` +
    `<path d="M-12 8 L-4 8 L8 -8 L14 -8" fill="none" stroke="${c}" stroke-width="3.4" stroke-linecap="round" stroke-linejoin="round"/>` +
    `<path d="M10 -13 L16 -8 L10 -3 Z" fill="${c}"/><path d="M10 3 L16 8 L10 13 Z" fill="${c}"/>` +
    `</g>`
  );
}

export function renderKeyImage(opts: KeyImageOptions): string {
  if (opts.kind === "music") {
    if (opts.status === "unset") {
      return frame(nameText("プレイリスト") + transportGlyph("idle", FAINT) + bottomText("未設定", MUTED));
    }
    const color =
      opts.status === "error" ? RED : opts.status === "working" ? AMBER : opts.status === "playing" ? GREEN : WHITE;
    const caption =
      opts.status === "error"
        ? bottomText("失敗", RED, true)
        : opts.status === "working"
          ? bottomText("開始中…", AMBER)
          : opts.status === "playing"
            ? bottomText("再生中", GREEN)
            : opts.status === "paused"
              ? bottomText("一時停止", MUTED)
              : bottomText(opts.shuffle ? "シャッフル" : "順番に", MUTED);
    return frame(nameText(label(opts.name)) + shuffleBadge(opts.shuffle) + transportGlyph(opts.status, color) + caption);
  }

  if (opts.kind === "offline") {
    return frame(speaker(FAINT, false) + bottomText("オフライン", MUTED));
  }

  if (opts.kind === "restart") {
    const color =
      opts.status === "ok" ? GREEN : opts.status === "error" ? RED : opts.status === "working" ? AMBER : WHITE;
    const text =
      opts.status === "ok"
        ? bottomText("OK", GREEN, true)
        : opts.status === "error"
          ? bottomText("失敗", RED, true)
          : opts.status === "working"
            ? bottomText("実行中…", AMBER)
            : bottomText("再起動", MUTED);
    return frame(nameText("音声サーバー") + refreshGlyph(color) + text);
  }

  if (opts.kind === "empty") {
    return frame(nameText(label(opts.name)) + `<text x="36" y="46" text-anchor="middle" font-family="${FONT}" font-size="22" fill="${FAINT}">—</text>`);
  }

  if (opts.kind === "mute") {
    const slash = opts.muted
      ? `<line x1="20" y1="20" x2="50" y2="50" stroke="${RED}" stroke-width="4.5" stroke-linecap="round"/>`
      : "";
    const glyph = muteGlyph(opts.icon, opts.muted, WHITE) + slash;
    const state = opts.muted ? bottomText("ミュート", RED, true) : bottomText("通常", MUTED);
    return frame(nameText(label(opts.name, opts.count)) + glyph + state);
  }

  // volume — half of a shared fader
  const half = opts.direction === "up" ? "top" : "bottom";
  const sign = opts.direction === "up" ? "＋" : "－";
  const badge = `<text x="55" y="42" text-anchor="middle" font-family="${FONT}" font-size="18" font-weight="700" fill="${WHITE}">${sign}</text>`;
  return frame(nameText(label(opts.name, opts.count)) + faderHalf(half, opts.percent / 100) + badge + bottomText(`${Math.round(opts.percent)}%`, WHITE, true));
}
