/**
 * Glossary — single source of truth for plain-English compensation
 * definitions. Used by /glossary and (later, Phase 6) by the AI
 * assistant to ground "what does X mean" questions.
 *
 * Mirrored from the on-prem glossary.ts; tightened in places per the
 * rewrite plan §"junior Total Rewards professionals". Aliases improve
 * AI lookup recall without changing the headline term.
 */

export interface GlossaryEntry {
  term: string;
  aliases: string[];
  definition: string;
}

export const GLOSSARY: GlossaryEntry[] = [
  {
    term: "CD&A",
    aliases: ["Compensation Discussion & Analysis", "Compensation Discussion and Analysis"],
    definition:
      "The narrative section of a proxy statement where the compensation committee explains how and why executives were paid the way they were. It's the story behind the numbers.",
  },
  {
    term: "Summary Compensation Table",
    aliases: ["SCT"],
    definition:
      "The standardized table in every proxy that lists each named executive's salary, bonus, stock awards, option awards, non-equity incentive plan compensation, change in pension value, all other compensation, and total. The first place to look for what someone got paid.",
  },
  {
    term: "Named Executive Officer",
    aliases: ["NEO"],
    definition:
      "The CEO, CFO, and the next three most highly compensated executives at a company. The SEC requires their pay to be disclosed individually each year.",
  },
  {
    term: "Stock awards",
    aliases: ["RSU", "Restricted stock units", "PSU", "Performance stock units"],
    definition:
      "Equity that vests over time (RSUs) or based on performance metrics (PSUs). Reported at grant-date fair value in the SCT, which is not the same as what the executive will eventually realize.",
  },
  {
    term: "Non-equity incentive plan compensation",
    aliases: ["Annual incentive", "Cash incentive", "Bonus"],
    definition:
      "Cash earned under a pre-established formula tied to performance — typically the annual bonus plan. Distinct from a discretionary bonus, which is reported in a separate Bonus column.",
  },
  {
    term: "Pay mix",
    aliases: [],
    definition:
      "The split of total compensation across base salary, cash incentive, equity, and other. A heavy equity weighting signals the executive bears stock-price risk; a heavy base signals the opposite.",
  },
  {
    term: "At-risk pay",
    aliases: ["Variable pay"],
    definition:
      "The portion of total pay that varies with company performance — typically cash incentive plus equity awards. The opposite of guaranteed base salary.",
  },
  {
    term: "Realized pay",
    aliases: ["Realized compensation"],
    definition:
      "What an executive actually walked away with: vested equity at the value when it vested, plus paid-out incentives. Different from the SCT total, which uses grant-date values.",
  },
  {
    term: "Realizable pay",
    aliases: [],
    definition:
      "The value of outstanding awards if everything were settled today. Useful for evaluating whether a pay program is actually paying off given recent stock performance.",
  },
  {
    term: "Say on pay",
    aliases: ["Say-on-pay"],
    definition:
      "A non-binding shareholder vote on the prior year's executive compensation. A pass below ~70% is usually considered a meaningful signal of investor concern.",
  },
  {
    term: "Relative TSR",
    aliases: ["rTSR", "Total Shareholder Return"],
    definition:
      "Total shareholder return measured against a peer group or index over a multi-year period. Often used as the performance metric for PSU vesting.",
  },
  {
    term: "Clawback",
    aliases: ["Clawback policy"],
    definition:
      "A policy that allows the company to recover compensation already paid (typically incentive comp) if a financial restatement or executive misconduct triggers it. Required for listed issuers as of 2023.",
  },
  {
    term: "Hedging and pledging",
    aliases: ["Hedging policy", "Pledging policy"],
    definition:
      "Whether executives are allowed to hedge their company stock or pledge it as collateral. Most large issuers prohibit both — pledging especially is viewed as a governance red flag.",
  },
  {
    term: "Change in control",
    aliases: ["CIC", "Golden parachute"],
    definition:
      "What happens to an executive's compensation if the company is acquired or merged. Best practice is double-trigger (CIC + termination), not single-trigger (CIC alone).",
  },
  {
    term: "Compensation peer group",
    aliases: ["Peer group", "Compensation peers"],
    definition:
      "The companies the comp committee benchmarks against when setting pay. Selection is often defended by industry, size, and complexity. ProxyMiner extracts these so you can sanity-check defensibility.",
  },
  {
    term: "Performance vesting",
    aliases: ["PSU vesting"],
    definition:
      "Equity that vests only if specific performance conditions are met (usually 3-year metrics like rTSR, ROIC, or revenue). The opposite of time-based vesting.",
  },
  {
    term: "Equity mix",
    aliases: ["Time/performance equity mix"],
    definition:
      "The split of an executive's equity grant between time-based RSUs and performance-based PSUs. A 50/50 split is common; PSU-heavy mixes (e.g. 70%+) signal stronger pay-for-performance.",
  },
];
