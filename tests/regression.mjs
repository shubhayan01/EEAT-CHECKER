// Regression tests for the Content Quality Checker (index.html).
// Extracts the single <script> from index.html, evaluates it under a minimal
// DOM stub, and asserts the deterministic detection logic against fixtures that
// cover every issue reported by the team. Run: node tests/regression.mjs
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import vm from 'node:vm';

const __dir = dirname(fileURLToPath(import.meta.url));
const html = readFileSync(join(__dir, '..', 'index.html'), 'utf8');

// ── Extract the page script ────────────────────────────────────
const m = html.match(/<script>([\s\S]*)<\/script>/);
if (!m) { console.error('Could not find <script> in index.html'); process.exit(1); }
const scriptSrc = m[1];

// ── Minimal, forgiving DOM stub so the init code runs without a browser ──
function makeEl(){
  const el = {
    style:{}, dataset:{}, classList:{ add(){}, remove(){}, toggle(){}, contains(){return false;} },
    _children:[], innerHTML:'', textContent:'', value:'', checked:false, disabled:false,
    appendChild(c){ this._children.push(c); return c; },
    addEventListener(){}, removeEventListener(){}, querySelector(){ return null; },
    querySelectorAll(){ return []; }, setAttribute(){}, getAttribute(){ return null; },
    focus(){}, click(){}, remove(){},
  };
  return new Proxy(el, { get(t,p){ if(p in t) return t[p]; if(typeof p==='string'){ t[p]=undefined; return t[p]; } return undefined; }, set(t,p,v){ t[p]=v; return true; } });
}
const document = {
  getElementById(){ return makeEl(); },
  querySelector(){ return makeEl(); },
  querySelectorAll(){ return []; },
  createElement(){ return makeEl(); },
  addEventListener(){},
};
const localStorage = { _d:{}, getItem(k){ return this._d[k] ?? null; }, setItem(k,v){ this._d[k]=v; }, removeItem(k){ delete this._d[k]; } };
const location = { protocol:'file:', origin:'null', href:'file:///index.html' };

const sandbox = {
  document, localStorage, location, console,
  window:{ addEventListener(){}, removeEventListener(){}, print(){} },
  fetch: async()=>({ ok:false, json:async()=>({}), text:async()=>'' }),
  alert(){}, confirm(){ return true; }, setTimeout, clearTimeout, URL, Date, Math, JSON,
};
sandbox.window.document = document;
const ctx = vm.createContext(sandbox);

// Expose the internal functions we want to test by appending an export shim.
const exportShim = `;globalThis.__T = { parseContent, detectFormat, extractHeadings, extractLinks,
  detectDates, detectDisclaimer, detectUnsourcedStats, evidenceInText, normText,
  clientSideMetrics, computeGates, computeScore, reconcileDetections, buildSignalsNote,
  getCT, CONTENT_TYPES, PILLARS };`;

try { vm.runInContext(scriptSrc + exportShim, ctx, { filename:'index-script.js' }); }
catch(e){ console.error('Script failed to evaluate:\n', e); process.exit(1); }
const T = sandbox.__T || ctx.__T || globalThis.__T;
if (!T){ console.error('Export shim did not attach.'); process.exit(1); }

// ── Tiny assertion harness ─────────────────────────────────────
let pass=0, fail=0; const fails=[];
function ok(name, cond, extra){ if(cond){ pass++; } else { fail++; fails.push(name+(extra?` — ${extra}`:'')); } }
function eq(name, a, b){ ok(name, a===b, `expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`); }

// Helper: run computeGates for a content type with given LLM result + text.
function gatesFor(ctKey, text, params={}, gate_checks={}){
  const enabled = {}; T.PILLARS.forEach(pl=>pl.params.forEach(p=>{ enabled[p.k]=true; }));
  const metrics = T.clientSideMetrics(text, '');
  const merged = { params, gate_checks, overall_score:70 };
  T.reconcileDetections(merged, metrics.parsed, T.normText(text));
  merged.overall_score = 70;
  const wc = text.trim().split(/\s+/).length;
  const gates = T.computeGates(merged, ctKey, wc, enabled, metrics);
  const by = id => gates.find(g=>g.id===id);
  return { gates, by, merged, metrics };
}

// ════════════════════════════════════════════════════════════════
// PRIORITY 1 — detection correctness
// ════════════════════════════════════════════════════════════════

// 1a. Structure — an HTML-structured article must NOT read "0 subheadings".
{
  const htmlArticle = `<h1>Guide</h1><p>Intro para here with enough words to matter for the analysis.</p>
<h2>First section</h2><p>${'word '.repeat(120)}</p>
<h2>Second section</h2><p>${'word '.repeat(120)}</p>
<h3>A sub-point</h3><p>${'word '.repeat(120)}</p>`;
  const parsed = T.parseContent(htmlArticle);
  ok('1a structure: HTML headings detected', parsed.headingCount >= 3, `got ${parsed.headingCount}`);
  const { by } = gatesFor('general', htmlArticle);
  const sub = by('subheadings');
  ok('1a structure: not flagged as wall-of-text', sub.passed === true && sub.warning !== true, JSON.stringify({passed:sub.passed,warning:sub.warning}));
}
// 1a-md. Markdown headings.
{
  const md = `# Title\n\nIntro.\n\n## Section one\n${'word '.repeat(90)}\n\n## Section two\n${'word '.repeat(90)}\n\nHeading Three\n----\n${'word '.repeat(90)}`;
  const parsed = T.parseContent(md);
  ok('1a structure: markdown ATX+setext detected', parsed.headingCount >= 3, `got ${parsed.headingCount}`);
}

// 1b. Internal links — present but reported missing should be RESTORED.
{
  const text = `<p>See our <a href="/blog/related-guide">related guide</a> and <a href="/services">services</a>.</p><p>External: <a href="https://example.com/x">source</a>.</p>`;
  const parsed = T.parseContent(text);
  eq('1b links: internal counted', parsed.internalLinks.length, 2);
  eq('1b links: external counted', parsed.externalLinks.length, 1);
  const { merged } = gatesFor('general', text, {
    topic_cluster_internal_links:{ status:'missing', evidence:'' },
    descriptive_anchor_text:{ status:'missing', evidence:'' },
  });
  ok('1b links: false-negative internal link upgraded', merged.params.topic_cluster_internal_links.status !== 'missing',
     merged.params.topic_cluster_internal_links.status);
}

// 1c. Disclaimer — false positive must be downgraded when none exists.
{
  const noDisc = `This article explains how the treatment works. Talk to your doctor if unsure. ${'word '.repeat(200)}`;
  const det = T.detectDisclaimer(noDisc);
  ok('1c disclaimer: not detected when only a "talk to your doctor" aside', det.found === false);
  const { merged } = gatesFor('health', noDisc, {
    disclaimer_for_sensitive_topics:{ status:'strong', evidence:'The article says talk to your doctor' },
  });
  eq('1c disclaimer: false-positive strong downgraded to missing', merged.params.disclaimer_for_sensitive_topics.status, 'missing');
}
// 1c+. A real disclaimer IS detected.
{
  const withDisc = `Disclaimer: This article is for informational purposes only and is not a substitute for professional medical advice. ${'word '.repeat(200)}`;
  const det = T.detectDisclaimer(withDisc);
  ok('1c disclaimer: genuine disclaimer detected', det.found === true, det.text);
  const { by } = gatesFor('health', withDisc, {
    disclaimer_for_sensitive_topics:{ status:'missing', evidence:'' },
  });
  ok('1c disclaimer: real disclaimer passes the hard gate', by('ymyl_disclaimer').passed === true);
}

// 1d. Publish date — false positive downgraded when no date string exists.
{
  const noDate = `A helpful guide about widgets. ${'word '.repeat(150)}`;
  eq('1d date: none detected', T.detectDates(noDate).length, 0);
  const { merged } = gatesFor('general', noDate, {
    publish_or_updated_date_visible:{ status:'strong', evidence:'It is a blog so it has a date' },
  });
  eq('1d date: false-positive downgraded', merged.params.publish_or_updated_date_visible.status, 'missing');
}
{
  const withDate = `Published 12 March 2025. ${'word '.repeat(150)}`;
  ok('1d date: real date detected', T.detectDates(withDate).length >= 1);
}

// 1e. Unsourced statistics — a hard unsourced number must be surfaced even if
// the model reported none, so the gate can't PASS.
{
  const stat = `Our approach improved results. Around 87% of patients recovered fully within weeks. ${'word '.repeat(150)}`;
  const det = T.detectUnsourcedStats(stat);
  ok('1e stats: unsourced % flagged', det.length >= 1, JSON.stringify(det));
  const { by } = gatesFor('general', stat, {}, { unsourced_stats:{ count:0, examples:[] } });
  ok('1e stats: gate does not falsely pass', by('unsourced_stats').passed === false);
}
{
  const sourced = `According to a 2024 study in The Lancet, 87% of patients recovered. ${'word '.repeat(150)}`;
  eq('1e stats: sourced stat not flagged', T.detectUnsourcedStats(sourced).length, 0);
}

// ════════════════════════════════════════════════════════════════
// PRIORITY 2 — external links configurable / informational
// ════════════════════════════════════════════════════════════════
{
  const text = `A short blog with no outbound links. ${'word '.repeat(120)}`;
  const info = gatesFor('general', text).by('links_resolve');
  ok('2 extlinks: default is informational', info.info === true && info.passed === true);
  const off = gatesFor('commercial', text).by('links_resolve');
  ok('2 extlinks: can be turned off (na)', off.na === true);
  const rec = gatesFor('news', text).by('links_resolve');
  ok('2 extlinks: recommend soft-warns when none, never hard', rec.type==='soft' && rec.warning===true && rec.na!==true);
}

// ════════════════════════════════════════════════════════════════
// PRIORITY 3 — credentialed author bio configurable
// ════════════════════════════════════════════════════════════════
{
  const text = `A general blog. ${'word '.repeat(150)}`;
  ok('3 bio: off by default for non-YMYL', gatesFor('general', text).by('ymyl_author_bio').na === true);
  ok('3 bio: on for YMYL health', gatesFor('health', text).by('ymyl_author_bio').na === false);
}

// ════════════════════════════════════════════════════════════════
// PRIORITY 4 — context-aware rules per article type
// ════════════════════════════════════════════════════════════════
{
  ok('4 types: news preset exists', !!T.CONTENT_TYPES.news);
  ok('4 types: landing preset exists', !!T.CONTENT_TYPES.landing);
  ok('4 types: comparison preset exists', !!T.CONTENT_TYPES.comparison);
  ok('4 types: commercial preset exists', !!T.CONTENT_TYPES.commercial);
  // First-person off by default outside experience-driven types
  ok('4 first-person: off for health', T.CONTENT_TYPES.health.defaultOff.includes('first_person_narrative'));
  ok('4 first-person: off for news', T.CONTENT_TYPES.news.defaultOff.includes('first_person_narrative'));
  ok('4 first-person: ON for product/review', !T.CONTENT_TYPES.product.defaultOff.includes('first_person_narrative'));
  // Landing page: lean-intro disabled, low min words (a ~150-word page passes
  // landing's 120 minimum but would fail general's 300 minimum).
  const text = `Short punchy landing copy. ${'word '.repeat(150)}`;
  ok('4 landing: lean-intro na', gatesFor('landing', text).by('intro_length').na === true);
  ok('4 landing: passes its low 120-word minimum', gatesFor('landing', text).by('word_count').passed === true);
  ok('4 landing: same text fails general 300-word minimum (per-type threshold)', gatesFor('general', text).by('word_count').passed === false);
}

// ════════════════════════════════════════════════════════════════
// PRIORITY 6 — explainability: every gate carries a "why"
// ════════════════════════════════════════════════════════════════
{
  const text = `Some article. ${'word '.repeat(200)}`;
  const { gates } = gatesFor('health', text);
  const missingWhy = gates.filter(g=>!g.why);
  ok('6 explainability: every gate has a why', missingWhy.length === 0, `${missingWhy.length} without why: ${missingWhy.map(g=>g.id).join(',')}`);
}

// ── Sanity: evidenceInText ─────────────────────────────────────
{
  const article = T.normText('The clinic has treated over 5,000 patients since 2010 across three cities.');
  ok('evidenceInText: verbatim match', T.evidenceInText('treated over 5,000 patients', article));
  ok('evidenceInText: rejects absent text', !T.evidenceInText('board certified cardiologist reviewed this', article));
}

// ── Report ─────────────────────────────────────────────────────
console.log(`\n${pass} passed, ${fail} failed`);
if (fail){ console.log('\nFailures:'); fails.forEach(f=>console.log('  ✗ '+f)); process.exit(1); }
console.log('All regression tests passed ✓');
