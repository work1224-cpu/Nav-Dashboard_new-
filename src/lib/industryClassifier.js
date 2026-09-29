// ══════════════════════════════════════════════════════
// Industry classifier
// ══════════════════════════════════════════════════════
// AMFI's own "category" field only ever says things like "Equity Scheme -
// Sectoral/Thematic" — it never names the actual sector. The specific
// industry a thematic fund targets (Banking, Pharma, Technology, etc.)
// only shows up in the SCHEME NAME itself (e.g. "Nippon India Pharma
// Fund"), so that's what this checks.
//
// This is a best-effort, name-keyword classification, not an official
// AMFI/SEBI field — most schemes are broad-based (Large Cap, Multi Cap,
// debt funds, hybrid funds, index funds, etc.) and simply don't target a
// single industry, so they correctly fall into "Miscellaneous" below.
// That's expected, not a bug: only genuinely sector/thematic schemes will
// land in a specific industry bucket.
//
// Patterns require a bit of surrounding context (e.g. "banking fund", not
// just "bank") specifically to avoid false positives — AMFI scheme names
// also contain PLAN variants like "- RETAIL - MONTHLY IDCW", so a bare
// "retail" keyword would wrongly tag every such scheme as "Retailing".

const INDUSTRIES = [
  'Banking & Financial Services (Reg)',
  'Consumption (Reg)',
  'Business Cycle (Reg)',
  'Healthcare (Reg)',
  'Technology (Reg)',
  'Manufacturing (Reg)',
  'Innovation (Reg)',
  'Quant (Reg)',
  'ESG (Reg)',
  'Momentum Factor (Reg)',
  'MNC (Reg)',
  'Special Situations (Reg)',
  'International Markets (Reg)',
  'Transportation & Logistics (Reg)',
  'Energy (Reg)',
  'PSU (Reg)',
  'Services (Reg)',
  'Shariah principles (Reg)',
  'Conglomerate (Reg)',
  'multi factor (Reg)',
  'Housing and Allied activities (Reg)',
  'Commodities (Reg)',
  'Quality Factor (Reg)',
  'Exports and Services (Reg)',
  'Minimum Variance (Reg)',
  'Rural and allied (Reg)',
  'IPOs (Reg)',
  'Non - Cyclical Consumer (Reg)',
  'Defence (Reg)',
  'FMCG (Reg)',
  'Pioneering Innovations (Reg)',
  'Auto (Reg)',
  'Multi Sector Rotation (Reg)'
];

// Order matters — the most specific thematic names are checked before the
// more generic phrases so a fund like "Quant Momentum Fund" lands in
// "Momentum Factor (Reg)" and not in the wider "Quant (Reg)" bucket.
const RULES = [
  ['Banking & Financial Services (Reg)', /banking\s*(?:&|and)?\s*financial\s*services|bfsi|financial\s*services/i],
  ['Non - Cyclical Consumer (Reg)', /non\s*-\s*cyclical\s*consumer|hdfc\s*consumption\s*fund/i],
  ['Consumption (Reg)', /(?:^|\s)consumption\s*fund|great\s*consumer|bharat\s*consumption|india\s*consumer/i],
  ['Business Cycle (Reg)', /business\s*cycle|business\s*cyc(?:les)?/i],
  ['Healthcare (Reg)', /pharma|healthcare|health\s*and\s*wellness|diagnostics/i],
  ['Technology (Reg)', /technology|digital\s*india|digital\s*bharat|teck\s*fund|infotech/i],
  ['Manufacturing (Reg)', /manufactur(?:ing|e\s*in\s*india)|make\s*in\s*india/i],
  ['Innovation (Reg)', /innovation|innovative\s*opportunities/i],
  ['Momentum Factor (Reg)', /active\s*momentum|momentum\s*fund/i],
  ['Quant (Reg)', /\bquant\b|quantamental/i],
  ['ESG (Reg)', /esg|exclusionary|best-in-class|integration\s*strategy/i],
  ['MNC (Reg)', /\bmnc\s*fund\b/i],
  ['Special Situations (Reg)', /special\s*opportunities|india\s*opportunities/i],
  ['International Markets (Reg)', /us\s*bluechip|asian\s*equity|taiwan|japan|international\s*equity|us\s*equity/i],
  ['Transportation & Logistics (Reg)', /transport(?:ation)?\s*(?:&|and)?\s*logistics/i],
  ['Energy (Reg)', /energy\s*opportunities|natural\s*resources\s*&\s*new\s*energy|resources\s*&\s*energy|oil\s*&\s*gas/i],
  ['PSU (Reg)', /psu\s*(?:equity|fund)/i],
  ['Exports and Services (Reg)', /export(?:s)?\s*(?:and\s*services|opportunities)/i],
  ['Services (Reg)', /services\s*fund|services\s*opportunities/i],
  ['Shariah principles (Reg)', /ethical\s*fund|shariah|ethical/i],
  ['Conglomerate (Reg)', /conglomerate|business\s*conglomerates/i],
  ['multi factor (Reg)', /multi[-\s]*factor/i],
  ['Housing and Allied activities (Reg)', /housing\s*opportunities|housing\s*and\s*allied/i],
  ['Commodities (Reg)', /commodit(?:y|ies)|comma\s*fund/i],
  ['Quality Factor (Reg)', /quality\s*fund/i],
  ['Minimum Variance (Reg)', /minimum\s*variance/i],
  ['Rural and allied (Reg)', /rural\s*opportunities/i],
  ['IPOs (Reg)', /ipo|recently\s*listed\s*ipo/i],
  ['Defence (Reg)', /defence|defense/i],
  ['FMCG (Reg)', /\bfmcg\b/i],
  ['Pioneering Innovations (Reg)', /pioneering\s*innovations|pioneer(?:ing)?\s*fund/i],
  ['Auto (Reg)', /automotive\s*opportunities/i],
  ['Multi Sector Rotation (Reg)', /multi\s*sector\s*rotation/i]
];

// Classifies a scheme into one of the exact sectoral/thematic industries above,
// based on the scheme name. Falls back to "Miscellaneous" for the broader funds
// that do not map to one of the listed sector filters.
function classifyIndustry(name, category) {
  const text = `${name || ''} ${category || ''}`;
  for (const [industry, pattern] of RULES) {
    if (pattern.test(text)) return industry;
  }
  return 'Miscellaneous';
}

module.exports = { INDUSTRIES, classifyIndustry };