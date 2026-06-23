import * as cheerio from 'cheerio';
import * as crypto from 'crypto';
import sharp from 'sharp';
import katex from 'katex';

// ─── Config ────────────────────────────────────────────────────────────────
const MAX_IMG_W = 580;

// ─── Types ─────────────────────────────────────────────────────────────────

export interface InlineRun {
  text: string;
  bold?: boolean;
  italics?: boolean;
  code?: boolean;
  link?: string;
}

export interface ContentSection {
  type: 'heading' | 'paragraph' | 'rich-paragraph' | 'code' | 'list' | 'table' | 'image' | 'formula-image' | 'carousel' | 'hr' | 'xref';
  level?: number;
  content: string;
  runs?: InlineRun[];        // rich-paragraph uses this
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
  isNew: boolean;
  existingTopics: string[];
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

export function loadRegistryFromDB(_db: any) {}

// ─── Anti-bot fetch ────────────────────────────────────────────────────────

const BROWSER_HEADERS: Record<string, string> = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9',
  'Accept-Encoding': 'gzip, deflate, br',
  'Cache-Control': 'no-cache',
  'Pragma': 'no-cache',
  'Sec-Ch-Ua': '"Google Chrome";v="131", "Chromium";v="131", "Not_A Brand";v="24"',
  'Sec-Ch-Ua-Mobile': '?0',
  'Sec-Ch-Ua-Platform': '"Windows"',
  'Sec-Fetch-Dest': 'document',
  'Sec-Fetch-Mode': 'navigate',
  'Sec-Fetch-Site': 'none',
  'Sec-Fetch-User': '?1',
  'Upgrade-Insecure-Requests': '1',
};

async function fetchPageHtml(url: string): Promise<string> {
  const res = await fetch(url, {
    headers: BROWSER_HEADERS,
    redirect: 'follow',
    signal: AbortSignal.timeout(30000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return res.text();
}

async function fetchImageBuffer(url: string): Promise<{ buffer: Buffer; contentType: string } | null> {
  try {
    const res = await fetch(url, {
      headers: {
        'User-Agent': BROWSER_HEADERS['User-Agent'],
        'Accept': 'image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8',
        'Referer': 'https://www.geeksforgeeks.org/',
        'Sec-Fetch-Dest': 'image',
        'Sec-Fetch-Mode': 'no-cors',
        'Sec-Fetch-Site': 'same-origin',
      },
      redirect: 'follow',
      signal: AbortSignal.timeout(20000),
    });
    if (!res.ok) return null;
    const ct = res.headers.get('content-type') || 'image/png';
    const arrayBuf = await res.arrayBuffer();
    const buf = Buffer.from(arrayBuf);
    if (buf.length < 500) return null;
    return { buffer: buf, contentType: ct };
  } catch {
    return null;
  }
}

// ─── Image Downloader: always transcode to PNG via sharp ───────────────────

async function downloadAndProcessImage(url: string): Promise<ProcessedImage | null> {
  if (!url || (!url.startsWith('http://') && !url.startsWith('https://'))) return null;

  const result = await fetchImageBuffer(url);
  if (!result) return null;

  try {
    // Use sharp to get real dimensions AND transcode to PNG in one pass
    const pipeline = sharp(result.buffer);
    const metadata = await pipeline.metadata();
    const w = metadata.width || 580;
    const h = metadata.height || 360;

    // Scale down if wider than max, preserving aspect ratio
    let outW = w, outH = h;
    if (outW > MAX_IMG_W) {
      outW = MAX_IMG_W;
      outH = Math.round(h * (MAX_IMG_W / w));
    }

    const pngBuf = await pipeline
      .resize(outW, outH, { withoutEnlargement: true, fit: 'inside' })
      .png({ quality: 90 })
      .toBuffer();

    const hash = crypto.createHash('md5').update(url).digest('hex').substring(0, 12);
    const fileName = `img_${hash}.png`;

    return {
      buffer: pngBuf,
      ext: '.png',
      width: outW,
      height: outH,
      localPath: fileName,
      fileName,
    };
  } catch (err) {
    // sharp failed — try raw embed as last resort
    const hash = crypto.createHash('md5').update(url).digest('hex').substring(0, 12);
    const fileName = `img_${hash}.png`;
    return {
      buffer: result.buffer,
      ext: '.png',
      width: 580,
      height: 360,
      localPath: fileName,
      fileName,
    };
  }
}

// ─── LaTeX → PNG image via KaTeX + sharp ──────────────────────────────────

async function latexToPngImage(latex: string): Promise<Buffer | null> {
  try {
    // Render LaTeX to HTML via KaTeX
    const html = katex.renderToString(latex, {
      displayMode: true,
      throwOnError: false,
      output: 'html',
    });

    // Wrap in a basic HTML page for rendering
    const fullHtml = `<!DOCTYPE html>
<html><head><style>
body { margin: 20px; padding: 10px; background: white; display: inline-block; font-size: 20px; }
.katex { font-size: 1.2em; }
</style>
<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/katex@0.17.0/dist/katex.min.css">
</head><body>${html}</body></html>`;

    // Since we can't use a browser on serverless, fall back to Unicode text rendering
    // We'll render as a styled text image using sharp's SVG text capability
    const unicodeText = renderLatexToUnicode(latex);
    const svgText = unicodeText
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');

    // Estimate dimensions based on text length
    const charWidth = 12;
    const textWidth = Math.max(unicodeText.length * charWidth + 40, 100);
    const svgHeight = 50;
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${textWidth}" height="${svgHeight}">
      <rect width="100%" height="100%" fill="white"/>
      <text x="20" y="32" font-family="Cambria Math, STIXGeneral, serif" font-size="20" font-style="italic" fill="#1a1a2e">${svgText}</text>
    </svg>`;

    const pngBuf = await sharp(Buffer.from(svg)).resize(textWidth, svgHeight).png().toBuffer();
    return pngBuf;
  } catch {
    return null;
  }
}

// ─── LaTeX → Unicode (fallback, used by SVG renderer and as text backup) ───

function renderLatexToUnicode(latex: string): string {
  let t = latex
    .replace(/\\frac\{([^}]*)\}\{([^}]*)\}/g, '($1)/($2)')
    .replace(/\\sqrt\[(\d+)\]\{([^}]*)\}/g, '√[$1]($2)')
    .replace(/\\sqrt\{([^}]*)\}/g, '√($1)')
    .replace(/\\sum_?\{?([^}]*)\}?\^?\{?([^}]*)\}?/g, '∑')
    .replace(/\\prod_?\{?([^}]*)\}?\^?\{?([^}]*)\}?/g, '∏')
    .replace(/\\int_?\{?([^}]*)\}?\^?\{?([^}]*)\}?/g, '∫')
    .replace(/\\iint/g, '∬').replace(/\\iiint/g, '∭').replace(/\\oint/g, '∮')
    .replace(/\\partial/g, '∂').replace(/\\nabla/g, '∇')
    .replace(/\\alpha/g, 'α').replace(/\\beta/g, 'β').replace(/\\gamma/g, 'γ')
    .replace(/\\delta/g, 'δ').replace(/\\epsilon/g, 'ε').replace(/\\varepsilon/g, 'ε')
    .replace(/\\zeta/g, 'ζ').replace(/\\eta/g, 'η').replace(/\\theta/g, 'θ')
    .replace(/\\vartheta/g, 'ϑ').replace(/\\iota/g, 'ι').replace(/\\kappa/g, 'κ')
    .replace(/\\lambda/g, 'λ').replace(/\\mu/g, 'μ').replace(/\\nu/g, 'ν')
    .replace(/\\xi/g, 'ξ').replace(/\\pi/g, 'π').replace(/\\varpi/g, 'ϖ')
    .replace(/\\rho/g, 'ρ').replace(/\\sigma/g, 'σ').replace(/\\tau/g, 'τ')
    .replace(/\\upsilon/g, 'υ').replace(/\\phi/g, 'φ').replace(/\\varphi/g, 'ϕ')
    .replace(/\\chi/g, 'χ').replace(/\\psi/g, 'ψ').replace(/\\omega/g, 'ω')
    .replace(/\\Gamma/g, 'Γ').replace(/\\Delta/g, 'Δ').replace(/\\Theta/g, 'Θ')
    .replace(/\\Lambda/g, 'Λ').replace(/\\Xi/g, 'Ξ').replace(/\\Pi/g, 'Π')
    .replace(/\\Sigma/g, 'Σ').replace(/\\Upsilon/g, 'Υ').replace(/\\Phi/g, 'Φ')
    .replace(/\\Psi/g, 'Ψ').replace(/\\Omega/g, 'Ω')
    .replace(/\\leq/g, '≤').replace(/\\geq/g, '≥').replace(/\\neq/g, '≠')
    .replace(/\\approx/g, '≈').replace(/\\equiv/g, '≡').replace(/\\sim/g, '∼')
    .replace(/\\simeq/g, '≃').replace(/\\propto/g, '∝').replace(/\\cong/g, '≅')
    .replace(/\\ll/g, '≪').replace(/\\gg/g, '≫').replace(/\\prec/g, '≺')
    .replace(/\\succ/g, '≻').replace(/\\perp/g, '⊥').replace(/\\parallel/g, '∥')
    .replace(/\\times/g, '×').replace(/\\div/g, '÷').replace(/\\pm/g, '±')
    .replace(/\\mp/g, '∓').replace(/\\cdot/g, '·').replace(/\\cdots/g, '⋯')
    .replace(/\\ldots/g, '…').replace(/\\vdots/g, '⋮').replace(/\\ddots/g, '⋱')
    .replace(/\\oplus/g, '⊕').replace(/\\otimes/g, '⊗').replace(/\\cap/g, '∩')
    .replace(/\\cup/g, '∪').replace(/\\setminus/g, '∖').replace(/\\emptyset/g, '∅')
    .replace(/\\in/g, '∈').replace(/\\notin/g, '∉').replace(/\\subset/g, '⊂')
    .replace(/\\supset/g, '⊃').replace(/\\subseteq/g, '⊆').replace(/\\supseteq/g, '⊇')
    .replace(/\\rightarrow/g, '→').replace(/\\leftarrow/g, '←').replace(/\\leftrightarrow/g, '↔')
    .replace(/\\Rightarrow/g, '⇒').replace(/\\Leftarrow/g, '⇐').replace(/\\Leftrightarrow/g, '⇔')
    .replace(/\\uparrow/g, '↑').replace(/\\downarrow/g, '↓').replace(/\\mapsto/g, '↦')
    .replace(/\\to/g, '→').replace(/\\gets/g, '←')
    .replace(/\\implies/g, '⇒').replace(/\\iff/g, '⇔')
    .replace(/\\forall/g, '∀').replace(/\\exists/g, '∃').replace(/\\neg/g, '¬')
    .replace(/\\vee/g, '∨').replace(/\\wedge/g, '∧').replace(/\\therefore/g, '∴')
    .replace(/\\because/g, '∵')
    .replace(/\\infty/g, '∞').replace(/\\aleph/g, 'ℵ').replace(/\\Re/g, 'ℜ')
    .replace(/\\Im/g, 'ℑ').replace(/\\wp/g, '℘').replace(/\\ell/g, 'ℓ')
    .replace(/\\hbar/g, 'ℏ').replace(/\\angle/g, '∠').replace(/\\deg/g, '°')
    .replace(/\\prime/g, '′').replace(/\\backslash/g, '\\')
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
    .replace(/\\text\{([^}]*)\}/g, '$1')
    .replace(/\\mathrm\{([^}]*)\}/g, '$1')
    .replace(/\\mathbf\{([^}]*)\}/g, '$1')
    .replace(/\\mathbb\{([^}]*)\}/g, '$1')
    .replace(/\\mathcal\{([^}]*)\}/g, '$1')
    .replace(/\\operatorname\{([^}]*)\}/g, '$1')
    .replace(/\\textrm\{([^}]*)\}/g, '$1')
    .replace(/\\textit\{([^}]*)\}/g, '$1')
    .replace(/\\textbf\{([^}]*)\}/g, '$1')
    .replace(/\^{([^}]*)}/g, '^($1)')
    .replace(/_{([^}]*)}/g, '_($1)')
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

export { renderLatexToUnicode };

// ─── Inline rich-text parser ───────────────────────────────────────────────

function parseInlineRuns(el: cheerio.Cheerio<cheerio.Element>, $: cheerio.CheerioAPI): InlineRun[] {
  const runs: InlineRun[] = [];

  el.contents().each((_idx, node) => {
    if (node.type === 'text') {
      const t = (node as cheerio.TextNode).data;
      if (t) runs.push({ text: t });
    } else if (node.type === 'tag') {
      const tag = (node as cheerio.Element).tagName.toLowerCase();
      const child = $(node);
      const text = child.text() || '';

      if (tag === 'br') {
        runs.push({ text: '\n' });
      } else if (tag === 'img') {
        // inline images — skip here, handled by walker
        return;
      } else if (tag === 'a') {
        const href = child.attr('href') || '';
        const inner = parseInlineRuns(child, $);
        if (inner.length > 0) {
          for (const r of inner) r.link = href;
          runs.push(...inner);
        } else if (text.trim()) {
          runs.push({ text, link: href });
        }
      } else if (['strong', 'b'].includes(tag)) {
        const inner = parseInlineRuns(child, $);
        if (inner.length > 0) {
          for (const r of inner) r.bold = true;
          runs.push(...inner);
        } else if (text.trim()) {
          runs.push({ text, bold: true });
        }
      } else if (['em', 'i'].includes(tag)) {
        const inner = parseInlineRuns(child, $);
        if (inner.length > 0) {
          for (const r of inner) r.italics = true;
          runs.push(...inner);
        } else if (text.trim()) {
          runs.push({ text, italics: true });
        }
      } else if (tag === 'code' || tag === 'tt') {
        runs.push({ text, code: true });
      } else if (tag === 'sub') {
        runs.push({ text, italics: true });
      } else if (tag === 'sup') {
        runs.push({ text, italics: true });
      } else {
        // recurse into unknown containers (span, div inside p, etc.)
        const inner = parseInlineRuns(child, $);
        if (inner.length > 0) runs.push(...inner);
        else if (text.trim()) runs.push({ text });
      }
    }
  });

  return runs;
}

// ─── Page Scraper ──────────────────────────────────────────────────────────

// Extract article HTML from GFG's __NEXT_DATA__ (React SPA)
function extractNextDataContent(html: string): { contentHtml: string; title: string; childLinks: string[] } | null {
  const match = html.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
  if (!match) return null;
  try {
    const data = JSON.parse(match[1]);
    const props = data?.props?.pageProps;
    if (!props) return null;

    // Get article HTML from articleContentArray or post_content
    let contentHtml = '';
    const arr = props.articleContentArray;
    if (Array.isArray(arr) && arr.length > 0 && typeof arr[0] === 'string' && arr[0].length > 100) {
      contentHtml = arr.join('');
    } else {
      const postContent = props.postDataFromWriteApi?.post_content;
      if (postContent && postContent.length > 100) contentHtml = postContent;
    }

    if (!contentHtml) return null;

    const title = props.postTitle || '';

    // Extract child links from the HTML
    const $ = cheerio.load(contentHtml);
    const baseUrl = new URL('https://www.geeksforgeeks.org');
    const links: string[] = [];
    const seen = new Set<string>();
    $('a[href]').each((_i, el) => {
      let href = $(el).attr('href') || '';
      if (!href || href.startsWith('#') || href.startsWith('javascript:')) return;
      if (href.startsWith('//')) href = 'https:' + href;
      else if (href.startsWith('/')) href = baseUrl.origin + href;
      try {
        const u = new URL(href);
        if (u.hostname.includes('geeksforgeeks.org') && !seen.has(href)) {
          seen.add(href);
          const pathParts = u.pathname.split('/').filter(Boolean);
          if (pathParts.length >= 2 &&
              !href.match(/\/(courses|practice|company|explore|jobs|contribute|events|premium|login|register|users|profile)$/) &&
              !href.match(/\.(jpg|jpeg|png|gif|svg|webp|css|js|zip|pdf)$/i)) {
            links.push(href);
          }
        }
      } catch { /* skip */ }
    });

    return { contentHtml, title, childLinks: links };
  } catch { return null; }
}

export async function scrapePage(url: string, topic: string, emit: (e: ScrapeEvent) => void): Promise<ScrapedPageData> {
  // ── Cross-reference check ──
  const existing = checkPage(url);
  if (existing && existing.topic !== topic) {
    emit({ type: 'xref_found', message: `Already scraped under "${existing.topic}": ${url}`, url, refTopic: existing.topic, refTitle: existing.title });
    return { url, title: existing.title, sections: [], images: [], formulas: [], childLinks: [], isNew: false, existingTopics: [existing.topic] };
  }
  if (existing && existing.topic === topic) {
    return { url, title: existing.title, sections: [], images: [], formulas: [], childLinks: [], isNew: false, existingTopics: [topic] };
  }

  emit({ type: 'status', message: `Fetching: ${url}`, url });

  const rawHtml = await fetchPageHtml(url);

  // Try extracting from __NEXT_DATA__ first (GFG is a React SPA)
  const nextData = extractNextDataContent(rawHtml);
  const useExtracted = nextData && nextData.contentHtml.length > 200;
  const $ = cheerio.load(useExtracted ? nextData.contentHtml : rawHtml);
  const title = (useExtracted ? nextData.title : '') || $('h1').first().text().trim() || $('title').text().trim() || url.split('/').filter(Boolean).pop()?.replace(/[-_]/g, ' ') || 'Untitled';

  // Detect 404 / error pages
  if (!useExtracted) {
    const pageTitle = $('title').text().toLowerCase();
    const h1Text = $('h1').first().text().trim().toLowerCase();
    if (pageTitle.includes('404') || pageTitle.includes('page not found') ||
        h1Text.includes('404') || h1Text.includes('page is gone')) {
      emit({ type: 'error', message: `404: ${url}`, url });
      return { url, title: '404', sections: [], images: [], formulas: [], childLinks: [], isNew: true, existingTopics: [] };
    }
  }

  if (!title || title.length < 2) {
    emit({ type: 'error', message: `No content: ${url}`, url });
    return { url, title: 'No content', sections: [], images: [], formulas: [], childLinks: [], isNew: true, existingTopics: [] };
  }

  // Per-page dedup (not global!)
  const seen = new Set<string>();
  const seenImg = new Set<string>();
  const seenFormula = new Set<string>();

  const sections: ContentSection[] = [];
  const images: ProcessedImage[] = [];
  const formulas: string[] = [];
  let imageOrder = 0;

  // When using extracted content, the root IS the content (no need to select sub-areas)
  // When using raw HTML, find the content area
  let root: cheerio.Cheerio<cheerio.Element>;
  if (useExtracted) {
    root = $.root();
  } else {
    const contentArea = $(
      'article .article-content, article .entry-content, .entry-content, article.content, ' +
      'main article, main .content, #post-content, .post-content, ' +
      '.article-body, .article--content, .content-body, div[itemprop="articleBody"], ' +
      '.GeeksforGeeks_content, .gfg-content'
    ).first();
    root = contentArea.length > 0 ? contentArea : $.root();
  }

  // Clone and clean
  const clone = root.clone();
  clone.find('script, style, nav, footer, header, .sidebar, .navigation, .breadcrumb, ' +
    '.share, .social, .comments, .related, .ad, .advertisement, .widget, .popup, .modal, ' +
    '.overlay, .cookie, .newsletter, .subscribe, .rating, .author, .meta, .tags, ' +
    '.table-of-content, .toc, #table-of-content, .sticky, .notification, ' +
    '.course-banner, .courses-banner, [class*="recommend"], [class*="suggestion"], ' +
    '.nk-cookie-banner, .nk-top-bar'
  ).remove();

  // ── Carousel images: handle <gfg-carousel> elements AND standard selectors ──
  const carouselImgs: { url: string; alt?: string }[] = [];
  // GFG-specific <gfg-carousel-content> elements from NEXT_DATA
  $('gfg-carousel-content').each((_i, el) => {
    let src = $(el).attr('src') || '';
    const alt = $(el).attr('alt') || undefined;
    if (src && !src.startsWith('data:') && !seenImg.has(src)) {
      if (src.startsWith('//')) src = 'https:' + src;
      if (src.startsWith('/')) src = new URL(url).origin + src;
      seenImg.add(src);
      carouselImgs.push({ url: src, alt });
    }
  });
  // Standard carousel selectors
  clone.find('.carousel-slide img, .slider img, .swiper-slide img, .slick-slide img, ' +
    '[class*="carousel"] img, [class*="slider"] img, .wp-block-image img, ' +
    '.featured-img img, .thumb-item img, [class*="course"] img, ' +
    '.gallery img, .gallery-item img, [data-slide] img'
  ).each((_i, el) => {
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
    for (let i = 0; i < carouselImgs.length; i++) {
      emit({ type: 'image_done', message: `Carousel image ${i + 1}/${carouselImgs.length}`, url: carouselImgs[i].url });
      const img = await downloadAndProcessImage(carouselImgs[i].url);
      if (img) { downloaded.push({ ...img, alt: carouselImgs[i].alt }); imageOrder++; images.push(img); }
      await new Promise(r => setTimeout(r, 300));
    }
    if (downloaded.length > 0) sections.push({ type: 'carousel', content: '', images: downloaded });
  }

  // ── DOM walker (preserves document order) ──
  async function walk(el: cheerio.Cheerio<cheerio.Element>, depth = 0): Promise<void> {
    if (depth > 25) return;
    const tag = (el as any).prop('tagName')?.toLowerCase() || '';

    // Formulas — render as PNG image via KaTeX + sharp
    if (el.hasClass('mathjax') || el.hasClass('MathJax') || el.hasClass('math-display') || el.hasClass('katex-display') ||
        tag === 'math' || el.attr('type')?.includes('math/tex')) {
      const raw = el.attr('type')?.includes('math/tex') ? (el.html() || '') : (el.find('annotation[encoding="application/x-tex"]').text() || el.text() || '');
      const clean = raw.replace(/\s+/g, ' ').trim();
      if (clean.length > 2 && !seenFormula.has(clean)) {
        seenFormula.add(clean);
        formulas.push(clean);
        const pngBuf = await latexToPngImage(clean);
        if (pngBuf) {
          // get dimensions from the png
          const meta = await sharp(pngBuf).metadata();
          sections.push({
            type: 'formula-image', content: clean,
            imageData: pngBuf, imageExt: '.png',
            imageWidth: meta.width || 300, imageHeight: meta.height || 50,
          });
        } else {
          // Fallback to text
          sections.push({ type: 'paragraph', content: renderLatexToUnicode(clean) });
        }
      }
      return;
    }

    // Headings
    if (/^h[1-6]$/.test(tag)) {
      const t = el.text().trim();
      if (t.length > 1) { sections.push({ type: 'heading', level: parseInt(tag[1]), content: t }); }
      return;
    }

    // Code blocks
    if (tag === 'pre' || el.hasClass('code-block') || el.hasClass('highlight') || el.hasClass('Syntax')) {
      const codeEl = el.find('code').first();
      const code = codeEl.length > 0 ? el.find('code').text() : el.text();
      const c = code.trim();
      if (c.length > 1) sections.push({ type: 'code', content: c });
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
      if (rows.length > 0) sections.push({ type: 'table', content: '', rows });
      return;
    }

    // Lists
    if (tag === 'ul' || tag === 'ol') {
      const items: string[] = [];
      el.find('> li').each((_li, li) => { const t = $(li).text().trim().replace(/\s+/g, ' '); if (t.length > 0) items.push(t); });
      if (items.length > 0) sections.push({ type: 'list', content: '', items });
      return;
    }

    // Images (including lazy-loaded data-src)
    if (tag === 'img') {
      let src = $(el).attr('src') || $(el).attr('data-src') || $(el).attr('data-lazy-src') || $(el).attr('data-original') || '';
      if (!src || src.startsWith('data:') || seenImg.has(src)) return;
      const w = parseInt($(el).attr('width') || '0'); const h = parseInt($(el).attr('height') || '0');
      if ((w > 0 && w < 30) || (h > 0 && h < 30)) return;
      if (src.includes('pixel') || src.includes('spacer') || src.includes('1x1')) return;
      if (src.startsWith('//')) src = 'https:' + src;
      if (src.startsWith('/')) src = new URL(url).origin + src;
      seenImg.add(src);
      imageOrder++;
      emit({ type: 'image_done', message: `Image ${imageOrder}`, url: src });
      const img = await downloadAndProcessImage(src);
      if (img) {
        images.push(img);
        sections.push({ type: 'image', content: src, imageData: img.buffer, imageExt: img.ext, imageWidth: img.width, imageHeight: img.height });
      }
      await new Promise(r => setTimeout(r, 200));
      return;
    }

    // HR
    if (tag === 'hr') { sections.push({ type: 'hr', content: '' }); return; }

    // Paragraphs — extract INLINE rich text (bold, code, links, italic)
    if (tag === 'p') {
      // Check for formula inside paragraph
      const formulaEl = el.find('.mathjax, .MathJax, .katex, math, script[type*="math/tex"]').first();
      if (formulaEl.length > 0) {
        const raw = formulaEl.attr('type')?.includes('math/tex') ? (formulaEl.html() || '') : (formulaEl.find('annotation[encoding="application/x-tex"]').text() || formulaEl.text() || '');
        const clean = raw.replace(/\s+/g, ' ').trim();
        if (clean.length > 2 && !seenFormula.has(clean)) {
          seenFormula.add(clean);
          formulas.push(clean);
          const pngBuf = await latexToPngImage(clean);
          if (pngBuf) {
            const meta = await sharp(pngBuf).metadata();
            sections.push({ type: 'formula-image', content: clean, imageData: pngBuf, imageExt: '.png', imageWidth: meta.width || 300, imageHeight: meta.height || 50 });
          }
        }
        // Also get surrounding text
        const surrounding = el.clone().find('.mathjax, .MathJax, .katex, math, script[type*="math/tex"]').remove().end();
        const runs = parseInlineRuns(surrounding, $);
        const textOnly = runs.map(r => r.text).join('').trim();
        if (textOnly.length > 0) {
          sections.push({ type: 'rich-paragraph', content: textOnly, runs });
        }
      } else {
        // Rich paragraph with inline formatting
        const runs = parseInlineRuns(el, $);
        const textOnly = runs.map(r => r.text).join('').trim();
        if (textOnly.length > 0) {
          const hasFormatting = runs.some(r => r.bold || r.italics || r.code || r.link);
          if (hasFormatting) {
            sections.push({ type: 'rich-paragraph', content: textOnly, runs });
          } else {
            sections.push({ type: 'paragraph', content: textOnly });
          }
        }
      }
      return;
    }

    // Recurse into containers
    if (['div', 'section', 'article', 'main', 'span', 'figure', 'figcaption', 'aside', 'details', 'summary', 'blockquote'].includes(tag)) {
      for (const child of el.children().toArray()) await walk($(child), depth + 1);
    }
  }

  for (const child of clone.children().toArray()) await walk($(child));

  // Fallback
  if (sections.filter(s => s.type === 'heading' || s.type === 'paragraph' || s.type === 'rich-paragraph').length === 0) {
    const text = clone.text().replace(/\s+/g, ' ').trim();
    if (text.length > 10) {
      const paras = text.split(/\n\n|(?<=[.!?])\s+(?=[A-Z])/).filter(p => p.trim().length > 0);
      for (const p of paras) sections.push({ type: 'paragraph', content: p.trim() });
    }
  }

  // Child links — use pre-extracted links from NEXT_DATA if available
  let childLinks: string[] = [];
  if (useExtracted && nextData.childLinks.length > 0) {
    childLinks = nextData.childLinks.filter(l => l !== url);
  } else {
    const baseUrl = new URL(url);
    const seenLinks = new Set<string>();
    $('article a[href], .entry-content a[href], .article-content a[href], .related a[href], .sidebar a[href], main a[href]').each((_i, el) => {
      let href = $(el).attr('href') || '';
      if (!href || href.startsWith('#') || href.startsWith('javascript:')) return;
      if (href.startsWith('//')) href = 'https:' + href;
      else if (href.startsWith('/')) href = baseUrl.origin + href;
      try {
        const linkUrl = new URL(href);
        if (linkUrl.hostname.includes('geeksforgeeks.org') && !seenLinks.has(href) && href !== url) {
          seenLinks.add(href);
          const pathParts = linkUrl.pathname.split('/').filter(Boolean);
          if (pathParts.length >= 2 &&
              !href.match(/\/(courses|practice|company|explore|jobs|contribute|events|premium|login|register|users|profile)$/)) {
            if (!href.match(/\.(jpg|jpeg|png|gif|svg|webp|css|js|zip|pdf)$/i)) {
              childLinks.push(href);
            }
          }
        }
      } catch { /* skip */ }
    });
  }

  registerPage(url, title, topic);

  emit({ type: 'page_done', message: `Done: ${title} (${sections.length} sections, ${images.length} images, ${formulas.length} formulas)`, url });

  return { url, title, sections, images, formulas, childLinks, isNew: true, existingTopics: [] };
}

// ─── Full Topic Scraper ────────────────────────────────────────────────────

export async function scrapeTopic(
  startUrl: string,
  topic: string,
  _depth: number,
  _maxPages: number,
  emit: (e: ScrapeEvent) => void,
): Promise<{ pages: ScrapedPageData[]; crossRefs: CrossRefEntry[] }> {
  const visited = new Set<string>();
  const allPages: ScrapedPageData[] = [];
  const crossRefs: CrossRefEntry[] = [];
  const queue: { url: string; d: number }[] = [{ url: startUrl, d: 0 }];

  emit({ type: 'status', message: `Starting: "${topic}" from ${startUrl}`, topic });

  while (queue.length > 0) {
    const { url, d } = queue.shift()!;
    if (visited.has(url)) continue;
    visited.add(url);

    try {
      const page = await scrapePage(url, topic, emit);

      if (!page.isNew && page.existingTopics.length > 0) {
        crossRefs.push({ url: page.url, title: page.title, topics: page.existingTopics });
        continue;
      }

      // Skip empty/404 pages
      if (page.sections.length === 0) continue;

      allPages.push(page);

      // Queue all child links — no depth limit
      for (const link of page.childLinks) {
        if (!visited.has(link)) {
          queue.push({ url: link, d: d + 1 });
          emit({ type: 'link_found', message: `Found: ${link}`, url: link });
        }
      }
    } catch (err: any) {
      emit({ type: 'error', message: `Failed: ${url} - ${err.message}`, url });
    }

    if (queue.length > 0) await new Promise(r => setTimeout(r, 1500));
  }

  emit({ type: 'topic_done', message: `Topic "${topic}": ${allPages.length} pages, ${crossRefs.length} cross-referenced`, topic, pagesScraped: allPages.length, pagesReferenced: crossRefs.length, imagesDownloaded: allPages.reduce((s, p) => s + p.images.length, 0) });

  return { pages: allPages, crossRefs };
}