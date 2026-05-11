/**
 * Shared primitives for proxy section extraction.
 *
 * Lifts the heading-finding + sibling-collection + document-flow walk
 * out of cd-and-a.ts so that pay-ratio, say-on-pay, compensation
 * committee report, and any future section type can reuse the same
 * traversal. The CD&A extractor still uses these primitives — its
 * behavior is preserved 1:1.
 */
import * as cheerio from "cheerio";
import type { CheerioAPI } from "cheerio";

const BLOCK_TAGS = new Set([
  "p", "div", "table", "ul", "ol", "li", "h1", "h2", "h3", "h4",
]);
const FLOW_BLOCK_TAGS = ["p", "div", "table", "ul", "ol", "li", "h1", "h2", "h3", "h4"];

const HEADING_PRIORITY: Record<string, number> = {
  h1: 0, h2: 1, h3: 2, h4: 3, p: 4, b: 5, div: 6, span: 7, td: 8,
};

export interface ExtractedSection {
  heading: string;
  text: string;
  html_fragment: string | null;
  confidence_score: number;
  method: string;
}

export interface SectionExtractorConfig {
  /** Predicate: does this normalized heading text match this section? */
  matchesHeading: (text: string) => boolean;
  /** Predicate: have we hit the next section after collecting enough chars? */
  isSectionEnd: (text: string, collectedChars: number) => boolean;
  /** Optional: skip blocks that match (TOC fragments, page numbers, etc.). */
  shouldSkipBlock?: (text: string) => boolean;
  /**
   * Optional suffix appended to the extraction_method string, e.g.
   * `"ceo-pay-ratio"` produces `exact-heading-and-sibling-blocks-ceo-pay-ratio`.
   * Leave undefined for the canonical CD&A method string format.
   */
  methodLabel?: string;
  /** Default confidence when text is collected (0.9 mirrors CD&A). */
  confidenceWithText?: number;
  /** Confidence for heading-only result. */
  confidenceHeadingOnly?: number;
  /** Limits — sane defaults match CD&A. */
  maxBlocks?: number;
  maxChars?: number;
  minSectionEndChars?: number;
  minSectionCharsForFallback?: number;
  /** Overshoot allowed for document-flow over sibling result. */
  flowOvershootChars?: number;
  /** If true, accept heading-only result (no text) as success. */
  acceptHeadingOnly?: boolean;
}

const DEFAULTS = {
  maxBlocks: 800,
  maxChars: 200_000,
  minSectionEndChars: 1_500,
  minSectionCharsForFallback: 1_000,
  flowOvershootChars: 1_000,
  confidenceWithText: 0.9,
  confidenceHeadingOnly: 0.55,
  acceptHeadingOnly: true,
} as const;

export function loadHtml(html: string): CheerioAPI | null {
  if (!html.trim()) return null;
  return cheerio.load(html);
}

/**
 * Run a section extraction over already-parsed HTML. We accept a
 * pre-loaded CheerioAPI so that callers running multiple section
 * extractors against the same filing only pay the parse cost once.
 */
export function extractSection(
  $: CheerioAPI,
  config: SectionExtractorConfig,
): ExtractedSection | null {
  const heading = findHeadingNode($, config) ?? findHeadingFromTocAnchor($, config);
  if (!heading) return null;

  const node = heading.node;
  const containerName = (node.tagName ?? "").toLowerCase();
  const container = BLOCK_TAGS.has(containerName) ? node : node.parent;
  if (!container || container.type !== "tag") return null;

  const limits = {
    maxBlocks: config.maxBlocks ?? DEFAULTS.maxBlocks,
    maxChars: config.maxChars ?? DEFAULTS.maxChars,
    minSectionEndChars: config.minSectionEndChars ?? DEFAULTS.minSectionEndChars,
    minSectionCharsForFallback:
      config.minSectionCharsForFallback ?? DEFAULTS.minSectionCharsForFallback,
    flowOvershootChars: config.flowOvershootChars ?? DEFAULTS.flowOvershootChars,
  };

  const sibling = collectFromSiblings($, container as import("domhandler").Element, config, limits);
  const siblingText = sibling.collected.join("\n\n").trim();
  const siblingLength = siblingText.length;

  let chosen = sibling;
  let chosenMethod: "sibling-blocks" | "document-flow" = "sibling-blocks";

  if (siblingLength < limits.minSectionCharsForFallback) {
    const flow = collectFromDocumentFlow($, node, config, limits);
    const flowText = flow.collected.join("\n\n").trim();
    if (flowText.length > siblingLength + limits.flowOvershootChars) {
      chosen = flow;
      chosenMethod = "document-flow";
    }
  }

  const sectionText = chosen.collected.join("\n\n").trim();
  const sectionHtml = chosen.htmlFragments.join("\n").trim() || null;
  const confidenceWithText = config.confidenceWithText ?? DEFAULTS.confidenceWithText;
  const confidenceHeadingOnly = config.confidenceHeadingOnly ?? DEFAULTS.confidenceHeadingOnly;
  const acceptHeadingOnly = config.acceptHeadingOnly ?? DEFAULTS.acceptHeadingOnly;

  const suffix = config.methodLabel ? `-${config.methodLabel}` : "";

  if (!sectionText) {
    if (!acceptHeadingOnly) return null;
    return {
      heading: heading.heading,
      text: "",
      html_fragment: null,
      confidence_score: confidenceHeadingOnly,
      method: `heading-only${suffix}`,
    };
  }

  return {
    heading: heading.heading,
    text: sectionText,
    html_fragment: sectionHtml,
    confidence_score: confidenceWithText,
    method: `${heading.method_prefix}-and-${chosenMethod}${suffix}`,
  };
}

interface LocatedHeading {
  heading: string;
  node: import("domhandler").Element;
  method_prefix: string;
}

function findHeadingNode(
  $: CheerioAPI,
  config: SectionExtractorConfig,
): LocatedHeading | null {
  const candidates: { score: number; len: number; el: import("domhandler").Element; text: string }[] = [];
  $("h1, h2, h3, h4, p, div, b, span, td").each((_, el) => {
    const text = normalizedText($(el).text());
    if (!text || text.length > 160) return;
    if (!config.matchesHeading(text)) return;
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

function findHeadingFromTocAnchor(
  $: CheerioAPI,
  config: SectionExtractorConfig,
): LocatedHeading | null {
  let found: LocatedHeading | null = null;
  $("a[href]").each((_, anchor) => {
    if (found) return;
    const text = normalizedText($(anchor).text());
    if (!text || !config.matchesHeading(text)) return;
    const href = $(anchor).attr("href") ?? "";
    if (!href.startsWith("#") || href.length <= 1) return;
    const target = $(`#${cssEscape(href.slice(1))}`).get(0);
    if (!target || target.type !== "tag") return;
    found = { heading: text, node: target, method_prefix: "toc-anchor" };
  });
  return found;
}

interface CollectionLimits {
  maxBlocks: number;
  maxChars: number;
  minSectionEndChars: number;
  minSectionCharsForFallback: number;
  flowOvershootChars: number;
}

function collectFromSiblings(
  $: CheerioAPI,
  container: import("domhandler").Element,
  config: SectionExtractorConfig,
  limits: CollectionLimits,
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
    if (!text || (config.shouldSkipBlock?.(text) ?? false)) {
      cursor = el.next ?? null;
      continue;
    }
    if (config.isSectionEnd(text, collectedChars)) break;
    if (BLOCK_TAGS.has(tag) && !seen.has(text)) {
      collected.push(text);
      htmlFragments.push($.html(el));
      seen.add(text);
      collectedChars += text.length + 2;
    }
    if (collected.length >= limits.maxBlocks || collectedChars >= limits.maxChars) break;
    cursor = el.next ?? null;
  }

  return { collected, htmlFragments };
}

function collectFromDocumentFlow(
  $: CheerioAPI,
  headingNode: import("domhandler").Element,
  config: SectionExtractorConfig,
  limits: CollectionLimits,
): { collected: string[]; htmlFragments: string[] } {
  const collected: string[] = [];
  const htmlFragments: string[] = [];
  const seen = new Set<string>();
  let collectedChars = 0;

  const after: import("domhandler").Element[] = [];
  let started = false;
  function walk(node: import("domhandler").Node) {
    if (
      started &&
      node.type === "tag" &&
      FLOW_BLOCK_TAGS.includes((node as import("domhandler").Element).tagName)
    ) {
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
    if (!text || (config.shouldSkipBlock?.(text) ?? false)) continue;
    if (config.isSectionEnd(text, collectedChars)) break;
    if (seen.has(text)) continue;
    collected.push(text);
    htmlFragments.push($.html(candidate));
    seen.add(text);
    collectedChars += text.length + 2;
    if (collected.length >= limits.maxBlocks || collectedChars >= limits.maxChars) break;
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

export function fullMatch(pattern: RegExp, text: string): boolean {
  const m = text.match(pattern);
  return m !== null && m[0] === text;
}

export function normalizedText(text: string): string {
  return text.replace(/ /g, " ").replace(/\s+/g, " ").trim();
}

function cssEscape(value: string): string {
  return value.replace(/([!"#$%&'()*+,./:;<=>?@[\\\]^`{|}~])/g, "\\$1");
}
