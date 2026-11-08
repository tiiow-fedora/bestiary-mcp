// Rendered wiki HTML -> compact markdown. Keeps tables and infoboxes (that's where drop rates,
// stats and recipes live); drops navboxes, edit links, reference markers, scripts and images.
import { parse, HTMLElement, Node, NodeType } from "node-html-parser";

const DROP_SELECTORS = [
  "script", "style", "noscript", "link", "meta",
  ".navbox", ".navbox-container", ".navigation-box", ".nav-box", "table.navbox", ".mw-editsection",
  ".toc", "#toc", ".reference", "sup.reference", ".mw-references-wrap", ".references",
  ".noprint", ".mw-empty-elt", ".printfooter", ".catlinks", ".wds-tabber .wds-tabs__wrapper",
  ".gallery", ".mw-collapsible-toggle", ".hatnote-icon", ".mobile-hide",
  ".audio-button", ".mw-kartographer-map",
];

/** Icons that stand alone (immunity lists, crafting stations) carry meaning in their alt text;
 *  icons next to their own label are noise. Keep the first kind as text, drop the second. */
function resolveImages(root: HTMLElement) {
  for (const img of root.querySelectorAll("img")) {
    const alt = (img.getAttribute("alt") ?? "").trim();
    let box: HTMLElement | null = img.parentNode as HTMLElement;
    while (box && ["a", "span"].includes(box.rawTagName?.toLowerCase()) && box.text.trim() === "" && box.parentNode) box = box.parentNode as HTMLElement;
    const lonely = box ? box.text.trim() === "" : false;
    if (alt && lonely && !/\.(png|gif|jpe?g|svg|webp)$/i.test(alt) && alt.length < 60) img.replaceWith(` ${alt}, `);
    else img.remove();
  }
}

function clean(s: string) {
  return s.replace(/ /g, " ").replace(/[ \t]+/g, " ");
}

// Difficulty-mode variants (Terraria-style wikis: <span class="m-normal">145000</span><span class="m-expert">217500</span>)
const MODE_LABELS: [string, string][] = [
  ["m-expert-master", "Expert/Master"], ["m-normal", "Classic"], ["m-expert", "Expert"], ["m-master", "Master"],
];
export function modeLabel(el: HTMLElement): string | undefined {
  const cls = el.getAttribute?.("class") ?? "";
  return MODE_LABELS.find(([c]) => new RegExp(`(^|\\s)${c}(\\s|$)`).test(cls))?.[1];
}

/** Join rendered children, adding a space where two element outputs would otherwise fuse ("Portal Gun100%"). */
function joinParts(nodes: Node[], render: (n: Node) => string): string {
  let out = "";
  let prevEl = false;
  for (const c of nodes) {
    const s = render(c);
    const isEl = c.nodeType === NodeType.ELEMENT_NODE;
    if (s && prevEl && isEl && /[\w%)\]*]$/.test(out) && /^[\w(*\[]/.test(s)) out += " ";
    out += s;
    if (s) prevEl = isEl;
  }
  return out;
}

function inline(n: Node): string {
  if (n.nodeType === NodeType.TEXT_NODE) return clean(n.text);
  if (n.nodeType !== NodeType.ELEMENT_NODE) return "";
  const el = n as HTMLElement;
  const tag = el.rawTagName?.toLowerCase();
  if (el.classList?.contains("mode-content")) {
    const parts = el.childNodes
      .filter((c) => c.nodeType === NodeType.ELEMENT_NODE)
      .map((c) => {
        const t = inline(c).trim();
        const l = modeLabel(c as HTMLElement);
        return t ? (l ? `${t} (${l})` : t) : "";
      })
      .filter(Boolean);
    return parts.join(" / ");
  }
  const inner = joinParts(el.childNodes, inline);
  switch (tag) {
    case "br": return " / ";
    case "b": case "strong": return inner.trim() ? `**${inner.trim()}**` : "";
    case "i": case "em": return inner.trim() ? `*${inner.trim()}*` : "";
    case "code": return `\`${inner}\``;
    case "img": return el.getAttribute("alt") ? `[${el.getAttribute("alt")}]` : "";
    default: return inner;
  }
}

function cellText(el: HTMLElement): string {
  return block(el)
    .replace(/\n+/g, " / ")
    .replace(/\|/g, "\\|")
    .replace(/\s+/g, " ")
    .replace(/,\s*(\/|$)/g, " $1")
    .replace(/(\s*\/\s*){2,}/g, " / ")
    .replace(/^[\s/]+|[\s/,]+$/g, "")
    .trim();
}

function table(el: HTMLElement): string {
  const rows = el.querySelectorAll("tr").filter((tr) => tr.closest("table") === el);
  if (rows.length === 0) return "";
  const grid: string[][] = [];
  for (const tr of rows) {
    const cells: string[] = [];
    for (const c of tr.childNodes) {
      if (c.nodeType !== NodeType.ELEMENT_NODE) continue;
      const ce = c as HTMLElement;
      const t = ce.rawTagName?.toLowerCase();
      if (t !== "td" && t !== "th") continue;
      const span = Math.min(parseInt(ce.getAttribute("colspan") ?? "1", 10) || 1, 12);
      cells.push(cellText(ce));
      for (let i = 1; i < span; i++) cells.push("");
    }
    if (cells.some((c) => c)) grid.push(cells);
  }
  if (grid.length === 0) return "";
  const width = Math.max(...grid.map((r) => r.length));
  // A 1- or 2-column "label | value" table reads better as lines.
  if (width <= 2 && grid.every((r) => r.length <= 2)) {
    return grid.map((r) => (r.length === 2 && r[1] ? `- **${r[0]}**: ${r[1]}` : `- ${r.join(" ")}`)).join("\n") + "\n";
  }
  const pad = (r: string[]) => [...r, ...Array(width - r.length).fill("")];
  const caption = el.querySelector("caption");
  const head = `| ${pad(grid[0]).join(" | ")} |\n| ${Array(width).fill("---").join(" | ")} |`;
  const body = grid.slice(1).map((r) => `| ${pad(r).join(" | ")} |`).join("\n");
  return (caption ? `*${cellText(caption)}*\n` : "") + head + (body ? "\n" + body : "") + "\n";
}

function portableInfobox(el: HTMLElement): string {
  // Fandom's <aside class="portable-infobox">
  const out: string[] = [];
  const title = el.querySelector(".pi-title");
  if (title) out.push(`**${title.text.trim()}**`);
  for (const item of el.querySelectorAll(".pi-item")) {
    if (item.classList.contains("pi-data")) {
      const label = item.querySelector(".pi-data-label")?.text.trim();
      const val = item.querySelector(".pi-data-value");
      if (val) out.push(`- ${label ? `**${label}**: ` : ""}${cellText(val)}`);
    } else if (item.classList.contains("pi-header")) {
      out.push(`- __${item.text.trim()}__`);
    }
  }
  return "Infobox:\n" + out.join("\n") + "\n";
}

function block(n: Node, depth = 0): string {
  if (n.nodeType === NodeType.TEXT_NODE) return clean(n.text);
  if (n.nodeType !== NodeType.ELEMENT_NODE) return "";
  const el = n as HTMLElement;
  const tag = el.rawTagName?.toLowerCase();
  const kids = () => joinParts(el.childNodes, (c) => block(c, depth));
  if (el.classList?.contains("portable-infobox")) return "\n" + portableInfobox(el) + "\n";
  if (el.classList?.contains("mode-content")) return inline(el);
  switch (tag) {
    case "h1": case "h2": case "h3": case "h4": case "h5": case "h6": {
      const lvl = Number(tag[1]);
      return `\n\n${"#".repeat(Math.min(lvl + 1, 6))} ${el.text.trim()}\n\n`;
    }
    case "p": return "\n" + el.childNodes.map(inline).join("").trim() + "\n";
    case "ul": case "ol": {
      const items = el.childNodes.filter((c) => (c as HTMLElement).rawTagName?.toLowerCase() === "li") as HTMLElement[];
      return "\n" + items.map((li, i) => {
        const nested = li.childNodes.filter((c) => ["ul", "ol"].includes((c as HTMLElement).rawTagName?.toLowerCase()));
        const own = joinParts(li.childNodes.filter((c) => !nested.includes(c)), (c) => block(c, depth + 1)).replace(/\s+/g, " ").trim();
        const sub = nested.map((c) => block(c, depth + 1)).join("").replace(/^\n+/, "");
        if (!own && !sub) return "";
        const mode = modeLabel(li);
        return `${"  ".repeat(depth)}${tag === "ol" ? `${i + 1}.` : "-"} ${mode ? `(${mode}) ` : ""}${own}\n${sub}`;
      }).join("");
    }
    case "dl": return "\n" + kids() + "\n";
    case "dt": return `**${el.text.trim()}**\n`;
    case "dd": return `: ${cellText(el)}\n`;
    case "table": return "\n" + table(el) + "\n";
    case "pre": return "\n```\n" + el.text.trim() + "\n```\n";
    case "blockquote": return "\n> " + cellText(el) + "\n";
    case "br": return "\n";
    case "div": case "section": case "aside": case "figure": case "figcaption": case "center": {
      const inner = kids();
      return inner.trim() ? "\n" + inner + "\n" : "";
    }
    case "b": case "strong": case "i": case "em": case "a": case "span": case "code": case "small": case "sup": case "sub":
      return inline(el);
    default: return kids();
  }
}

export function htmlToMarkdown(html: string): string {
  const root = parse(html, { comment: false, blockTextElements: { script: false, style: false, pre: true } });
  for (const sel of DROP_SELECTORS) {
    try {
      root.querySelectorAll(sel).forEach((e) => e.remove());
    } catch {
      /* unsupported selector in this parser; skip */
    }
  }
  resolveImages(root);
  return block(root)
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
