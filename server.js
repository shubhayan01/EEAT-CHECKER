// ─────────────────────────────────────────────────────────────────────────
// Justwords Content Quality Checker — local search helper (Playwright)
//
// The Content Analysis tab needs to (a) search Google and (b) read competitor
// blog pages. A browser page can't do either directly (CORS + bot walls), so
// this tiny Node server does it with Playwright — no API key, no cost.
//
// SETUP (run once, in this folder):
//   npm install
//   npm run setup      (downloads the Chromium Playwright drives)
// RUN:
//   npm start          (or: node server.js)
// Then open the tool at  http://localhost:8787
// ─────────────────────────────────────────────────────────────────────────
const http = require('http');
const fs   = require('fs');
const path = require('path');
const crypto = require('crypto');
const { chromium } = require('playwright');

const PORT = process.env.PORT || 8787;

// ── Accounts, sessions & report storage ─────────────────────────
// Two roles: "emp" runs the tool and uploads reports; "admin" reviews every
// uploaded report. Passwords are overridable via env vars for real deployments.
const ACCOUNTS = {
  emp:   { password: process.env.EMP_PASSWORD   || 'emp123',   role: 'emp'   },
  admin: { password: process.env.ADMIN_PASSWORD || 'admin123', role: 'admin' },
};
const sessions = new Map(); // token -> { username, role }

const REPORTS_FILE = path.join(__dirname, 'reports.json');
function loadReports(){
  try{ return JSON.parse(fs.readFileSync(REPORTS_FILE, 'utf8')) || []; }
  catch(e){ return []; }
}
function saveReports(list){
  try{ fs.writeFileSync(REPORTS_FILE, JSON.stringify(list, null, 2)); return true; }
  catch(e){ return false; }
}
function authOf(req){
  const h = req.headers['authorization'] || '';
  const t = h.replace(/^Bearer\s+/i, '').trim();
  return (t && sessions.get(t)) || null;
}
function readBody(req){
  return new Promise(resolve => {
    let data = '';
    req.on('data', c => { data += c; if(data.length > 20e6) req.destroy(); });
    req.on('end', () => { try{ resolve(data ? JSON.parse(data) : {}); }catch(e){ resolve(null); } });
    req.on('error', () => resolve(null));
  });
}

// One browser for the whole process; a fresh context per request keeps them isolated.
let browserPromise = null;
function getBrowser(){
  if(!browserPromise){
    browserPromise = chromium.launch({
      headless: true,
      args: ['--no-sandbox','--disable-blink-features=AutomationControlled']
    });
  }
  return browserPromise;
}
async function newPage(){
  const b = await getBrowser();
  const ctx = await b.newContext({
    userAgent:'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
    locale:'en-US',
    viewport:{ width:1280, height:900 },
    extraHTTPHeaders:{
      'Accept-Language':'en-US,en;q=0.9',
      'Accept':'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8'
    }
  });
  // Light touch to look less like automation (helps a little; not bulletproof).
  await ctx.addInitScript(()=>{
    Object.defineProperty(navigator, 'webdriver', { get:()=>undefined });
    Object.defineProperty(navigator, 'languages', { get:()=>['en-US','en'] });
  });
  const page = await ctx.newPage();
  // Skip images/media/fonts — we only need text, and it's much faster.
  await page.route('**/*', r => {
    const t = r.request().resourceType();
    return (t==='image'||t==='media'||t==='font') ? r.abort() : r.continue();
  });
  return { ctx, page };
}

function cors(res){
  res.setHeader('Access-Control-Allow-Origin','*');
  res.setHeader('Access-Control-Allow-Headers','*');
  res.setHeader('Access-Control-Allow-Methods','GET,POST,DELETE,OPTIONS');
}
function sendJSON(res, code, obj){
  cors(res); res.writeHead(code, {'Content-Type':'application/json'}); res.end(JSON.stringify(obj));
}

// ── Search: try Google, fall back to Bing ──────────────────────
// Google aggressively bot-blocks headless browsers (HTTP 429 → /sorry/ CAPTCHA
// page). When that happens we get zero results, so we transparently fall back to
// Bing, which serves scraper-friendly HTML and needs no key. Both return the same
// shape: { organic:[{title,link,snippet}], paa:[...], engine }.
async function search(q){
  try{
    const g = await googleSearch(q);
    if(g.organic && g.organic.length) return { ...g, engine:'google' };
  }catch(e){ /* blocked or failed — fall through to Bing */ }
  return { ...(await bingSearch(q)), engine:'bing' };
}

async function googleSearch(q){
  const { ctx, page } = await newPage();
  try{
    const resp = await page.goto('https://www.google.com/search?hl=en&gl=us&num=10&q='+encodeURIComponent(q),
      { waitUntil:'domcontentloaded', timeout:30000 });
    // Bot wall? Bail immediately so the caller falls back to Bing.
    if((resp && resp.status()===429) || /\/sorry\//.test(page.url())) return { organic:[], paa:[] };
    // Dismiss the EU consent wall if it appears.
    try{
      const btn = await page.$('#L2AGLb, button:has-text("Accept all"), button:has-text("I agree"), form[action*="consent"] button');
      if(btn){ await btn.click({ timeout:3000 }); await page.waitForTimeout(800); }
    }catch(e){}
    try{ await page.waitForSelector('#search a h3, #rso a h3', { timeout:6000 }); }catch(e){}
    const data = await page.evaluate(()=>{
      const txt = el => ((el && (el.innerText || el.textContent)) || '').replace(/\s+/g,' ').trim();
      const bad = /(^https?:\/\/(www\.)?google\.[a-z.]+\/)|\/search\?|webcache|accounts\.google|policies\.google|support\.google|\/aclk\?|googleadservices/i;
      const out = []; const seen = new Set();
      const root = document.querySelector('#rso') || document.querySelector('#search') || document.body;
      root.querySelectorAll('h3').forEach(h3=>{
        // Result markup varies: sometimes <a> wraps the <h3>, sometimes it's a
        // sibling inside the same result container. Handle both.
        let a = h3.closest('a[href]');
        if(!a){
          const box = h3.closest('div.g, .tF2Cxc, .MjjYud, [data-hveid]') || h3.parentElement;
          if(box) a = box.querySelector('a[href^="http"]');
        }
        const href = a ? (a.href||'') : '';
        if(!href || bad.test(href) || seen.has(href)) return;
        seen.add(href);
        const cont = a.closest('div.g, .tF2Cxc, .MjjYud, [data-hveid]') || a.parentElement;
        let snip = '';
        if(cont){ const sn = cont.querySelector('div[data-sncf], .VwiC3b, .st, [data-content-feature]'); if(sn) snip = txt(sn); }
        out.push({ title:txt(h3), link:href, snippet:(snip||'').slice(0,300) });
      });
      // "People also ask" questions (best-effort).
      const paa = [];
      document.querySelectorAll('[data-q]').forEach(el=>{ const t=el.getAttribute('data-q'); if(t) paa.push(t.trim()); });
      document.querySelectorAll('div[jsname] div[role="heading"] span').forEach(el=>{ const t=(el.innerText||'').trim(); if(/\?$/.test(t)&&t.length<160) paa.push(t); });
      return { organic: out.slice(0,10), paa: [...new Set(paa)].slice(0,8) };
    });
    return data;
  } finally { await ctx.close(); }
}

// Bing wraps every result link in a /ck/a redirect whose real URL is base64url in
// the `u` param (with an "a1" prefix). Decode it back to the destination.
function decodeBingUrl(href){
  try{
    const u = new URL(href);
    if(/(^|\.)bing\.com$/i.test(u.hostname) && u.pathname.startsWith('/ck/')){
      let enc = u.searchParams.get('u') || '';
      if(enc.startsWith('a1')) enc = enc.slice(2);
      enc = enc.replace(/-/g,'+').replace(/_/g,'/');
      while(enc.length % 4) enc += '=';
      const dec = Buffer.from(enc, 'base64').toString('utf8');
      if(/^https?:\/\//i.test(dec)) return dec;
    }
  }catch(e){}
  return href;
}

async function bingSearch(q){
  const { ctx, page } = await newPage();
  try{
    // waitUntil:'load' — Bing does an initial redirect (?rdr=1); domcontentloaded
    // fires too early and the extraction races the navigation.
    await page.goto('https://www.bing.com/search?setlang=en-us&count=15&q='+encodeURIComponent(q),
      { waitUntil:'load', timeout:30000 });
    try{ await page.waitForSelector('#b_results li.b_algo', { timeout:8000 }); }catch(e){}
    await page.waitForTimeout(400); // let titles lay out — innerText is empty before layout
    const raw = await page.evaluate(()=>{
      const txt = el => ((el && (el.innerText || el.textContent)) || '').replace(/\s+/g,' ').trim();
      const out = [];
      document.querySelectorAll('#b_results li.b_algo').forEach(r=>{
        const a = r.querySelector('h2 a'); if(!a) return;
        const sn = r.querySelector('.b_caption p, .b_algoSlug, .b_lineclamp2, .b_lineclamp3');
        out.push({ title:txt(a), href:a.href||'', snippet:txt(sn).slice(0,300) });
      });
      // Best-effort "People also ask" / related questions.
      const paa = [];
      document.querySelectorAll('.df_qntext, .b_ans [role="heading"]').forEach(el=>{ const t=(el.innerText||'').trim(); if(/\?$/.test(t)&&t.length<160) paa.push(t); });
      return { out, paa:[...new Set(paa)].slice(0,8) };
    });
    const organic = []; const seen = new Set();
    for(const r of raw.out){
      const link = decodeBingUrl(r.href);
      if(!/^https?:\/\//i.test(link) || seen.has(link)) continue;
      seen.add(link);
      organic.push({ title:r.title||link, link, snippet:r.snippet });
    }
    return { organic: organic.slice(0,10), paa: raw.paa };
  } finally { await ctx.close(); }
}

// ── Read a page as clean text ──────────────────────────────────
async function readPage(url){
  const { ctx, page } = await newPage();
  try{
    await page.goto(url, { waitUntil:'domcontentloaded', timeout:30000 });
    await page.waitForTimeout(500);
    const data = await page.evaluate(()=>{
      const title = document.title || '';
      const cands = [...document.querySelectorAll('article, main, [role=main], .post-content, .entry-content, .article-body, .article-content, #content, .content')];
      let best = document.body, max = 0;
      cands.forEach(el=>{ const len=(el.innerText||'').length; if(len>max){ max=len; best=el; } });
      const text = (best.innerText||'').replace(/\n{3,}/g,'\n\n').trim();
      return { title, text: text.slice(0,9000) };
    });
    return { url, title:data.title, text:data.text, ok: (data.text||'').length>200 };
  } catch(e){
    return { url, title:url, text:'', ok:false, error:String(e && e.message || e) };
  } finally { await ctx.close(); }
}

// ── HTTP server (also serves index.html so the page is same-origin) ──
const server = http.createServer(async (req,res)=>{
  const u = new URL(req.url, 'http://localhost');
  if(req.method==='OPTIONS'){ cors(res); res.writeHead(204); res.end(); return; }
  try{
    if(u.pathname==='/health'){ return sendJSON(res,200,{ ok:true }); }

    // ── Auth ──────────────────────────────────────────────────
    if(u.pathname==='/login' && req.method==='POST'){
      const body = await readBody(req);
      if(!body) return sendJSON(res,400,{ error:'Bad request' });
      const username = String(body.username||'').toLowerCase().trim();
      const acc = ACCOUNTS[username];
      if(!acc || acc.password !== String(body.password||'')){
        return sendJSON(res,401,{ error:'Invalid username or password' });
      }
      const token = crypto.randomBytes(24).toString('hex');
      sessions.set(token, { username, role:acc.role });
      return sendJSON(res,200,{ ok:true, token, role:acc.role, username });
    }

    // ── Reports: upload (any signed-in user) ───────────────────
    if(u.pathname==='/report' && req.method==='POST'){
      const who = authOf(req);
      if(!who) return sendJSON(res,401,{ error:'Not authenticated' });
      const body = await readBody(req);
      if(!body || !body.meta) return sendJSON(res,400,{ error:'Missing report data' });
      const list = loadReports();
      const rec = {
        id: 'rpt_'+Date.now().toString(36)+crypto.randomBytes(3).toString('hex'),
        createdAt: new Date().toISOString(),
        uploadedBy: who.username,
        meta: body.meta,
        reportHtml: String(body.reportHtml||''),
      };
      list.unshift(rec);
      if(!saveReports(list)) return sendJSON(res,500,{ error:'Could not save report to disk' });
      return sendJSON(res,200,{ ok:true, id:rec.id });
    }

    // ── Reports: list (admin only) ─────────────────────────────
    if(u.pathname==='/reports' && req.method==='GET'){
      const who = authOf(req);
      if(!who) return sendJSON(res,401,{ error:'Not authenticated' });
      if(who.role !== 'admin') return sendJSON(res,403,{ error:'Admin access required' });
      // Metadata only — the (large) reportHtml is fetched per report on demand.
      const list = loadReports().map(r => ({
        id:r.id, createdAt:r.createdAt, uploadedBy:r.uploadedBy, meta:r.meta
      }));
      return sendJSON(res,200,{ ok:true, reports:list });
    }

    // ── Reports: fetch one (admin only) ────────────────────────
    if(u.pathname==='/report' && req.method==='GET'){
      const who = authOf(req);
      if(!who) return sendJSON(res,401,{ error:'Not authenticated' });
      if(who.role !== 'admin') return sendJSON(res,403,{ error:'Admin access required' });
      const id = u.searchParams.get('id') || '';
      const rec = loadReports().find(r => r.id === id);
      if(!rec) return sendJSON(res,404,{ error:'Report not found' });
      return sendJSON(res,200,{ ok:true, report:rec });
    }

    // ── Reports: delete (admin only) ───────────────────────────
    if(u.pathname==='/report' && req.method==='DELETE'){
      const who = authOf(req);
      if(!who) return sendJSON(res,401,{ error:'Not authenticated' });
      if(who.role !== 'admin') return sendJSON(res,403,{ error:'Admin access required' });
      const id = u.searchParams.get('id') || '';
      const list = loadReports();
      const next = list.filter(r => r.id !== id);
      if(next.length === list.length) return sendJSON(res,404,{ error:'Report not found' });
      if(!saveReports(next)) return sendJSON(res,500,{ error:'Could not update storage' });
      return sendJSON(res,200,{ ok:true });
    }

    if(u.pathname==='/search'){
      const q = u.searchParams.get('q') || '';
      if(!q) return sendJSON(res,400,{ error:'missing q' });
      const r = await search(q);
      if(!r.organic || !r.organic.length){
        return sendJSON(res,200,{ organic:[], paa:[], engine:r.engine||'none',
          error:'No results — the search engines are rate-limiting this network right now. Try again shortly, or paste 2 competitor URLs to skip search.' });
      }
      return sendJSON(res,200, r);
    }
    if(u.pathname==='/read'){
      const url = u.searchParams.get('url') || '';
      if(!url) return sendJSON(res,400,{ error:'missing url' });
      return sendJSON(res,200, await readPage(url));
    }
    if(u.pathname==='/' || u.pathname==='/index.html'){
      const html = fs.readFileSync(path.join(__dirname,'index.html'));
      cors(res); res.writeHead(200,{'Content-Type':'text/html'}); res.end(html); return;
    }
    cors(res); res.writeHead(404); res.end('Not found');
  } catch(e){
    sendJSON(res,500,{ error:String(e && e.message || e) });
  }
});
server.listen(PORT, ()=>{
  console.log('\n  Justwords search helper running:');
  console.log('  → Open the tool at  http://localhost:'+PORT+'\n');
});
