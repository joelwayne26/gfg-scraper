import ZAI from 'z-ai-web-dev-sdk';
import * as cheerio from 'cheerio';
import * as https from 'https';
import * as http from 'http';
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import sharp from 'sharp';
import {
  Document, Packer, Paragraph, TextRun, HeadingLevel, ImageRun,
  AlignmentType, BorderStyle, Table, TableRow, TableCell,
  WidthType, ShadingType, PageBreak, ExternalHyperlink,
} from 'docx';
import { PrismaClient } from '@prisma/client';

const DOWNLOAD_DIR = '/home/z/my-project/download';
const MAX_IMG_W = 600;

// ─── Image Download ──────────────────────────────────────────────────────

async function dlImg(url: string): Promise<{ buffer: Buffer; ext: string; w: number; h: number } | null> {
  return new Promise((resolve) => {
    if (!url || (!url.startsWith('http://') && !url.startsWith('https://'))) { resolve(null); return; }
    const cl = url.startsWith('https') ? https : http;
    const to = setTimeout(() => resolve(null), 20000);
    const req = cl.get(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36', 'Accept': 'image/*,*/*;q=0.8', 'Referer': 'https://www.geeksforgeeks.org/' }
    }, (res) => {
      if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) { clearTimeout(to); dlImg(res.headers.location).then(resolve); return; }
      if (res.statusCode !== 200) { clearTimeout(to); resolve(null); return; }
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', async () => {
        clearTimeout(to);
        try {
          const raw = Buffer.concat(chunks);
          if (raw.length < 500) { resolve(null); return; }
          const meta = await sharp(raw).metadata();
          const w = meta.width || 580, h = meta.height || 360;
          const processed = w > MAX_IMG_W
            ? await sharp(raw).resize(MAX_IMG_W, null, { withoutEnlargement: true, fit: 'inside' }).png({ quality: 90 }).toBuffer()
            : await sharp(raw).png({ quality: 90 }).toBuffer();
          resolve({ buffer: processed, ext: '.png', w, h });
        } catch { resolve(null); }
      });
      res.on('error', () => { clearTimeout(to); resolve(null); });
    });
    req.on('error', () => { clearTimeout(to); resolve(null); });
    req.setTimeout(20000, () => { req.destroy(); clearTimeout(to); resolve(null); });
  });
}

// ─── LaTeX ────────────────────────────────────────────────────────────────

function tex(s: string): string {
  return s.replace(/\\frac\{([^}]*)\}\{([^}]*)\}/g, '($1)/($2)').replace(/\\sqrt\{([^}]*)\}/g, '\u221A($1)')
    .replace(/\\sum[^{]*/g, '\u2211').replace(/\\prod[^{]*/g, '\u220F').replace(/\\int[^{]*/g, '\u222B')
    .replace(/\\partial/g, '\u2202').replace(/\\infty/g, '\u221E').replace(/\\nabla/g, '\u2207')
    .replace(/\\alpha/g, '\u03B1').replace(/\\beta/g, '\u03B2').replace(/\\gamma/g, '\u03B3').replace(/\\delta/g, '\u03B4')
    .replace(/\\epsilon/g, '\u03B5').replace(/\\zeta/g, '\u03B6').replace(/\\eta/g, '\u03B7').replace(/\\theta/g, '\u03B8')
    .replace(/\\iota/g, '\u03B9').replace(/\\kappa/g, '\u03BA').replace(/\\lambda/g, '\u03BB').replace(/\\mu/g, '\u03BC')
    .replace(/\\nu/g, '\u03BD').replace(/\\xi/g, '\u03BE').replace(/\\pi/g, '\u03C0').replace(/\\rho/g, '\u03C1')
    .replace(/\\sigma/g, '\u03C3').replace(/\\tau/g, '\u03C4').replace(/\\upsilon/g, '\u03C5').replace(/\\phi/g, '\u03C6')
    .replace(/\\chi/g, '\u03C7').replace(/\\psi/g, '\u03C8').replace(/\\omega/g, '\u03C9')
    .replace(/\\Gamma/g, '\u0393').replace(/\\Delta/g, '\u0394').replace(/\\Theta/g, '\u0398').replace(/\\Lambda/g, '\u039B')
    .replace(/\\Xi/g, '\u039E').replace(/\\Pi/g, '\u03A0').replace(/\\Sigma/g, '\u03A3').replace(/\\Phi/g, '\u03A6')
    .replace(/\\Psi/g, '\u03A8').replace(/\\Omega/g, '\u03A9')
    .replace(/\\leq/g, '\u2264').replace(/\\geq/g, '\u2265').replace(/\\neq/g, '\u2260').replace(/\\approx/g, '\u2248')
    .replace(/\\equiv/g, '\u2261').replace(/\\propto/g, '\u221D').replace(/\\sim/g, '\u223C').replace(/\\simeq/g, '\u2243')
    .replace(/\\times/g, '\u00D7').replace(/\\div/g, '\u00F7').replace(/\\pm/g, '\u00B1').replace(/\\mp/g, '\u2213')
    .replace(/\\cdot/g, '\u00B7').replace(/\\cdots/g, '\u22EF').replace(/\\ldots/g, '\u2026').replace(/\\vdots/g, '\u22EE')
    .replace(/\\oplus/g, '\u2295').replace(/\\otimes/g, '\u2297').replace(/\\cap/g, '\u2229').replace(/\\cup/g, '\u222A')
    .replace(/\\emptyset/g, '\u2205').replace(/\\in/g, '\u2208').replace(/\\notin/g, '\u2209')
    .replace(/\\subset/g, '\u2282').replace(/\\supset/g, '\u2283').replace(/\\subseteq/g, '\u2286').replace(/\\supseteq/g, '\u2287')
    .replace(/\\forall/g, '\u2200').replace(/\\exists/g, '\u2203').replace(/\\neg/g, '\u00AC')
    .replace(/\\vee/g, '\u2228').replace(/\\wedge/g, '\u2227').replace(/\\therefore/g, '\u2234').replace(/\\because/g, '\u2235')
    .replace(/\\rightarrow/g, '\u2192').replace(/\\leftarrow/g, '\u2190').replace(/\\leftrightarrow/g, '\u2194')
    .replace(/\\Rightarrow/g, '\u21D2').replace(/\\Leftarrow/g, '\u21D0').replace(/\\Leftrightarrow/g, '\u21D4')
    .replace(/\\to/g, '\u2192').replace(/\\gets/g, '\u2190').replace(/\\implies/g, '\u21D2').replace(/\\iff/g, '\u21D4')
    .replace(/\\mapsto/g, '\u21A6').replace(/\\uparrow/g, '\u2191').replace(/\\downarrow/g, '\u2193')
    .replace(/\\log/g, 'log').replace(/\\ln/g, 'ln').replace(/\\sin/g, 'sin').replace(/\\cos/g, 'cos')
    .replace(/\\tan/g, 'tan').replace(/\\cot/g, 'cot').replace(/\\sec/g, 'sec').replace(/\\csc/g, 'csc')
    .replace(/\\arcsin/g, 'arcsin').replace(/\\arccos/g, 'arccos').replace(/\\arctan/g, 'arctan')
    .replace(/\\sinh/g, 'sinh').replace(/\\cosh/g, 'cosh').replace(/\\tanh/g, 'tanh')
    .replace(/\\lim/g, 'lim').replace(/\\limsup/g, 'lim sup').replace(/\\liminf/g, 'lim inf')
    .replace(/\\sup/g, 'sup').replace(/\\inf/g, 'inf').replace(/\\max/g, 'max').replace(/\\min/g, 'min')
    .replace(/\\exp/g, 'exp').replace(/\\det/g, 'det').replace(/\\arg/g, 'arg').replace(/\\dim/g, 'dim')
    .replace(/\\ker/g, 'ker').replace(/\\hom/g, 'hom').replace(/\\Pr/g, 'Pr').replace(/\\gcd/g, 'gcd')
    .replace(/\\text\{([^}]*)\}/g, '$1').replace(/\\mathrm\{([^}]*)\}/g, '$1').replace(/\\mathbf\{([^}]*)\}/g, '$1')
    .replace(/\\mathbb\{([^}]*)\}/g, '$1').replace(/\\mathcal\{([^}]*)\}/g, '$1')
    .replace(/\\operatorname\{([^}]*)\}/g, '$1').replace(/\\textrm\{([^}]*)\}/g, '$1')
    .replace(/\\textit\{([^}]*)\}/g, '$1').replace(/\\textbf\{([^}]*)\}/g, '$1')
    .replace(/\\left/g, '').replace(/\\right/g, '').replace(/\\bigg?/g, '').replace(/\\Bigg?/g, '')
    .replace(/\^{([^}]*)}/g, '^($1)').replace(/_{([^}]*)}/g, '_($1)')
    .replace(/\\,/g, ' ').replace(/\\;/g, ' ').replace(/\\!/g, '').replace(/\\ /g, ' ')
    .replace(/\\quad/g, '  ').replace(/\\qquad/g, '    ')
    .replace(/\\\[/g, '').replace(/\\\]/g, '').replace(/\\\(/g, '').replace(/\\\)/g, '')
    .replace(/\{/g, '').replace(/\}/g, '').replace(/~/g, ' ').replace(/\s+/g, ' ').trim();
}

// ─── Types ────────────────────────────────────────────────────────────────

interface Sec {
  type: 'h' | 'p' | 'code' | 'list' | 'table' | 'img' | 'formula' | 'carousel' | 'hr';
  lvl?: number; content: string; items?: string[]; rows?: string[][];
  imgData?: Buffer; imgW?: number; imgH?: number;
  imgs?: { buffer: Buffer; w: number; h: number; alt?: string }[];
}

interface Page { url: string; title: string; secs: Sec[]; imgs: { buffer: Buffer; w: number; h: number }[]; formulas: string[]; links: string[]; }

// ─── Scraper ───────────────────────────────────────────────────────────────

async function scrape(url: string, zai: any, topic: string, db: any, visited: Map<string, string>): Promise<Page | null> {
  // Cross-ref check
  const existing = visited.get(url);
  if (existing) { console.log(`  [XREF] Already in "${existing}": ${url}`); return null; }

  console.log(`  [FETCH] ${url}`);
  const result = await zai.functions.invoke('page_reader', { url });
  if (!result.data?.html) { console.log(`  [SKIP] No content: ${url}`); return null; }

  const html = result.data.html;
  const $ = cheerio.load(html);
  const title = result.data.title || $('h1').first().text().trim() || 'Untitled';
  const secs: Sec[] = [];
  const imgs: { buffer: Buffer; w: number; h: number }[] = [];
  const formulas: string[] = [];
  const seen = new Set<string>();
  const seenImg = new Set<string>();
  const seenF = new Set<string>();

  const area = $('article .article-content, .entry-content, article, .post-content, main .content, [class*="article"], [class*="viewer"], [class*="ArticlePage"]').first();
  const root = area.length > 0 ? area : $.root();
  const cl = root.clone();
  cl.find('script, style, nav, footer, header, .sidebar, .navigation, .breadcrumb, .share, .social, .comments, .related, .ad, .advertisement, .widget, .popup, .modal').remove();

  // Carousel images
  const carImgs: { url: string; alt?: string }[] = [];
  cl.find('.carousel-slide img, .slider img, .swiper-slide img, [class*="carousel"] img, [class*="slider"] img, .wp-block-image img, .featured-img img, .thumb-item img, [class*="course"] img').each((_i: number, el: any) => {
    let src = $(el).attr('src') || $(el).attr('data-src') || '';
    if (src && !src.startsWith('data:') && !seenImg.has(src)) {
      if (src.startsWith('//')) src = 'https:' + src;
      if (src.startsWith('/')) src = new URL(url).origin + src;
      seenImg.add(src); carImgs.push({ url: src, alt: $(el).attr('alt') || undefined });
    }
  });
  if (carImgs.length > 0) {
    console.log(`  [CAROUSEL] ${carImgs.length} images`);
    const dl: { buffer: Buffer; w: number; h: number; alt?: string }[] = [];
    for (let i = 0; i < Math.min(carImgs.length, 30); i++) {
      const r = await dlImg(carImgs[i].url);
      if (r) { dl.push({ ...r, alt: carImgs[i].alt }); imgs.push({ buffer: r.buffer, w: r.w, h: r.h }); }
      await new Promise(r => setTimeout(r, 200));
    }
    if (dl.length > 0) secs.push({ type: 'carousel', content: 'Featured Images', imgs: dl });
  }

  // DOM walker
  async function walk(el: any, d = 0) {
    if (d > 20) return;
    const tag = (el as any).prop('tagName')?.toLowerCase() || '';

    if (el.hasClass('mathjax') || el.hasClass('MathJax') || el.hasClass('math-display') || el.hasClass('katex-display') || tag === 'math' || el.attr('type')?.includes('math/tex')) {
      const raw = el.attr('type')?.includes('math/tex') ? (el.html() || '') : (el.find('annotation[encoding="application/x-tex"]').text() || el.text() || '');
      const c = raw.replace(/\s+/g, ' ').trim();
      if (c.length > 2 && !seenF.has(c)) { seenF.add(c); formulas.push(c); secs.push({ type: 'formula', content: c }); }
      return;
    }
    if (/^h[1-6]$/.test(tag)) { const t = el.text().trim(); if (t.length > 1 && !seen.has(t)) { seen.add(t); secs.push({ type: 'h', lvl: parseInt(tag[1]), content: t }); } return; }
    if (tag === 'pre' || el.hasClass('code-block') || el.hasClass('highlight') || el.hasClass('Syntax')) {
      const code = (el.find('code').text() || el.text()).trim();
      if (code.length > 5 && !seen.has(code)) { seen.add(code); secs.push({ type: 'code', content: code.substring(0, 8000) }); } return;
    }
    if (tag === 'table') {
      const rows: string[][] = [];
      el.find('tr').each((_ri: number, row: any) => { const c: string[] = []; $(row).find('th, td').each((_ci: number, cell: any) => c.push($(cell).text().trim().replace(/\s+/g, ' '))); if (c.length) rows.push(c); });
      if (rows.length) { const k = rows.map(r => r.join('|')).join('\n'); if (!seen.has(k)) { seen.add(k); secs.push({ type: 'table', rows }); } } return;
    }
    if (tag === 'ul' || tag === 'ol') {
      const items: string[] = [];
      el.find('> li').each((_li: number, li: any) => { const t = $(li).text().trim().replace(/\s+/g, ' '); if (t.length > 2) items.push(t); });
      if (items.length) { const k = items.join('\n'); if (!seen.has(k)) { seen.add(k); secs.push({ type: 'list', items }); } } return;
    }
    if (tag === 'img') {
      let src = $(el).attr('src') || $(el).attr('data-src') || '';
      if (!src || src.startsWith('data:') || seenImg.has(src)) return;
      const w = parseInt($(el).attr('width') || '0'), h = parseInt($(el).attr('height') || '0');
      if ((w > 0 && w < 40) || (h > 0 && h < 40) || src.includes('pixel') || src.includes('spacer')) return;
      if (src.startsWith('//')) src = 'https:' + src;
      if (src.startsWith('/')) src = new URL(url).origin + src;
      seenImg.add(src);
      const r = await dlImg(src);
      if (r) { imgs.push({ buffer: r.buffer, w: r.w, h: r.h }); secs.push({ type: 'img', content: src, imgData: r.buffer, imgW: r.w, imgH: r.h }); }
      await new Promise(r => setTimeout(r, 150));
      return;
    }
    if (tag === 'hr') { secs.push({ type: 'hr', content: '' }); return; }
    if (tag === 'p') {
      const fe = el.find('.mathjax, .MathJax, .katex, math, script[type*="math/tex"]').first();
      if (fe.length) {
        const raw = fe.attr('type')?.includes('math/tex') ? (fe.html() || '') : (fe.find('annotation[encoding="application/x-tex"]').text() || fe.text() || '');
        const c = raw.replace(/\s+/g, ' ').trim();
        if (c.length > 2 && !seenF.has(c)) { seenF.add(c); formulas.push(c); secs.push({ type: 'formula', content: c }); }
        const surr = el.clone().find('.mathjax, .MathJax, .katex, math, script[type*="math/tex"]').remove().end().text().trim().replace(/\s+/g, ' ');
        if (surr.length > 10 && !seen.has(surr)) { seen.add(surr); secs.push({ type: 'p', content: surr }); }
      } else { const t = el.text().trim().replace(/\s+/g, ' '); if (t.length > 10 && !seen.has(t)) { seen.add(t); secs.push({ type: 'p', content: t }); } }
      return;
    }
    if (['div', 'section', 'article', 'main', 'span', 'figure', 'figcaption', 'aside', 'details', 'summary'].includes(tag))
      for (const child of el.children().toArray()) await walk($(child), d + 1);
  }

  for (const child of cl.children().toArray()) await walk($(child));

  // Fallback
  if (!secs.filter(s => s.type === 'h' || s.type === 'p').length) {
    const text = cl.text().replace(/\s+/g, ' ').trim();
    for (const p of text.split(/\n\n|(?<=[.!?])\s+(?=[A-Z])/).filter(p => p.trim().length > 20).slice(0, 20))
      if (!seen.has(p.trim())) { seen.add(p.trim()); secs.push({ type: 'p', content: p.trim() }); }
  }

  // Links
  const baseUrl = new URL(url);
  const links: string[] = [];
  const seenL = new Set<string>();
  $('a[href]').each((_i: number, el: any) => {
    let href = $(el).attr('href') || '';
    if (!href || href.startsWith('#') || href.startsWith('javascript:')) return;
    if (href.startsWith('//')) href = 'https:' + href;
    else if (href.startsWith('/')) href = baseUrl.origin + href;
    try {
      const lu = new URL(href);
      if (lu.hostname.includes('geeksforgeeks.org') && !seenL.has(href) && href !== url) {
        seenL.add(href);
        const pp = lu.pathname.split('/').filter(Boolean);
        if (pp.length >= 2 && !href.match(/\/(courses|practice|company|explore|jobs|contribute|events|premium)$/) && !href.match(/\.(jpg|jpeg|png|gif|svg|webp|css|js)$/i))
          links.push(href);
      }
    } catch { /* skip */ }
  });
  links.splice(15);

  visited.set(url, topic);
  try { await db.scrapedPage.upsert({ where: { url }, update: { title, topic, sectionCount: secs.length, imageCount: imgs.length, formulaCount: formulas.length, childLinks: JSON.stringify(links) }, create: { url, title, topic, sectionCount: secs.length, imageCount: imgs.length, formulaCount: formulas.length, childLinks: JSON.stringify(links), checksum: crypto.createHash('sha256').update(url).digest('hex').substring(0, 16) } }); } catch { /* ignore */ }

  console.log(`  [DONE] ${title} (${secs.length} sections, ${imgs.length} images, ${formulas.length} formulas, ${links.length} links)`);
  if (title.includes('404')) { console.log('  [SKIP] 404 page'); return null; }
  return { url, title, secs, imgs, formulas, links };
}

// ─── Docx ─────────────────────────────────────────────────────────────────

function mkDoc(pages: Page[], topic: string): (Paragraph | Table)[] {
  const c: (Paragraph | Table)[] = [];

  c.push(new Paragraph({ spacing: { before: 2400 }, children: [] }));
  c.push(new Paragraph({ children: [new TextRun({ text: topic, bold: true, size: 52, font: 'Calibri', color: '1a5632' })], alignment: AlignmentType.CENTER, spacing: { after: 200 } }));
  c.push(new Paragraph({ children: [new TextRun({ text: 'Comprehensive Study Notes from GeeksforGeeks', size: 26, font: 'Calibri', color: '555555' })], alignment: AlignmentType.CENTER, spacing: { after: 100 } }));
  c.push(new Paragraph({ children: [new TextRun({ text: `Generated: ${new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' })}`, size: 20, font: 'Calibri', color: '999999' })], alignment: AlignmentType.CENTER, spacing: { after: 80 } }));
  const totalImg = pages.reduce((s, p) => s + p.imgs.length, 0);
  const totalF = pages.reduce((s, p) => s + p.formulas.length, 0);
  c.push(new Paragraph({ children: [new TextRun({ text: `${pages.length} pages | ${totalImg} images | ${totalF} formulas`, size: 20, font: 'Calibri', color: '999999', italics: true })], alignment: AlignmentType.CENTER, spacing: { after: 400 } }));
  c.push(new Paragraph({ children: [new PageBreak()] }));

  for (let pi = 0; pi < pages.length; pi++) {
    const pg = pages[pi];
    c.push(new Paragraph({ children: [new TextRun({ text: pg.title, bold: true, size: 36, font: 'Calibri', color: '1a5632' })], heading: HeadingLevel.HEADING_1, spacing: { after: 80 }, border: { bottom: { style: BorderStyle.SINGLE, size: 8, color: '2d6a4f' } } }));
    c.push(new Paragraph({ children: [new ExternalHyperlink({ children: [new TextRun({ text: pg.url, style: 'Hyperlink', size: 18, font: 'Calibri' })], link: pg.url })], spacing: { after: 250 } }));

    for (const s of pg.secs) {
      if (s.type === 'h') {
        const l = Math.min(s.lvl || 2, 4) as 1 | 2 | 3 | 4;
        const hm: Record<number, any> = { 1: HeadingLevel.HEADING_1, 2: HeadingLevel.HEADING_2, 3: HeadingLevel.HEADING_3, 4: HeadingLevel.HEADING_4 };
        const sm: Record<number, number> = { 1: 32, 2: 28, 3: 24, 4: 22 };
        c.push(new Paragraph({ children: [new TextRun({ text: s.content, bold: true, size: sm[l] || 26, font: 'Calibri', color: l <= 2 ? '1a5632' : '333333' })], heading: hm[l] || HeadingLevel.HEADING_2, spacing: { before: 300, after: 150 } }));
      } else if (s.type === 'p') {
        const t = s.content.replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/\s+/g, ' ').trim();
        if (t.length < 3) continue;
        c.push(new Paragraph({ children: [new TextRun({ text: t, size: 22, font: 'Calibri' })], spacing: { after: 150, line: 312 }, alignment: AlignmentType.JUSTIFIED }));
      } else if (s.type === 'formula') {
        const rendered = tex(s.content);
        c.push(new Paragraph({ children: [new TextRun({ text: rendered, italics: true, size: 22, font: 'Cambria Math', color: '1a1a2e' })], spacing: { before: 250, after: 250, line: 360 }, alignment: AlignmentType.CENTER, indent: { left: 720, right: 720 }, border: { top: { style: BorderStyle.SINGLE, size: 2, color: 'd0d0d0' }, bottom: { style: BorderStyle.SINGLE, size: 2, color: 'd0d0d0' }, left: { style: BorderStyle.SINGLE, size: 6, color: '2d6a4f' } }, shading: { type: ShadingType.CLEAR, fill: 'f0f7f4' } }));
        c.push(new Paragraph({ children: [new TextRun({ text: `LaTeX: ${s.content}`, size: 16, font: 'Consolas', color: 'bbbbbb' })], spacing: { after: 200 }, alignment: AlignmentType.CENTER }));
      } else if (s.type === 'img' && s.imgData && s.imgData.length > 100) {
        try {
          const maxW = 520; let w = s.imgW || 580, h = s.imgH || 360;
          if (w > maxW) { const sc = maxW / w; w = maxW; h = Math.round(h * sc); }
          c.push(new Paragraph({ children: [new ImageRun({ data: s.imgData, transformation: { width: w, height: h }, type: 'png' })], spacing: { before: 200, after: 100 }, alignment: AlignmentType.CENTER }));
        } catch { /* skip */ }
      } else if (s.type === 'carousel' && s.imgs) {
        c.push(new Paragraph({ children: [new TextRun({ text: 'Featured Images', bold: true, size: 22, font: 'Calibri', color: '555555' })], spacing: { before: 200, after: 100 }, alignment: AlignmentType.CENTER }));
        for (let i = 0; i < s.imgs.length; i++) {
          const im = s.imgs[i];
          if (im.buffer.length > 100) try {
            const maxW = 520; let w = im.w || 580, h = im.h || 360;
            if (w > maxW) { const sc = maxW / w; w = maxW; h = Math.round(h * sc); }
            c.push(new Paragraph({ children: [new ImageRun({ data: im.buffer, transformation: { width: w, height: h }, type: 'png' })], spacing: { before: 150, after: 80 }, alignment: AlignmentType.CENTER }));
            if (im.alt) c.push(new Paragraph({ children: [new TextRun({ text: `Figure ${i + 1}: ${im.alt}`, italics: true, size: 18, color: '888888', font: 'Calibri' })], spacing: { after: 150 }, alignment: AlignmentType.CENTER }));
          } catch { /* skip */ }
        }
      } else if (s.type === 'code') {
        c.push(new Paragraph({ children: [new TextRun({ text: 'Code', bold: true, size: 20, font: 'Calibri', color: '444444' })], spacing: { before: 150, after: 50 }, shading: { type: ShadingType.CLEAR, fill: 'e8e8e8' } }));
        for (const line of s.content.split('\n')) c.push(new Paragraph({ children: [new TextRun({ text: line || ' ', size: 18, font: 'Consolas' })], spacing: { after: 0, line: 240 }, indent: { left: 360 }, shading: { type: ShadingType.CLEAR, fill: 'f5f5f5' } }));
        c.push(new Paragraph({ children: [], spacing: { after: 150 } }));
      } else if (s.type === 'list' && s.items) {
        for (const item of s.items) c.push(new Paragraph({ children: [new TextRun({ text: '\u2022  ' + item.replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim(), size: 22, font: 'Calibri' })], spacing: { after: 80, line: 312 }, indent: { left: 540, hanging: 180 } }));
      } else if (s.type === 'table' && s.rows && s.rows.length > 0) {
        const rows = s.rows.map((row, ri) => new TableRow({ tableHeader: ri === 0, cantSplit: true, children: row.map(cell => new TableCell({ children: [new Paragraph({ children: [new TextRun({ text: cell, bold: ri === 0, size: 20, font: 'Calibri', color: ri === 0 ? 'ffffff' : '333333' })], spacing: { after: 60 } })], shading: ri === 0 ? { type: ShadingType.CLEAR, fill: '2d6a4f', color: 'auto' } : ri % 2 === 0 ? { type: ShadingType.CLEAR, fill: 'f0f7f4', color: 'auto' } : undefined, margins: { top: 40, bottom: 40, left: 100, right: 100 } })) }));
        c.push(new Table({ rows, width: { size: 100, type: WidthType.PERCENTAGE } }));
        c.push(new Paragraph({ children: [], spacing: { after: 200 } }));
      } else if (s.type === 'hr') {
        c.push(new Paragraph({ children: [], spacing: { before: 100, after: 100 }, border: { bottom: { style: BorderStyle.SINGLE, size: 2, color: 'd0d0d0' } } }));
      }
    }
    if (pi < pages.length - 1) c.push(new Paragraph({ children: [new PageBreak()] }));
  }
  return c;
}

// ─── Main ─────────────────────────────────────────────────────────────────

async function main() {
  const TOPIC = 'NLP';
  const START_URL = 'https://www.geeksforgeeks.org/natural-language-processing-nlp-tutorial/';
  const DEPTH = 2;
  const MAX_PAGES = 20;

  console.log(`=== GFG Scraper: "${TOPIC}" from ${START_URL} (depth=${DEPTH}, max=${MAX_PAGES}) ===`);

  const ZAI = (await import('z-ai-web-dev-sdk')).default;
  const zai = await ZAI.create();
  const db = new PrismaClient();

  // Load existing pages for cross-referencing
  const visited = new Map<string, string>();
  try {
    const existing = await db.scrapedPage.findMany({ select: { url: true, topic: true } });
    for (const r of existing) visited.set(r.url, r.topic);
    console.log(`Loaded ${existing.length} existing pages from DB`);
  } catch { console.log('No existing pages in DB'); }

  const pages: Page[] = [];
  const queue: { url: string; d: number }[] = [{ url: START_URL, d: 0 }];
  const seen = new Set<string>();
  let xrefCount = 0;

  while (queue.length > 0 && pages.length < MAX_PAGES) {
    const { url, d } = queue.shift()!;
    if (seen.has(url) || d > DEPTH) continue;
    seen.add(url);

    try {
      const page = await scrape(url, zai, TOPIC, db, visited);
      if (page) {
        pages.push(page);
        if (d < DEPTH) {
          for (const link of page.links) {
            if (!visited.has(link) && pages.length + queue.length < MAX_PAGES) {
              queue.push({ url: link, d: d + 1 });
              console.log(`  [LINK] + ${link}`);
            }
          }
        }
      } else { xrefCount++; }
    } catch (err: any) { console.log(`  [ERR] ${url}: ${err.message}`); }
    if (queue.length > 0) await new Promise(r => setTimeout(r, 1200));
  }

  console.log(`\n=== GENERATING DOCX: ${pages.length} pages, ${xrefCount} cross-referenced ===`);

  const fileName = `GFG_${TOPIC}_${new Date().toISOString().replace(/[:.]/g, '-').substring(0, 19)}.docx`;
  const doc = new Document({ sections: [{ properties: { page: { margin: { top: 720, bottom: 720, left: 900, right: 900 } } }, children: mkDoc(pages, TOPIC) }] });
  const filePath = path.join(DOWNLOAD_DIR, fileName);
  fs.writeFileSync(filePath, await Packer.toBuffer(doc));

  // Update topic
  try { await db.topic.upsert({ where: { name: TOPIC }, update: { pageCount: pages.length, fileName, depth: DEPTH, updatedAt: new Date() }, create: { name: TOPIC, pageCount: pages.length, startUrl: START_URL, depth: DEPTH, fileName } }); } catch { /* ignore */ }

  console.log(`\n=== COMPLETE ===`);
  console.log(`File: ${filePath}`);
  console.log(`Pages: ${pages.length}, Images: ${pages.reduce((s, p) => s + p.imgs.length, 0)}, Formulas: ${pages.reduce((s, p) => s + p.formulas.length, 0)}, Cross-referenced: ${xrefCount}`);

  await db.$disconnect();
}

main().catch(e => { console.error('FATAL:', e); process.exit(1); });