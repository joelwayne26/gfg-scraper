import { createServer } from 'http';
import { Server } from 'socket.io';
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

const DOWNLOAD_DIR = '/home/z/my-project/download';
const IMAGES_DIR = '/home/z/my-project/images';
const MAX_PAGES = 20;
const MAX_CHILD_LINKS = 15;
const MAX_IMG_W = 600;

if (!fs.existsSync(DOWNLOAD_DIR)) fs.mkdirSync(DOWNLOAD_DIR, { recursive: true });
if (!fs.existsSync(IMAGES_DIR)) fs.mkdirSync(IMAGES_DIR, { recursive: true });

// ─── Types ────────────────────────────────────────────────────────────────

interface ContentSection {
  type: 'heading' | 'paragraph' | 'code' | 'list' | 'table' | 'image' | 'formula' | 'carousel' | 'hr';
  level?: number; content: string; items?: string[]; rows?: string[][];
  imageData?: Buffer; imageExt?: string; imageWidth?: number; imageHeight?: number;
  images?: ProcessedImage[];
}

interface ProcessedImage { buffer: Buffer; ext: string; width: number; height: number; alt?: string; }

interface ScrapedPage { url: string; title: string; sections: ContentSection[]; images: ProcessedImage[]; formulas: string[]; childLinks: string[]; }

interface ScrapeProgress {
  type: 'status' | 'page_done' | 'image_done' | 'error' | 'complete' | 'link_found' | 'xref_found' | 'topic_done';
  message: string; current?: number; total?: number; url?: string; filePath?: string; fileName?: string;
  topic?: string; pagesScraped?: number; pagesReferenced?: number; imagesDownloaded?: number;
}

// ─── Page Registry (cross-topic dedup) ─────────────────────────────────────

const pageRegistry = new Map<string, { title: string; topic: string }>();

// Load from DB
async function loadRegistry() {
  try {
    const { PrismaClient } = require('@prisma/client');
    const db = new PrismaClient();
    const rows = await db.scrapedPage.findMany({ select: { url: true, title: true, topic: true } });
    for (const r of rows) pageRegistry.set(r.url, { title: r.title, topic: r.topic });
    await db.$disconnect();
    console.log(`Registry: loaded ${rows.length} pages`);
  } catch { console.log('Registry: starting fresh (no DB)'); }
}

async function saveToDB(page: ScrapedPage, topic: string) {
  try {
    const { PrismaClient } = require('@prisma/client');
    const db = new PrismaClient();
    await db.scrapedPage.upsert({
      where: { url: page.url },
      update: { title: page.title, topic, sectionCount: page.sections.length, imageCount: page.images.length, formulaCount: page.formulas.length, childLinks: JSON.stringify(page.childLinks) },
      create: { url: page.url, title: page.title, topic, sectionCount: page.sections.length, imageCount: page.images.length, formulaCount: page.formulas.length, childLinks: JSON.stringify(page.childLinks), checksum: crypto.createHash('sha256').update(page.url).digest('hex').substring(0, 16) },
    });
    await db.topic.upsert({
      where: { name: topic },
      update: { pageCount: { increment: 1 }, updatedAt: new Date() },
      create: { name: topic, pageCount: 1, startUrl: page.url, depth: 0 },
    });
    await db.$disconnect();
  } catch { /* ignore */ }
}

// ─── Image Downloader ──────────────────────────────────────────────────────

async function downloadImage(url: string): Promise<ProcessedImage | null> {
  return new Promise((resolve) => {
    if (!url || (!url.startsWith('http://') && !url.startsWith('https://'))) { resolve(null); return; }
    const client = url.startsWith('https') ? https : http;
    const timeout = setTimeout(() => resolve(null), 20000);
    const req = client.get(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36', 'Accept': 'image/*,*/*;q=0.8', 'Referer': 'https://www.geeksforgeeks.org/' }
    }, (res) => {
      if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        clearTimeout(timeout); downloadImage(res.headers.location).then(resolve); return;
      }
      if (res.statusCode !== 200) { clearTimeout(timeout); resolve(null); return; }
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', async () => {
        clearTimeout(timeout);
        try {
          const raw = Buffer.concat(chunks);
          if (raw.length < 500) { resolve(null); return; }
          const meta = await sharp(raw).metadata();
          const w = meta.width || 580, h = meta.height || 360;
          const processed = w > MAX_IMG_W
            ? await sharp(raw).resize(MAX_IMG_W, null, { withoutEnlargement: true, fit: 'inside' }).png({ quality: 90 }).toBuffer()
            : await sharp(raw).png({ quality: 90 }).toBuffer();
          resolve({ buffer: processed, ext: '.png', width: w, height: h });
        } catch {
          const raw = Buffer.concat(chunks);
          resolve(raw.length > 500 ? { buffer: raw, ext: '.png', width: 580, height: 360 } : null);
        }
      });
      res.on('error', () => { clearTimeout(timeout); resolve(null); });
    });
    req.on('error', () => { clearTimeout(timeout); resolve(null); });
    req.setTimeout(20000, () => { req.destroy(); clearTimeout(timeout); resolve(null); });
  });
}

// ─── LaTeX Renderer ────────────────────────────────────────────────────────

function renderLatex(latex: string): string {
  return latex
    .replace(/\\frac\{([^}]*)\}\{([^}]*)\}/g, '($1)/($2)')
    .replace(/\\sqrt\[(\d+)\]\{([^}]*)\}/g, '\u221A[$1]($2)').replace(/\\sqrt\{([^}]*)\}/g, '\u221A($1)')
    .replace(/\\sum[^{]*/g, '\u2211').replace(/\\prod[^{]*/g, '\u220F').replace(/\\int[^{]*/g, '\u222B')
    .replace(/\\partial/g, '\u2202').replace(/\\nabla/g, '\u2207').replace(/\\infty/g, '\u221E')
    .replace(/\\alpha/g, '\u03B1').replace(/\\beta/g, '\u03B2').replace(/\\gamma/g, '\u03B3').replace(/\\delta/g, '\u03B4')
    .replace(/\\epsilon/g, '\u03B5').replace(/\\theta/g, '\u03B8').replace(/\\lambda/g, '\u03BB').replace(/\\mu/g, '\u03BC')
    .replace(/\\sigma/g, '\u03C3').replace(/\\omega/g, '\u03C9').replace(/\\pi/g, '\u03C0')
    .replace(/\\Gamma/g, '\u0393').replace(/\\Delta/g, '\u0394').replace(/\\Theta/g, '\u0398').replace(/\\Sigma/g, '\u03A3')
    .replace(/\\Omega/g, '\u03A9').replace(/\\Phi/g, '\u03A6').replace(/\\Psi/g, '\u03A8')
    .replace(/\\leq/g, '\u2264').replace(/\\geq/g, '\u2265').replace(/\\neq/g, '\u2260').replace(/\\approx/g, '\u2248')
    .replace(/\\equiv/g, '\u2261').replace(/\\propto/g, '\u221D').replace(/\\times/g, '\u00D7').replace(/\\div/g, '\u00F7')
    .replace(/\\pm/g, '\u00B1').replace(/\\mp/g, '\u2213').replace(/\\cdot/g, '\u00B7').replace(/\\cdots/g, '\u22EF')
    .replace(/\\ldots/g, '\u2026').replace(/\\in/g, '\u2208').replace(/\\notin/g, '\u2209')
    .replace(/\\subset/g, '\u2282').replace(/\\supset/g, '\u2283').replace(/\\cup/g, '\u222A').replace(/\\cap/g, '\u2229')
    .replace(/\\emptyset/g, '\u2205').replace(/\\forall/g, '\u2200').replace(/\\exists/g, '\u2203')
    .replace(/\\rightarrow/g, '\u2192').replace(/\\leftarrow/g, '\u2190').replace(/\\leftrightarrow/g, '\u2194')
    .replace(/\\Rightarrow/g, '\u21D2').replace(/\\Leftarrow/g, '\u21D0').replace(/\\Leftrightarrow/g, '\u21D4')
    .replace(/\\to/g, '\u2192').replace(/\\gets/g, '\u2190').replace(/\\implies/g, '\u21D2').replace(/\\iff/g, '\u21D4')
    .replace(/\\neg/g, '\u00AC').replace(/\\vee/g, '\u2228').replace(/\\wedge/g, '\u2227')
    .replace(/\\log/g, 'log').replace(/\\ln/g, 'ln').replace(/\\sin/g, 'sin').replace(/\\cos/g, 'cos')
    .replace(/\\tan/g, 'tan').replace(/\\lim/g, 'lim').replace(/\\max/g, 'max').replace(/\\min/g, 'min')
    .replace(/\\exp/g, 'exp').replace(/\\det/g, 'det').replace(/\\arg/g, 'arg')
    .replace(/\\text\{([^}]*)\}/g, '$1').replace(/\\mathrm\{([^}]*)\}/g, '$1').replace(/\\mathbf\{([^}]*)\}/g, '$1')
    .replace(/\\mathbb\{([^}]*)\}/g, '$1').replace(/\\operatorname\{([^}]*)\}/g, '$1')
    .replace(/\\left/g, '').replace(/\\right/g, '').replace(/\\big/g, '').replace(/\\Big/g, '')
    .replace(/\^{([^}]*)}/g, '^($1)').replace(/_{([^}]*)}/g, '_($1)')
    .replace(/\\,/g, ' ').replace(/\\;/g, ' ').replace(/\\!/g, '').replace(/\\ /g, ' ')
    .replace(/\\\[/g, '').replace(/\\\]/g, '').replace(/\\\(/g, '').replace(/\\\)/g, '')
    .replace(/\{/g, '').replace(/\}/g, '').replace(/~/g, ' ').replace(/\s+/g, ' ').trim();
}

// ─── ZAI SDK ───────────────────────────────────────────────────────────────

let zaiInstance: any = null;
async function getZAI() { if (!zaiInstance) zaiInstance = await (await import('z-ai-web-dev-sdk')).ZAI.create(); return zaiInstance; }

// ─── Page Scraper ──────────────────────────────────────────────────────────

async function scrapePage(url: string, topic: string, socket: any, progress: { current: number; total: number }): Promise<ScrapedPage | null> {
  // Cross-reference check
  const existing = pageRegistry.get(url);
  if (existing && existing.topic !== topic) {
    socket.emit('progress', { type: 'xref_found', message: `Already in "${existing.topic}": ${existing.title}`, url } as ScrapeProgress);
    return null;
  }
  if (existing && existing.topic === topic) return null;

  socket.emit('progress', { type: 'status', message: `Fetching: ${url}`, url, current: progress.current, total: progress.total } as ScrapeProgress);

  const zai = await getZAI();
  const result = await zai.functions.invoke('page_reader', { url });
  if (!result.data?.html) throw new Error(`No content from ${url}`);

  const html = result.data.html;
  const $ = cheerio.load(html);
  const title = result.data.title || $('h1').first().text().trim() || 'Untitled';
  const sections: ContentSection[] = [];
  const images: ProcessedImage[] = [];
  const formulas: string[] = [];
  const seen = new Set<string>();
  const seenImg = new Set<string>();
  const seenFormula = new Set<string>();
  let imgOrder = 0;

  const contentArea = $('article .article-content, .entry-content, article, .post-content, main .content').first();
  const root = contentArea.length > 0 ? contentArea : $.root();
  const clone = root.clone();
  clone.find('script, style, nav, footer, header, .sidebar, .navigation, .breadcrumb, .share, .social, .comments, .related, .ad, .advertisement, .widget, .popup, .modal').remove();

  // Carousel images
  const carouselImgs: { url: string; alt?: string }[] = [];
  clone.find('.carousel-slide img, .slider img, .swiper-slide img, [class*="carousel"] img, [class*="slider"] img, .wp-block-image img, .featured-img img, .thumb-item img, [class*="course"] img').each((_i: number, el: any) => {
    let src = $(el).attr('src') || $(el).attr('data-src') || '';
    if (src && !src.startsWith('data:') && !seenImg.has(src)) {
      if (src.startsWith('//')) src = 'https:' + src;
      if (src.startsWith('/')) src = new URL(url).origin + src;
      seenImg.add(src);
      carouselImgs.push({ url: src, alt: $(el).attr('alt') || undefined });
    }
  });

  if (carouselImgs.length > 0) {
    const downloaded: ProcessedImage[] = [];
    for (let i = 0; i < Math.min(carouselImgs.length, 30); i++) {
      socket.emit('progress', { type: 'image_done', message: `Carousel img ${i + 1}/${carouselImgs.length}`, url: carouselImgs[i].url } as ScrapeProgress);
      const img = await downloadImage(carouselImgs[i].url);
      if (img) { downloaded.push({ ...img, alt: carouselImgs[i].alt }); imgOrder++; images.push(img); }
      await new Promise(r => setTimeout(r, 250));
    }
    if (downloaded.length > 0) sections.push({ type: 'carousel', content: 'Featured Images', images: downloaded });
  }

  // DOM walker
  async function walk(el: any, depth = 0) {
    if (depth > 20) return;
    const tag = (el as any).prop('tagName')?.toLowerCase() || '';

    if (el.hasClass('mathjax') || el.hasClass('MathJax') || el.hasClass('math-display') || el.hasClass('katex-display') || tag === 'math' || el.attr('type')?.includes('math/tex')) {
      const raw = el.attr('type')?.includes('math/tex') ? (el.html() || '') : (el.find('annotation[encoding="application/x-tex"]').text() || el.text() || '');
      const c = raw.replace(/\s+/g, ' ').trim();
      if (c.length > 2 && !seenFormula.has(c)) { seenFormula.add(c); formulas.push(c); sections.push({ type: 'formula', content: c }); }
      return;
    }
    if (/^h[1-6]$/.test(tag)) {
      const t = el.text().trim();
      if (t.length > 1 && !seen.has(t)) { seen.add(t); sections.push({ type: 'heading', level: parseInt(tag[1]), content: t }); }
      return;
    }
    if (tag === 'pre' || el.hasClass('code-block') || el.hasClass('highlight') || el.hasClass('Syntax')) {
      const code = el.find('code').text() || el.text();
      const c = code.trim();
      if (c.length > 5 && !seen.has(c)) { seen.add(c); sections.push({ type: 'code', content: c.substring(0, 8000) }); }
      return;
    }
    if (tag === 'table') {
      const rows: string[][] = [];
      el.find('tr').each((_ri: number, row: any) => {
        const cells: string[] = [];
        $(row).find('th, td').each((_ci: number, cell: any) => cells.push($(cell).text().trim().replace(/\s+/g, ' ')));
        if (cells.length > 0) rows.push(cells);
      });
      if (rows.length > 0) { const k = rows.map(r => r.join('|')).join('\n'); if (!seen.has(k)) { seen.add(k); sections.push({ type: 'table', content: '', rows }); } }
      return;
    }
    if (tag === 'ul' || tag === 'ol') {
      const items: string[] = [];
      el.find('> li').each((_li: number, li: any) => { const t = $(li).text().trim().replace(/\s+/g, ' '); if (t.length > 2) items.push(t); });
      if (items.length > 0) { const k = items.join('\n'); if (!seen.has(k)) { seen.add(k); sections.push({ type: 'list', content: '', items }); } }
      return;
    }
    if (tag === 'img') {
      let src = $(el).attr('src') || $(el).attr('data-src') || '';
      if (!src || src.startsWith('data:') || seenImg.has(src)) return;
      const w = parseInt($(el).attr('width') || '0'), h = parseInt($(el).attr('height') || '0');
      if ((w > 0 && w < 40) || (h > 0 && h < 40)) return;
      if (src.includes('pixel') || src.includes('spacer')) return;
      if (src.startsWith('//')) src = 'https:' + src;
      if (src.startsWith('/')) src = new URL(url).origin + src;
      seenImg.add(src); imgOrder++;
      socket.emit('progress', { type: 'image_done', message: `Image ${imgOrder}`, url: src } as ScrapeProgress);
      const img = await downloadImage(src);
      if (img) { images.push(img); sections.push({ type: 'image', content: src, imageData: img.buffer, imageExt: img.ext, imageWidth: img.width, imageHeight: img.height }); }
      await new Promise(r => setTimeout(r, 200));
      return;
    }
    if (tag === 'hr') { sections.push({ type: 'hr', content: '' }); return; }
    if (tag === 'p') {
      const fe = el.find('.mathjax, .MathJax, .katex, math, script[type*="math/tex"]').first();
      if (fe.length > 0) {
        const raw = fe.attr('type')?.includes('math/tex') ? (fe.html() || '') : (fe.find('annotation[encoding="application/x-tex"]').text() || fe.text() || '');
        const c = raw.replace(/\s+/g, ' ').trim();
        if (c.length > 2 && !seenFormula.has(c)) { seenFormula.add(c); formulas.push(c); sections.push({ type: 'formula', content: c }); }
        const surr = el.clone().find('.mathjax, .MathJax, .katex, math, script[type*="math/tex"]').remove().end().text().trim().replace(/\s+/g, ' ');
        if (surr.length > 10 && !seen.has(surr)) { seen.add(surr); sections.push({ type: 'paragraph', content: surr }); }
      } else {
        const t = el.text().trim().replace(/\s+/g, ' ');
        if (t.length > 10 && !seen.has(t)) { seen.add(t); sections.push({ type: 'paragraph', content: t }); }
      }
      return;
    }
    if (['div', 'section', 'article', 'main', 'span', 'figure', 'figcaption', 'aside', 'details', 'summary'].includes(tag)) {
      for (const child of el.children().toArray()) await walk($(child), depth + 1);
    }
  }

  for (const child of clone.children().toArray()) await walk($(child));

  // Fallback
  if (sections.filter(s => s.type === 'heading' || s.type === 'paragraph').length === 0) {
    const text = clone.text().replace(/\s+/g, ' ').trim();
    if (text.length > 50) {
      const paras = text.split(/\n\n|(?<=[.!?])\s+(?=[A-Z])/).filter(p => p.trim().length > 20);
      for (const p of paras.slice(0, 20)) if (!seen.has(p.trim())) { seen.add(p.trim()); sections.push({ type: 'paragraph', content: p.trim() }); }
    }
  }

  // Child links
  const baseUrl = new URL(url);
  const childLinks: string[] = [];
  const seenLinks = new Set<string>();
  $('article a[href], .entry-content a[href], .article-content a[href], .related a[href]').each((_i: number, el: any) => {
    let href = $(el).attr('href') || '';
    if (!href || href.startsWith('#') || href.startsWith('javascript:')) return;
    if (href.startsWith('//')) href = 'https:' + href;
    else if (href.startsWith('/')) href = baseUrl.origin + href;
    try {
      const lu = new URL(href);
      if (lu.hostname.includes('geeksforgeeks.org') && !seenLinks.has(href) && href !== url) {
        seenLinks.add(href);
        const pp = lu.pathname.split('/').filter(Boolean);
        if (pp.length >= 2 && !href.match(/\/(courses|practice|company|explore|jobs|contribute|events|premium)$/) && !href.match(/\.(jpg|jpeg|png|gif|svg|webp|css|js)$/i)) childLinks.push(href);
      }
    } catch { /* skip */ }
  });
  childLinks.splice(MAX_CHILD_LINKS);

  pageRegistry.set(url, { title, topic });
  saveToDB({ url, title, sections, images, formulas, childLinks }, topic).catch(() => {});

  socket.emit('progress', { type: 'page_done', message: `Done: ${title} (${sections.length} sec, ${images.length} img, ${formulas.length} formulas)`, url } as ScrapeProgress);
  return { url, title, sections, images, formulas, childLinks };
}

// ─── Docx Generator ────────────────────────────────────────────────────────

async function generateDocx(pages: ScrapedPage[], topic: string, fileName: string): Promise<string> {
  const children: (Paragraph | Table)[] = [];

  // Cover
  children.push(new Paragraph({ spacing: { before: 2400 }, children: [] }));
  children.push(new Paragraph({ children: [new TextRun({ text: topic, bold: true, size: 52, font: 'Calibri', color: '1a5632' })], alignment: AlignmentType.CENTER, spacing: { after: 200 } }));
  children.push(new Paragraph({ children: [new TextRun({ text: 'Comprehensive Study Notes from GeeksforGeeks', size: 26, font: 'Calibri', color: '555555' })], alignment: AlignmentType.CENTER, spacing: { after: 100 } }));
  children.push(new Paragraph({ children: [new TextRun({ text: `Generated: ${new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' })}`, size: 20, font: 'Calibri', color: '999999' })], alignment: AlignmentType.CENTER, spacing: { after: 80 } }));
  children.push(new Paragraph({ children: [new TextRun({ text: `${pages.length} pages | ${pages.reduce((s, p) => s + p.images.length, 0)} images | ${pages.reduce((s, p) => s + p.formulas.length, 0)} formulas`, size: 20, font: 'Calibri', color: '999999', italics: true })], alignment: AlignmentType.CENTER, spacing: { after: 400 } }));
  children.push(new Paragraph({ children: [new PageBreak()] }));

  for (let pi = 0; pi < pages.length; pi++) {
    const page = pages[pi];
    children.push(new Paragraph({ children: [new TextRun({ text: page.title, bold: true, size: 36, font: 'Calibri', color: '1a5632' })], heading: HeadingLevel.HEADING_1, spacing: { after: 80 }, border: { bottom: { style: BorderStyle.SINGLE, size: 8, color: '2d6a4f' } } }));
    children.push(new Paragraph({ children: [new ExternalHyperlink({ children: [new TextRun({ text: page.url, style: 'Hyperlink', size: 18, font: 'Calibri' })], link: page.url })], spacing: { after: 250 } }));

    for (const sec of page.sections) {
      switch (sec.type) {
        case 'heading': {
          const lvl = Math.min(sec.level || 2, 4) as 1 | 2 | 3 | 4;
          const hm: Record<number, any> = { 1: HeadingLevel.HEADING_1, 2: HeadingLevel.HEADING_2, 3: HeadingLevel.HEADING_3, 4: HeadingLevel.HEADING_4 };
          const sm: Record<number, number> = { 1: 32, 2: 28, 3: 24, 4: 22 };
          children.push(new Paragraph({ children: [new TextRun({ text: sec.content, bold: true, size: sm[lvl] || 26, font: 'Calibri', color: lvl <= 2 ? '1a5632' : '333333' })], heading: hm[lvl] || HeadingLevel.HEADING_2, spacing: { before: 300, after: 150 } }));
          break;
        }
        case 'paragraph': {
          const c = sec.content.replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/\s+/g, ' ').trim();
          if (c.length < 3) continue;
          children.push(new Paragraph({ children: [new TextRun({ text: c, size: 22, font: 'Calibri' })], spacing: { after: 150, line: 312 }, alignment: AlignmentType.JUSTIFIED }));
          break;
        }
        case 'formula': {
          const rendered = renderLatex(sec.content);
          children.push(new Paragraph({ children: [new TextRun({ text: rendered, italics: true, size: 22, font: 'Cambria Math', color: '1a1a2e' })], spacing: { before: 250, after: 250, line: 360 }, alignment: AlignmentType.CENTER, indent: { left: 720, right: 720 }, border: { top: { style: BorderStyle.SINGLE, size: 2, color: 'd0d0d0' }, bottom: { style: BorderStyle.SINGLE, size: 2, color: 'd0d0d0' }, left: { style: BorderStyle.SINGLE, size: 6, color: '2d6a4f' } }, shading: { type: ShadingType.CLEAR, fill: 'f0f7f4' } }));
          children.push(new Paragraph({ children: [new TextRun({ text: `LaTeX: ${sec.content}`, size: 16, font: 'Consolas', color: 'bbbbbb' })], spacing: { after: 200 }, alignment: AlignmentType.CENTER }));
          break;
        }
        case 'image': {
          if (sec.imageData && sec.imageData.length > 100) {
            try {
              const maxW = 520; let w = sec.imageWidth || 580, h = sec.imageHeight || 360;
              if (w > maxW) { const s = maxW / w; w = maxW; h = Math.round(h * s); }
              children.push(new Paragraph({ children: [new ImageRun({ data: sec.imageData, transformation: { width: w, height: h }, type: 'png' })], spacing: { before: 200, after: 100 }, alignment: AlignmentType.CENTER }));
            } catch { children.push(new Paragraph({ children: [new TextRun({ text: `[Image: ${sec.content}]`, italics: true, size: 18, color: '999999', font: 'Calibri' })], spacing: { after: 100 }, alignment: AlignmentType.CENTER })); }
          }
          break;
        }
        case 'carousel': {
          children.push(new Paragraph({ children: [new TextRun({ text: sec.content || 'Featured Images', bold: true, size: 22, font: 'Calibri', color: '555555' })], spacing: { before: 200, after: 100 }, alignment: AlignmentType.CENTER }));
          if (sec.images) for (let i = 0; i < sec.images.length; i++) {
            const img = sec.images[i];
            if (img.buffer.length > 100) try {
              const maxW = 520; let w = img.width || 580, h = img.height || 360;
              if (w > maxW) { const s = maxW / w; w = maxW; h = Math.round(h * s); }
              children.push(new Paragraph({ children: [new ImageRun({ data: img.buffer, transformation: { width: w, height: h }, type: 'png' })], spacing: { before: 150, after: 80 }, alignment: AlignmentType.CENTER }));
              if (img.alt) children.push(new Paragraph({ children: [new TextRun({ text: `Figure ${i + 1}: ${img.alt}`, italics: true, size: 18, color: '888888', font: 'Calibri' })], spacing: { after: 150 }, alignment: AlignmentType.CENTER }));
            } catch { /* skip */ }
          }
          break;
        }
        case 'code': {
          children.push(new Paragraph({ children: [new TextRun({ text: 'Code', bold: true, size: 20, font: 'Calibri', color: '444444' })], spacing: { before: 150, after: 50 }, shading: { type: ShadingType.CLEAR, fill: 'e8e8e8' } }));
          for (const line of sec.content.split('\n')) children.push(new Paragraph({ children: [new TextRun({ text: line || ' ', size: 18, font: 'Consolas' })], spacing: { after: 0, line: 240 }, indent: { left: 360 }, shading: { type: ShadingType.CLEAR, fill: 'f5f5f5' } }));
          children.push(new Paragraph({ children: [], spacing: { after: 150 } }));
          break;
        }
        case 'list': {
          if (sec.items) for (const item of sec.items) children.push(new Paragraph({ children: [new TextRun({ text: '\u2022  ' + item.replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim(), size: 22, font: 'Calibri' })], spacing: { after: 80, line: 312 }, indent: { left: 540, hanging: 180 } }));
          break;
        }
        case 'table': {
          if (sec.rows && sec.rows.length > 0) {
            const rows = sec.rows.map((row, ri) => new TableRow({ tableHeader: ri === 0, cantSplit: true, children: row.map(cell => new TableCell({ children: [new Paragraph({ children: [new TextRun({ text: cell, bold: ri === 0, size: 20, font: 'Calibri', color: ri === 0 ? 'ffffff' : '333333' })], spacing: { after: 60 } })], shading: ri === 0 ? { type: ShadingType.CLEAR, fill: '2d6a4f', color: 'auto' } : ri % 2 === 0 ? { type: ShadingType.CLEAR, fill: 'f0f7f4', color: 'auto' } : undefined, margins: { top: 40, bottom: 40, left: 100, right: 100 } })) }));
            children.push(new Table({ rows, width: { size: 100, type: WidthType.PERCENTAGE } }));
            children.push(new Paragraph({ children: [], spacing: { after: 200 } }));
          }
          break;
        }
        case 'hr': children.push(new Paragraph({ children: [], spacing: { before: 100, after: 100 }, border: { bottom: { style: BorderStyle.SINGLE, size: 2, color: 'd0d0d0' } } })); break;
      }
    }
    if (pi < pages.length - 1) children.push(new Paragraph({ children: [new PageBreak()] }));
  }

  const doc = new Document({ sections: [{ properties: { page: { margin: { top: 720, bottom: 720, left: 900, right: 900 } } }, children }] });
  const filePath = path.join(DOWNLOAD_DIR, fileName);
  fs.writeFileSync(filePath, await Packer.toBuffer(doc));
  return filePath;
}

// ─── Server ────────────────────────────────────────────────────────────────

const httpServer = createServer();
const io = new Server(httpServer, { path: '/', cors: { origin: '*' }, pingTimeout: 120000, pingInterval: 25000 });

async function main() {
  await loadRegistry();

  io.on('connection', (socket) => {
    console.log(`Client: ${socket.id}`);
    socket.on('scrape', async (data: { url: string; depth: number; followLinks: boolean; topic?: string; maxPages?: number }) => {
      const { url, depth = 1, followLinks = true, topic = 'Untitled', maxPages = 15 } = data;
      if (!url) { socket.emit('progress', { type: 'error', message: 'URL required' }); return; }
      if (!url.startsWith('http')) { socket.emit('progress', { type: 'error', message: 'Invalid URL' }); return; }

      console.log(`[Scrape] ${url} topic="${topic}" depth=${depth} max=${maxPages}`);
      const visited = new Set<string>();
      const allPages: ScrapedPage[] = [];
      const queue: { url: string; d: number }[] = [{ url, d: 0 }];
      let xrefCount = 0;

      try {
        while (queue.length > 0 && allPages.length < maxPages) {
          const { url: qUrl, d } = queue.shift()!;
          if (visited.has(qUrl)) continue;
          visited.add(qUrl);
          if (d > depth) break;

          try {
            const page = await scrapePage(qUrl, topic, socket, { current: allPages.length + 1, total: visited.size + queue.length });
            if (page) {
              allPages.push(page);
              if (followLinks && d < depth) {
                for (const link of page.childLinks) {
                  if (!visited.has(link) && allPages.length + queue.length < maxPages) {
                    queue.push({ url: link, d: d + 1 });
                    socket.emit('progress', { type: 'link_found', message: `Found: ${link}`, url: link } as ScrapeProgress);
                  }
                }
              }
            } else { xrefCount++; }
          } catch (err: any) {
            socket.emit('progress', { type: 'error', message: `Failed: ${qUrl} - ${err.message}`, url: qUrl } as ScrapeProgress);
          }
          if (queue.length > 0) await new Promise(r => setTimeout(r, 1200));
        }

        socket.emit('progress', { type: 'status', message: 'Generating Word document...' } as ScrapeProgress);
        const ts = new Date().toISOString().replace(/[:.]/g, '-').substring(0, 19);
        const safeTopic = topic.replace(/[^a-zA-Z0-9]/g, '_').substring(0, 40);
        const fileName = `GFG_${safeTopic}_${ts}.docx`;
        await generateDocx(allPages, topic, fileName);

        // Update topic record
        try {
          const { PrismaClient } = require('@prisma/client');
          const db = new PrismaClient();
          await db.topic.upsert({ where: { name: topic }, update: { pageCount: allPages.length, fileName, depth, updatedAt: new Date() }, create: { name: topic, pageCount: allPages.length, startUrl: url, depth, fileName } });
          await db.$disconnect();
        } catch { /* ignore */ }

        socket.emit('progress', { type: 'complete', message: `Done! ${allPages.length} pages, ${xrefCount} cross-referenced, ${allPages.reduce((s, p) => s + p.images.length, 0)} images.`, fileName, filePath: `/download/${fileName}` } as ScrapeProgress);
      } catch (err: any) {
        socket.emit('progress', { type: 'error', message: `Scrape failed: ${err.message}` } as ScrapeProgress);
        console.error(err);
      }
    });
    socket.on('disconnect', () => console.log(`Disconnect: ${socket.id}`));
  });

  httpServer.listen(3004, () => console.log('Scrape service on port 3004'));
  process.on('SIGTERM', () => httpServer.close(() => process.exit(0)));
  process.on('SIGINT', () => httpServer.close(() => process.exit(0)));
}

main().catch(console.error);