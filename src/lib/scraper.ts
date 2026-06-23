import * as cheerio from 'cheerio';
import * as https from 'https';
import * as http from 'http';
import sharp from 'sharp';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

// ─── Config ────────────────────────────────────────────────────────────────
const MAX_PAGES = 20;
const MAX_CHILD_LINKS = 15;
const IMAGES_DIR = process.env.IMAGES_DIR || '/home/z/my-project/images';
const MAX_IMG_W = 600;

if (!fs.existsSync(IMAGES_DIR)) fs.mkdirSync(IMAGES_DIR, { recursive: true });

// ─── Types ─────────────────────────────────────────────────────────────────

export interface ContentSection {
  type: 'heading' | 'paragraph' | 'code' | 'list' | 'table' | 'image' | 'formula' | 'carousel' | 'hr' | 'xref';
  level?: number;
  content: string;
  items?: string[];
  rows?: string[][];
  imageData?: Buffer;
  imageExt?: string;
  imageWidth?: number;
  imageHeight?: number;
  images?: ProcessedImage[];
  refTopic?: string;
  refTitle?: string;
}

export interface ProcessedImage {
  buffer: Buffer;
  ext: string;
  width: number;
  height: number;
  alt?: string;
  localPath: string;
  fileName: string;
}

export interface ScrapedPageData {
  url: string;
  title: string;
  sections: ContentSection[];
  images: ProcessedImage[];
  formulas: string[];
  childLinks: string[];
  isNew: boolean;           // false if already scraped under another topic
  existingTopics: string[];  // topics where this page already exists
}

export interface CrossRefEntry {
  url: string;
  title: string;
  topics: string[];
}

export interface ScrapeEvent {
  type: 'status' | 'page_done' | 'image_done' | 'error' | 'complete' | 'link_found' | 'xref_found' | 'topic_done';
  message: string;
  current?: number;
  total?: number;
  url?: string;
  fileName?: string;
  topic?: string;
  pagesScraped?: number;
  pagesReferenced?: number;
  imagesDownloaded?: number;
}

// ─── In-memory page registry (cross-topic dedup) ──────────────────────────

const pageRegistry = new Map<string, { title: string; topic: string; scrapedAt: Date }>();

export function registerPage(url: string, title: string, topic: string) {
  pageRegistry.set(url, { title, topic, scrapedAt: new Date() });
}

export function checkPage(url: string): { title: string; topic: string; scrapedAt: Date } | undefined {
  return pageRegistry.get(url);
}

export function getAllPagesForTopic(topic: string): Map<string, { title: string; topic: string; scrapedAt: Date }> {
  const result = new Map<string, { title: string; topic: string; scrapedAt: Date }>();
  for (const [url, data] of pageRegistry) {
    if (data.topic === topic) result.set(url, data);
  }
  return result;
}

// Load from DB on startup (called by the API route)
export async function loadRegistryFromDB(db: any) {
  try {
    const existing = await db.scrapedPage.findMany({ select: { url: true, title: true, topic: true, scrapedAt: true } });
    for (const row of existing) {
      pageRegistry.set(row.url, { title: row.title, topic: row.topic, scrapedAt: row.scrapedAt });
    }
  } catch { /* DB might not be ready */ }
}

// ─── Image Downloader ──────────────────────────────────────────────────────

async function downloadAndProcessImage(url: string, imageDir: string): Promise<ProcessedImage | null> {
  return new Promise((resolve) => {
    if (!url || (!url.startsWith('http://') && !url.startsWith('https://'))) { resolve(null); return; }

    const client = url.startsWith('https') ? https : http;
    const timeout = setTimeout(() => resolve(null), 20000);
    const req = client.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Accept': 'image/webp,image/apng,image/*,*/*;q=0.8',
        'Referer': 'https://www.geeksforgeeks.org/',
      }
    }, (res) => {
      if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        clearTimeout(timeout);
        downloadAndProcessImage(res.headers.location, imageDir).then(resolve);
        return;
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
          const w = meta.width || 580;
          const h = meta.height || 360;
          let processed: Buffer;
          if (w > MAX_IMG_W) {
            processed = await sharp(raw).resize(MAX_IMG_W, null, { withoutEnlargement: true, fit: 'inside' }).png({ quality: 90 }).toBuffer();
          } else {
            processed = await sharp(raw).png({ quality: 90 }).toBuffer();
          }

          // Save to disk
          const hash = crypto.createHash('md5').update(url).digest('hex').substring(0, 12);
          const fileName = `img_${hash}.png`;
          const localPath = path.join(imageDir, fileName);
          fs.writeFileSync(localPath, processed);

          resolve({ buffer: processed, ext: '.png', width: w, height: h, localPath, fileName });
        } catch {
          const raw = Buffer.concat(chunks);
          if (raw.length > 500) {
            const hash = crypto.createHash('md5').update(url).digest('hex').substring(0, 12);
            const fileName = `img_${hash}.png`;
            const localPath = path.join(imageDir, fileName);
            fs.writeFileSync(localPath, raw);
            resolve({ buffer: raw, ext: '.png', width: 580, height: 360, localPath, fileName });
          } else { resolve(null); }
        }
      });
      res.on('error', () => { clearTimeout(timeout); resolve(null); });
    });
    req.on('error', () => { clearTimeout(timeout); resolve(null); });
    req.setTimeout(20000, () => { req.destroy(); clearTimeout(timeout); resolve(null); });
  });
}

// ─── LaTeX → Rich Unicode Text ─────────────────────────────────────────────

function renderLatex(latex: string): string {
  let t = latex
    // Fractions
    .replace(/\\frac\{([^}]*)\}\{([^}]*)\}/g, '($1)/($2)')
    // Roots
    .replace(/\\sqrt\[(\d+)\]\{([^}]*)\}/g, '\u221A[$1]($2)')
    .replace(/\\sqrt\{([^}]*)\}/g, '\u221A($1)')
    // Big operators
    .replace(/\\sum_?\{?([^}]*)\}?\^?\{?([^}]*)\}?/g, '\u2211')
    .replace(/\\prod_?\{?([^}]*)\}?\^?\{?([^}]*)\}?/g, '\u220F')
    .replace(/\\int_?\{?([^}]*)\}?\^?\{?([^}]*)\}?/g, '\u222B')
    .replace(/\\iint/g, '\u222C')
    .replace(/\\iiint/g, '\u222D')
    .replace(/\\oint/g, '\u222E')
    .replace(/\\partial/g, '\u2202')
    .replace(/\\nabla/g, '\u2207')
    // Greek lowercase
    .replace(/\\alpha/g, '\u03B1').replace(/\\beta/g, '\u03B2').replace(/\\gamma/g, '\u03B3')
    .replace(/\\delta/g, '\u03B4').replace(/\\epsilon/g, '\u03B5').replace(/\\varepsilon/g, '\u03B5')
    .replace(/\\zeta/g, '\u03B6').replace(/\\eta/g, '\u03B7').replace(/\\theta/g, '\u03B8')
    .replace(/\\vartheta/g, '\u03D1').replace(/\\iota/g, '\u03B9').replace(/\\kappa/g, '\u03BA')
    .replace(/\\lambda/g, '\u03BB').replace(/\\mu/g, '\u03BC').replace(/\\nu/g, '\u03BD')
    .replace(/\\xi/g, '\u03BE').replace(/\\pi/g, '\u03C0').replace(/\\varpi/g, '\u03D6')
    .replace(/\\rho/g, '\u03C1').replace(/\\sigma/g, '\u03C3').replace(/\\tau/g, '\u03C4')
    .replace(/\\upsilon/g, '\u03C5').replace(/\\phi/g, '\u03C6').replace(/\\varphi/g, '\u03C6')
    .replace(/\\chi/g, '\u03C7').replace(/\\psi/g, '\u03C8').replace(/\\omega/g, '\u03C9')
    // Greek uppercase
    .replace(/\\Gamma/g, '\u0393').replace(/\\Delta/g, '\u0394').replace(/\\Theta/g, '\u0398')
    .replace(/\\Lambda/g, '\u039B').replace(/\\Xi/g, '\u039E').replace(/\\Pi/g, '\u03A0')
    .replace(/\\Sigma/g, '\u03A3').replace(/\\Upsilon/g, '\u03A5').replace(/\\Phi/g, '\u03A6')
    .replace(/\\Psi/g, '\u03A8').replace(/\\Omega/g, '\u03A9')
    // Relations
    .replace(/\\leq/g, '\u2264').replace(/\\geq/g, '\u2265').replace(/\\neq/g, '\u2260')
    .replace(/\\approx/g, '\u2248').replace(/\\equiv/g, '\u2261').replace(/\\sim/g, '\u223C')
    .replace(/\\simeq/g, '\u2243').replace(/\\propto/g, '\u221D').replace(/\\cong/g, '\u2245')
    .replace(/\\ll/g, '\u226A').replace(/\\gg/g, '\u226B').replace(/\\prec/g, '\u227A')
    .replace(/\\succ/g, '\u227B').replace(/\\perp/g, '\u27C2').replace(/\\parallel/g, '\u2225')
    // Operators
    .replace(/\\times/g, '\u00D7').replace(/\\div/g, '\u00F7').replace(/\\pm/g, '\u00B1')
    .replace(/\\mp/g, '\u2213').replace(/\\cdot/g, '\u00B7').replace(/\\cdots/g, '\u22EF')
    .replace(/\\ldots/g, '\u2026').replace(/\\vdots/g, '\u22EE').replace(/\\ddots/g, '\u22F1')
    .replace(/\\oplus/g, '\u2295').replace(/\\otimes/g, '\u2297').replace(/\\cap/g, '\u2229')
    .replace(/\\cup/g, '\u222A').replace(/\\setminus/g, '\u2216').replace(/\\emptyset/g, '\u2205')
    .replace(/\\in/g, '\u2208').replace(/\\notin/g, '\u2209').replace(/\\subset/g, '\u2282')
    .replace(/\\supset/g, '\u2283').replace(/\\subseteq/g, '\u2286').replace(/\\supseteq/g, '\u2287')
    .replace(/\\intersection/g, '\u2229').replace(/\\union/g, '\u222A')
    // Arrows
    .replace(/\\rightarrow/g, '\u2192').replace(/\\leftarrow/g, '\u2190').replace(/\\leftrightarrow/g, '\u2194')
    .replace(/\\Rightarrow/g, '\u21D2').replace(/\\Leftarrow/g, '\u21D0').replace(/\\Leftrightarrow/g, '\u21D4')
    .replace(/\\uparrow/g, '\u2191').replace(/\\downarrow/g, '\u2193').replace(/\\mapsto/g, '\u21A6')
    .replace(/\\to/g, '\u2192').replace(/\\gets/g, '\u2190')
    .replace(/\\implies/g, '\u21D2').replace(/\\iff/g, '\u21D4')
    // Logic
    .replace(/\\forall/g, '\u2200').replace(/\\exists/g, '\u2203').replace(/\\neg/g, '\u00AC')
    .replace(/\\vee/g, '\u2228').replace(/\\wedge/g, '\u2227').replace(/\\therefore/g, '\u2234')
    .replace(/\\because/g, '\u2235')
    // Misc
    .replace(/\\infty/g, '\u221E').replace(/\\aleph/g, '\u2135').replace(/\\Re/g, '\u211C')
    .replace(/\\Im/g, '\u2111').replace(/\\wp/g, '\u2118').replace(/\\ell/g, '\u2113')
    .replace(/\\hbar/g, '\u210F').replace(/\\angle/g, '\u2220').replace(/\\deg/g, '\u00B0')
    .replace(/\\prime/g, '\u2032').replace(/\\backslash/g, '\\')
    // Functions
    .replace(/\\log_/g, 'log').replace(/\\ln/g, 'ln').replace(/\\sin/g, 'sin')
    .replace(/\\cos/g, 'cos').replace(/\\tan/g, 'tan').replace(/\\cot/g, 'cot')
    .replace(/\\sec/g, 'sec').replace(/\\csc/g, 'csc').replace(/\\arcsin/g, 'arcsin')
    .replace(/\\arccos/g, 'arccos').replace(/\\arctan/g, 'arctan')
    .replace(/\\sinh/g, 'sinh').replace(/\\cosh/g, 'cosh').replace(/\\tanh/g, 'tanh')
    .replace(/\\lim/g, 'lim').replace(/\\limsup/g, 'lim sup').replace(/\\liminf/g, 'lim inf')
    .replace(/\\sup/g, 'sup').replace(/\\inf/g, 'inf').replace(/\\max/g, 'max')
    .replace(/\\min/g, 'min').replace(/\\arg/g, 'arg').replace(/\\det/g, 'det')
    .replace(/\\exp/g, 'exp').replace(/\\dim/g, 'dim').replace(/\\ker/g, 'ker')
    .replace(/\\hom/g, 'hom').replace(/\\Pr/g, 'Pr').replace(/\\gcd/g, 'gcd')
    // Text commands
    .replace(/\\text\{([^}]*)\}/g, '$1')
    .replace(/\\mathrm\{([^}]*)\}/g, '$1')
    .replace(/\\mathbf\{([^}]*)\}/g, '$1')
    .replace(/\\mathbb\{([^}]*)\}/g, '$1')
    .replace(/\\mathcal\{([^}]*)\}/g, '$1')
    .replace(/\\operatorname\{([^}]*)\}/g, '$1')
    .replace(/\\textrm\{([^}]*)\}/g, '$1')
    .replace(/\\textit\{([^}]*)\}/g, '$1')
    .replace(/\\textbf\{([^}]*)\}/g, '$1')
    // Superscripts/subscripts
    .replace(/\^{([^}]*)}/g, '^($1)')
    .replace(/_{([^}]*)}/g, '_($1)')
    // Clean up
    .replace(/\\left/g, '').replace(/\\right/g, '')
    .replace(/\\big/g, '').replace(/\\Big/g, '').replace(/\\bigg/g, '').replace(/\\Bigg/g, '')
    .replace(/\\,/g, ' ').replace(/\\;/g, ' ').replace(/\\!/g, '').replace(/\\ /g, ' ')
    .replace(/\\quad/g, '  ').replace(/\\qquad/g, '    ')
    .replace(/\\\[/g, '').replace(/\\\]/g, '')
    .replace(/\\\(/g, '').replace(/\\\)/g, '')
    .replace(/\{/g, '').replace(/\}/g, '')
    .replace(/~/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return t;
}

export { renderLatex };

// ─── Page Scraper ──────────────────────────────────────────────────────────

async function fetchPageHtml(url: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const client = url.startsWith('https') ? https : http;
    const timeout = setTimeout(() => reject(new Error('Timeout fetching ' + url)), 30000);
    const req = client.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
      }
    }, (res) => {
      if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        clearTimeout(timeout);
        fetchPageHtml(res.headers.location).then(resolve).catch(reject);
        return;
      }
      if (res.statusCode !== 200) { clearTimeout(timeout); reject(new Error(`HTTP ${res.statusCode}`)); return; }
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => { clearTimeout(timeout); resolve(Buffer.concat(chunks).toString('utf-8')); });
      res.on('error', (e) => { clearTimeout(timeout); reject(e); });
    });
    req.on('error', (e) => { clearTimeout(timeout); reject(e); });
    req.setTimeout(30000, () => { req.destroy(); clearTimeout(timeout); reject(new Error('Timeout')); });
  });
}

export async function scrapePage(url: string, topic: string, emit: (e: ScrapeEvent) => void, imageDir: string = IMAGES_DIR): Promise<ScrapedPageData> {
  // ── Cross-reference check ──
  const existing = checkPage(url);
  if (existing && existing.topic !== topic) {
    emit({ type: 'xref_found', message: `Already scraped under "${existing.topic}": ${url}`, url, refTopic: existing.topic, refTitle: existing.title });
    return {
      url, title: existing.title, sections: [], images: [], formulas: [], childLinks: [],
      isNew: false, existingTopics: [existing.topic],
    };
  }
  if (existing && existing.topic === topic) {
    return {
      url, title: existing.title, sections: [], images: [], formulas: [], childLinks: [],
      isNew: false, existingTopics: [topic],
    };
  }

  emit({ type: 'status', message: `Fetching: ${url}`, url });

  const html = await fetchPageHtml(url);
  const $ = cheerio.load(html);
  const title = $('h1').first().text().trim() || $('title').text().trim() || path.basename(url).replace(/[-_]/g, ' ');

  const sections: ContentSection[] = [];
  const images: ProcessedImage[] = [];
  const formulas: string[] = [];
  let imageOrder = 0;

  // Content area
  const contentArea = $('article .article-content, .entry-content, article, .post-content, main .content').first();
  const root = contentArea.length > 0 ? contentArea : $.root();

  // Clone and clean
  const clone = root.clone();
  clone.find('script, style, nav, footer, header, .sidebar, .navigation, .breadcrumb, .share, .social, .comments, .related, .ad, .advertisement, .widget, .popup, .modal, .overlay, .cookie, .newsletter, .subscribe').remove();

  const seen = new Set<string>();
  const seenImg = new Set<string>();
  const seenFormula = new Set<string>();

  // ── Carousel images ──
  const carouselImgs: { url: string; alt?: string }[] = [];
  clone.find('.carousel-slide img, .slider img, .swiper-slide img, .slick-slide img, [class*="carousel"] img, [class*="slider"] img, .wp-block-image img, .featured-img img, .thumb-item img, [class*="course"] img').each((_i, el) => {
    let src = $(el).attr('src') || $(el).attr('data-src') || $(el).attr('data-lazy-src') || '';
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
      emit({ type: 'image_done', message: `Downloading carousel image ${i + 1}/${carouselImgs.length}`, url: carouselImgs[i].url });
      const img = await downloadAndProcessImage(carouselImgs[i].url, imageDir);
      if (img) { downloaded.push({ ...img, alt: carouselImgs[i].alt }); imageOrder++; images.push(img); }
      await new Promise(r => setTimeout(r, 250));
    }
    if (downloaded.length > 0) sections.push({ type: 'carousel', content: 'Featured Images', images: downloaded });
  }

  // ── DOM walker (preserves document order) ──
  async function walk(el: cheerio.Cheerio<cheerio.Element>, depth = 0): Promise<void> {
    if (depth > 20) return;
    const tag = (el as any).prop('tagName')?.toLowerCase() || '';

    // Formulas
    if (el.hasClass('mathjax') || el.hasClass('MathJax') || el.hasClass('math-display') || el.hasClass('katex-display') ||
        tag === 'math' || el.attr('type')?.includes('math/tex')) {
      const raw = el.attr('type')?.includes('math/tex') ? (el.html() || '') : (el.find('annotation[encoding="application/x-tex"]').text() || el.text() || '');
      const clean = raw.replace(/\s+/g, ' ').trim();
      if (clean.length > 2 && !seenFormula.has(clean)) {
        seenFormula.add(clean);
        formulas.push(clean);
        sections.push({ type: 'formula', content: clean });
      }
      return;
    }

    // Headings
    if (/^h[1-6]$/.test(tag)) {
      const t = el.text().trim();
      if (t.length > 1 && !seen.has(t)) { seen.add(t); sections.push({ type: 'heading', level: parseInt(tag[1]), content: t }); }
      return;
    }

    // Code
    if (tag === 'pre' || el.hasClass('code-block') || el.hasClass('highlight') || el.hasClass('Syntax')) {
      const codeEl = el.find('code').first();
      const code = codeEl.length > 0 ? el.find('code').text() : el.text();
      const c = code.trim();
      if (c.length > 5 && !seen.has(c)) { seen.add(c); sections.push({ type: 'code', content: c.substring(0, 8000) }); }
      return;
    }

    // Tables
    if (tag === 'table') {
      const rows: string[][] = [];
      el.find('tr').each((_ri, row) => {
        const cells: string[] = [];
        $(row).find('th, td').each((_ci, cell) => cells.push($(cell).text().trim().replace(/\s+/g, ' ')));
        if (cells.length > 0) rows.push(cells);
      });
      if (rows.length > 0) {
        const key = rows.map(r => r.join('|')).join('\n');
        if (!seen.has(key)) { seen.add(key); sections.push({ type: 'table', content: '', rows }); }
      }
      return;
    }

    // Lists
    if (tag === 'ul' || tag === 'ol') {
      const items: string[] = [];
      el.find('> li').each((_li, li) => { const t = $(li).text().trim().replace(/\s+/g, ' '); if (t.length > 2) items.push(t); });
      if (items.length > 0) { const key = items.join('\n'); if (!seen.has(key)) { seen.add(key); sections.push({ type: 'list', content: '', items }); } }
      return;
    }

    // Images
    if (tag === 'img') {
      let src = $(el).attr('src') || $(el).attr('data-src') || $(el).attr('data-lazy-src') || '';
      if (!src || src.startsWith('data:') || seenImg.has(src)) return;
      const w = parseInt($(el).attr('width') || '0'); const h = parseInt($(el).attr('height') || '0');
      if ((w > 0 && w < 40) || (h > 0 && h < 40)) return;
      if (src.includes('pixel') || src.includes('spacer') || src.includes('1x1')) return;
      if (src.startsWith('//')) src = 'https:' + src;
      if (src.startsWith('/')) src = new URL(url).origin + src;
      seenImg.add(src);
      imageOrder++;
      emit({ type: 'image_done', message: `Downloading image ${imageOrder}`, url: src });
      const img = await downloadAndProcessImage(src, imageDir);
      if (img) {
        images.push(img);
        sections.push({ type: 'image', content: src, imageData: img.buffer, imageExt: img.ext, imageWidth: img.width, imageHeight: img.height });
      }
      await new Promise(r => setTimeout(r, 200));
      return;
    }

    // HR
    if (tag === 'hr') { sections.push({ type: 'hr', content: '' }); return; }

    // Paragraphs
    if (tag === 'p') {
      const formulaEl = el.find('.mathjax, .MathJax, .katex, math, script[type*="math/tex"]').first();
      if (formulaEl.length > 0) {
        const raw = formulaEl.attr('type')?.includes('math/tex') ? (formulaEl.html() || '') : (formulaEl.find('annotation[encoding="application/x-tex"]').text() || formulaEl.text() || '');
        const clean = raw.replace(/\s+/g, ' ').trim();
        if (clean.length > 2 && !seenFormula.has(clean)) { seenFormula.add(clean); formulas.push(clean); sections.push({ type: 'formula', content: clean }); }
        const surrounding = el.clone().find('.mathjax, .MathJax, .katex, math, script[type*="math/tex"]').remove().end().text().trim().replace(/\s+/g, ' ');
        if (surrounding.length > 10 && !seen.has(surrounding)) { seen.add(surrounding); sections.push({ type: 'paragraph', content: surrounding }); }
      } else {
        const t = el.text().trim().replace(/\s+/g, ' ');
        if (t.length > 10 && !seen.has(t)) { seen.add(t); sections.push({ type: 'paragraph', content: t }); }
      }
      return;
    }

    // Recurse into containers
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
  $('article a[href], .entry-content a[href], .article-content a[href], .related a[href], .sidebar a[href]').each((_i, el) => {
    let href = $(el).attr('href') || '';
    if (!href || href.startsWith('#') || href.startsWith('javascript:')) return;
    if (href.startsWith('//')) href = 'https:' + href;
    else if (href.startsWith('/')) href = baseUrl.origin + href;
    try {
      const linkUrl = new URL(href);
      if (linkUrl.hostname.includes('geeksforgeeks.org') && !seenLinks.has(href) && href !== url) {
        seenLinks.add(href);
        const pathParts = linkUrl.pathname.split('/').filter(Boolean);
        if (pathParts.length >= 2 && !href.match(/\/(courses|practice|company|explore|jobs|contribute|events|premium)$/) && !href.match(/\.(jpg|jpeg|png|gif|svg|webp|css|js)$/i)) {
          childLinks.push(href);
        }
      }
    } catch { /* skip */ }
  });
  childLinks.splice(MAX_CHILD_LINKS);

  // Register in memory
  registerPage(url, title, topic);

  // Compute checksum
  const checksum = crypto.createHash('sha256').update(html.substring(0, 5000)).digest('hex').substring(0, 16);

  // Save to DB
  try {
    const { db } = await import('../lib/db');
    await db.scrapedPage.upsert({
      where: { url },
      update: { title, topic, sectionCount: sections.length, imageCount: images.length, formulaCount: formulas.length, childLinks: JSON.stringify(childLinks), checksum },
      create: { url, title, topic, sectionCount: sections.length, imageCount: images.length, formulaCount: formulas.length, childLinks: JSON.stringify(childLinks), checksum },
    });
    // Save images
    for (const img of images) {
      await db.scrapedImage.upsert({
        where: { id: `${url}#${img.fileName}` },
        update: {},
        create: { id: `${url}#${img.fileName}`, pageId: url, url: img.localPath, filePath: img.localPath, fileName: img.fileName, order: images.indexOf(img), width: img.width, height: img.height, alt: img.alt },
      }).catch(() => {});
    }
    // Save formulas
    for (let i = 0; i < formulas.length; i++) {
      await db.scrapedFormula.upsert({
        where: { id: `${url}#formula${i}` },
        update: {},
        create: { id: `${url}#formula${i}`, pageId: url, latex: formulas[i], rendered: renderLatex(formulas[i]), order: i },
      }).catch(() => {});
    }
  } catch { /* DB might not be available on Vercel */ }

  emit({ type: 'page_done', message: `Completed: ${title} (${sections.length} sections, ${images.length} images, ${formulas.length} formulas)`, url });

  return { url, title, sections, images, formulas, childLinks, isNew: true, existingTopics: [] };
}

// ─── Full Topic Scraper with Cross-Referencing ─────────────────────────────

export async function scrapeTopic(
  startUrl: string,
  topic: string,
  depth: number,
  maxPages: number,
  emit: (e: ScrapeEvent) => void,
  imageDir: string = IMAGES_DIR,
): Promise<{ pages: ScrapedPageData[]; crossRefs: CrossRefEntry[] }> {
  const visited = new Set<string>();
  const allPages: ScrapedPageData[] = [];
  const crossRefs: CrossRefEntry[] = [];
  const queue: { url: string; d: number }[] = [{ url: startUrl, d: 0 }];

  emit({ type: 'status', message: `Starting topic: "${topic}" from ${startUrl}`, topic });

  while (queue.length > 0 && allPages.length < maxPages) {
    const { url, d } = queue.shift()!;
    if (visited.has(url)) continue;
    visited.add(url);
    if (d > depth) break;

    try {
      const page = await scrapePage(url, topic, emit, imageDir);

      if (!page.isNew && page.existingTopics.length > 0) {
        crossRefs.push({ url: page.url, title: page.title, topics: page.existingTopics });
        continue; // Don't add to pages, but record the cross-reference
      }

      allPages.push(page);

      // Queue child links
      if (d < depth) {
        for (const link of page.childLinks) {
          if (!visited.has(link) && allPages.length + queue.length < maxPages) {
            queue.push({ url: link, d: d + 1 });
            emit({ type: 'link_found', message: `Found: ${link}`, url: link });
          }
        }
      }
    } catch (err: any) {
      emit({ type: 'error', message: `Failed: ${url} - ${err.message}`, url });
    }

    if (queue.length > 0) await new Promise(r => setTimeout(r, 1200));
  }

  // Save topic
  try {
    const { db } = await import('../lib/db');
    await db.topic.upsert({
      where: { name: topic },
      update: { pageCount: allPages.length, startUrl, depth, updatedAt: new Date() },
      create: { name: topic, startUrl, depth, pageCount: allPages.length },
    });
  } catch { /* DB might not be available */ }

  emit({ type: 'topic_done', message: `Topic "${topic}" complete: ${allPages.length} new pages, ${crossRefs.length} cross-referenced`, topic, pagesScraped: allPages.length, pagesReferenced: crossRefs.length, imagesDownloaded: allPages.reduce((s, p) => s + p.images.length, 0) });

  return { pages: allPages, crossRefs };
}