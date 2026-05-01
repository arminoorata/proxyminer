/**
 * CD&A section extractor — TypeScript port of
 * /srv/projects/ProxyMiner/apps/api/app/services/extractor.py
 *
 * Strategy (mirrors the Python implementation 1:1):
 *
 *   1. Find a heading node whose text fullmatches the CD&A pattern.
 *      Scan h1-h4, p, div, b, span, td. Reject nodes inside <a> or
 *      <table>. Sort candidates by tag priority then text length.
 *   2. Fallback to a TOC anchor: <a href="#X">Compensation Discussion
 *      and Analysis</a>, resolve target id.
 *   3. Collect content from the heading's siblings (block-level tags).
 *   4. If sibling collection is < MIN_SECTION_CHARS_FOR_FALLBACK, also
 *      try a document-flow walk (find_all_next equivalent) and use it
 *      if it's > 1000 chars longer.
 *   5. Stop when we hit a known section-end heading after collecting
 *      ≥ MIN_SECTION_END_CHARS.
 *
 * Memory note (April 2026 OOM lesson): cheerio doesn't share BS4's
 * decompose-required cleanup, but we still avoid retaining the parsed
 * tree by returning early and letting GC handle it.
 */
import * as cheerio from "cheerio";
import type { CheerioAPI } from "cheerio";

export const CDA_EXTRACTOR_VERSION = "cda_extractor.ts.v1";

const CDA_PATTERN =
  /^compensation\s*discussion\s*(?:and|&)\s*analysis$/i;

const SECTION_END_PATTERNS: RegExp[] = [
  /^(?:people and )?compensation committee report$/i,
  /^summary compensation table$/i,
  /^pay versus performance$/i,
  /^grants of plan-based awards$/i,
  /^option exercises and stock vested$/i,
];

const SKIP_BLOCK_PATTERNS: RegExp[] = [
  /^table of contents$/i,
  /^\d{4}\s+proxy statement(?:\s*\|\s*\d+)?$/i,
  /^(?:summary\s+)?governance(?:\s+directors)?\s+compensation\s+proposals\s+other information$/i,
];

const BLOCK_TAGS = new Set([
  "p",
  "div",
  "table",
  "ul",
  "ol",
  "li",
  "h1",
  "h2",
  "h3",
  "h4",
]);
const FLOW_BLOCK_TAGS = ["p", "div", "table", "ul", "ol", "li", "h1", "h2", "h3", "h4"];
const MAX_SECTION_BLOCKS = 800;
const MAX_SECTION_CHARS = 200_000;
const MIN_SECTION_END_CHARS = 4_000;
const MIN_SECTION_CHARS_FOR_FALLBACK = 5_000;
const HEADING_PRIORITY: Record<string, number> = {
  h1: 0,
  h2: 1,
  h3: 2,
  h4: 3,
  p: 4,
  b: 5,
  div: 6,
  span: 7,
  td: 8,
};

export interface ExtractedSection {
  heading: string;
  text: string;
  html_fragment: string | null;
  confidence_score: number;
  method: string;
}

export function extractCdAndA(html: string): ExtractedSection | null {
  if (!html.trim()) return null;
  const $ = cheerio.load(html);

  const heading = findHeadingNode($) ?? findHeadingFromTocAnchor($);
  if (!heading) return null;

  const node = heading.node;
  const containerName = (node.tagName ?? "").toLowerCase();
  const container = BLOCK_TAGS.has(containerName) ? node : node.parent;
  if (!container || container.type !== "tag") return null;

  const { collected, htmlFragments, method } = extractBlocks(
    $,
    node,
    container,
    heading.method_prefix,
  );

  const sectionText = collected.join("\n\n").trim();
  const sectionHtml = htmlFragments.join("\n").trim() || null;

  if (!sectionText) {
    return {
      heading: heading.heading,
      text: "",
      html_fragment: null,
      confidence_score: 0.55,
      method: "heading-only",
    };
  }

  return {
    heading: heading.heading,
    text: sectionText,
    html_fragment: sectionHtml,
    confidence_score: 0.9,
    method,
  };
}

interface LocatedHeading {
  heading: string;
  node: import("domhandler").Element;
  method_prefix: string;
}

function findHeadingNode($: CheerioAPI): LocatedHeading | null {
  const candidates: { score: number; len: number; el: import("domhandler").Element; text: string }[] =
    [];
  $("h1, h2, h3, h4, p, div, b, span, td").each((_, el) => {
    const text = normalizedText($(el).text());
    if (!text || text.length > 120) return;
    if (!CDA_PATTERN.test(text)) return;
    const $el = $(el);
    if ($el.find("a").length > 0 || $el.parents("a").length > 0) return;
    if ($el.parents("table").length > 0) return;
    const tagScore = HEADING_PRIORITY[(el.tagName ?? "").toLowerCase()] ?? 99;
    candidates.push({ score: tagScore, len: text.length, el, text });
  });

  if (candidates.length === 0) return null;
  candidates.sort((a, b) => a.score - b.score || a.len - b.len);
  const best = candidates[0];
  return {
    heading: best.text,
    node: best.el,
    method_prefix: "exact-heading",
  };
}

function findHeadingFromTocAnchor($: CheerioAPI): LocatedHeading | null {
  let found: LocatedHeading | null = null;
  $("a[href]").each((_, anchor) => {
    if (found) return;
    const text = normalizedText($(anchor).text());
    if (!text || !CDA_PATTERN.test(text)) return;
    const href = $(anchor).attr("href") ?? "";
    if (!href.startsWith("#") || href.length <= 1) return;
    const target = $(`#${cssEscape(href.slice(1))}`).get(0);
    if (!target || target.type !== "tag") return;
    found = { heading: text, node: target, method_prefix: "toc-anchor" };
  });
  return found;
}

function extractBlocks(
  $: CheerioAPI,
  headingNode: import("domhandler").Element,
  container: import("domhandler").ParentNode,
  methodPrefix: string,
): { collected: string[]; htmlFragments: string[]; method: string } {
  const sibling = collectFromSiblings($, container as import("domhandler").Element);
  const siblingLength = sibling.collected.join("\n\n").length;
  if (siblingLength >= MIN_SECTION_CHARS_FOR_FALLBACK) {
    return {
      collected: sibling.collected,
      htmlFragments: sibling.htmlFragments,
      method: `${methodPrefix}-and-sibling-blocks`,
    };
  }
  const flow = collectFromDocumentFlow($, headingNode);
  const flowLength = flow.collected.join("\n\n").length;
  if (flowLength > siblingLength + 1_000) {
    return {
      collected: flow.collected,
      htmlFragments: flow.htmlFragments,
      method: `${methodPrefix}-and-document-flow`,
    };
  }
  return {
    collected: sibling.collected,
    htmlFragments: sibling.htmlFragments,
    method: `${methodPrefix}-and-sibling-blocks`,
  };
}

function collectFromSiblings(
  $: CheerioAPI,
  container: import("domhandler").Element,
): { collected: string[]; htmlFragments: string[] } {
  const collected: string[] = [];
  const htmlFragments: string[] = [];
  const seen = new Set<string>();
  let collectedChars = 0;

  let cursor: import("domhandler").Node | null = container.next ?? null;
  while (cursor) {
    if (cursor.type !== "tag") {
      cursor = cursor.next ?? null;
      continue;
    }
    const el = cursor as import("domhandler").Element;
    const tag = (el.tagName ?? "").toLowerCase();
    const text = normalizedText($(el).text());
    if (!text || shouldSkipBlock(text)) {
      cursor = el.next ?? null;
      continue;
    }
    if (shouldEndSection(text, collectedChars)) break;
    if (BLOCK_TAGS.has(tag) && !seen.has(text)) {
      collected.push(text);
      htmlFragments.push($.html(el));
      seen.add(text);
      collectedChars += text.length + 2;
    }
    if (collected.length >= MAX_SECTION_BLOCKS || collectedChars >= MAX_SECTION_CHARS) break;
    cursor = el.next ?? null;
  }

  return { collected, htmlFragments };
}

function collectFromDocumentFlow(
  $: CheerioAPI,
  headingNode: import("domhandler").Element,
): { collected: string[]; htmlFragments: string[] } {
  const collected: string[] = [];
  const htmlFragments: string[] = [];
  const seen = new Set<string>();
  let collectedChars = 0;

  // BS4 .find_all_next walks every descendant in document order *after*
  // the heading node. cheerio doesn't expose a 1:1 helper, so we do
  // it via .nextAll().find() unioned per-tag, then sort by document
  // position. But for performance + simplicity we traverse the whole
  // tree starting from the heading using a manual DFS.
  const after: import("domhandler").Element[] = [];
  let started = false;
  function walk(node: import("domhandler").Node) {
    if (started && node.type === "tag" && FLOW_BLOCK_TAGS.includes((node as import("domhandler").Element).tagName)) {
      after.push(node as import("domhandler").Element);
    }
    if (node === headingNode) started = true;
    const children = (node as import("domhandler").ParentNode).children;
    if (children) {
      for (const child of children) walk(child);
    }
  }
  walk($.root().get(0)!);

  for (const candidate of after) {
    if (!isCollectibleFlowBlock($, candidate)) continue;
    const text = normalizedText($(candidate).text());
    if (!text || shouldSkipBlock(text)) continue;
    if (shouldEndSection(text, collectedChars)) break;
    if (seen.has(text)) continue;
    collected.push(text);
    htmlFragments.push($.html(candidate));
    seen.add(text);
    collectedChars += text.length + 2;
    if (collected.length >= MAX_SECTION_BLOCKS || collectedChars >= MAX_SECTION_CHARS) break;
  }

  return { collected, htmlFragments };
}

function isCollectibleFlowBlock(
  $: CheerioAPI,
  el: import("domhandler").Element,
): boolean {
  const tag = (el.tagName ?? "").toLowerCase();
  if (!BLOCK_TAGS.has(tag)) return false;
  if (tag !== "table" && $(el).parents("table").length > 0) return false;
  if (
    (tag === "div" || tag === "ul" || tag === "ol") &&
    $(el).find("p, table, ul, ol, li, h1, h2, h3, h4").length > 0
  ) {
    return false;
  }
  return true;
}

function shouldSkipBlock(text: string): boolean {
  if (!text) return true;
  return SKIP_BLOCK_PATTERNS.some((p) => fullMatch(p, text));
}

function shouldEndSection(text: string, collectedChars: number): boolean {
  if (collectedChars < MIN_SECTION_END_CHARS) return false;
  if (text.length > 160) return false;
  return SECTION_END_PATTERNS.some((p) => fullMatch(p, text));
}

function fullMatch(pattern: RegExp, text: string): boolean {
  const m = text.match(pattern);
  return m !== null && m[0] === text;
}

function normalizedText(text: string): string {
  return text.replace(/ /g, " ").replace(/\s+/g, " ").trim();
}

function cssEscape(value: string): string {
  // Basic CSS escape — handles colons, dots, brackets that appear in
  // SEC-generated id attributes. Sufficient for the toc-anchor case.
  return value.replace(/([!"#$%&'()*+,./:;<=>?@[\\\]^`{|}~])/g, "\\$1");
}
