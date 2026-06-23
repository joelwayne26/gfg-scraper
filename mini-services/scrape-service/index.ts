import { createServer } from 'http';
import { Server } from 'socket.io';
import ZAI from 'z-ai-web-dev-sdk';
import * as cheerio from 'cheerio';
import {
  Document, Packer, Paragraph, TextRun, HeadingLevel, ImageRun,
  AlignmentType, BorderStyle, Table, TableRow, TableCell,
  WidthType, ShadingType, PageBreak, ExternalHyperlink,
} from 'docx';
import * as fs from 'fs';
import * as path from 'path';
import * as https from 'https';
import * as http from 'http';
import sharp from 'sharp';

const DOWNLOAD_DIR = '/home/z/my-project/download';
const MAX_PAGES = 15;
const MAX_IMAGES_PER_PAGE = 30;
const MAX_CHILD_LINKS = 15;

const httpServer = createServer();
const io = new Server(httpServer, {
  path: '/',
  cors: { origin: '*', methods: ['GET', 'POST'] },
  pingTimeout: 120000,
  pingInterval: 25000,
});

// ─── Types ────────────────────────────────────────────────────────────────

interface ScrapedPage {
  url: string;
  title: string;
  sections: ContentSection[];
  images: ScrapedImage[];
  formulas: string[];
  childLinks: string[];
}

interface ContentSection {
  type: 'heading' | 'paragraph' | 'code' | 'list' | 'table' | 'image' | 'formula' | 'carousel' | 'hr';
  level?: number;
  content: string;
  items?: string[];
  rows?: string[][];
  imageData?: Buffer;
  imageExt?: string;
  imageWidth?: number;
  imageHeight?: number;
  images?: { buffer: Buffer; ext: string; width: number; height: number; alt?: string }[];
}

interface ScrapedImage {
  url: string;
  buffer: Buffer;
  ext: string;
  alt?: string;
  order: number;
  width: number;
  height: number;
}

interface ScrapeProgress {
  type: 'status' | 'page_done' | 'image_done' | 'error' | 'complete' | 'link_found';
  message: string;
  current?: number;
  total?: number;
  url?: string;
  filePath?: string;
  fileName?: string;
}

// ─── ZAI SDK Singleton ────────────────────────────────────────────────────

let zaiInstance: Awaited<ReturnType<typeof ZAI.create>> | null = null;

async function getZAI() {
  if (!zaiInstance) {
    zaiInstance = await ZAI.create();
  }
  return zaiInstance;
}

// ─── Image Downloader with Sharp Processing ───────────────────────────────

async function downloadAndProcessImage(url: string): Promise<{ buffer: Buffer; ext: string; width: number; height: number } | null> {
  return new Promise((resolve) => {
    if (!url || (!url.startsWith('http://') && !url.startsWith('https://'))) {
      resolve(null);
      return;
    }

    const client = url.startsWith('https') ? https : http;
    const timeout = setTimeout(() => {
      resolve(null);
    }, 20000);

    const request = client.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'image/webp,image/apng,image/*,*/*;q=0.8',
        'Referer': 'https://www.geeksforgeeks.org/',
      }
    }, (res) => {
      // Handle redirects
      if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        clearTimeout(timeout);
        downloadAndProcessImage(res.headers.location).then(resolve);
        return;
      }
      if (res.statusCode !== 200) {
        clearTimeout(timeout);
        resolve(null);
        return;
      }

      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => chunks.push(chunk));
      res.on('end', async () => {
        clearTimeout(timeout);
        try {
          const rawBuffer = Buffer.concat(chunks);
          if (rawBuffer.length < 500) { // Too small to be a real image
            resolve(null);
            return;
          }

          // Use sharp to get dimensions and convert to PNG for docx compatibility
          const metadata = await sharp(rawBuffer).metadata();
          const width = metadata.width || 580;
          const height = metadata.height || 360;

          // Resize if too large (max 600px wide) while preserving aspect ratio
          let processedBuffer: Buffer;
          const maxWidth = 600;
          if (width > maxWidth) {
            processedBuffer = await sharp(rawBuffer)
              .resize(maxWidth, null, { withoutEnlargement: true, fit: 'inside' })
              .png({ quality: 90 })
              .toBuffer();
          } else {
            // Convert to PNG for docx compatibility (handles webp, gif, etc.)
            processedBuffer = await sharp(rawBuffer)
              .png({ quality: 90 })
              .toBuffer();
          }

          resolve({ buffer: processedBuffer, ext: '.png', width, height });
        } catch (err) {
          // If sharp fails, return raw buffer
          const rawBuffer = Buffer.concat(chunks);
          if (rawBuffer.length > 500) {
            resolve({ buffer: rawBuffer, ext: '.png', width: 580, height: 360 });
          } else {
            resolve(null);
          }
        }
      });
      res.on('error', () => {
        clearTimeout(timeout);
        resolve(null);
      });
    });

    request.on('error', () => {
      clearTimeout(timeout);
      resolve(null);
    });

    request.setTimeout(20000, () => {
      request.destroy();
      clearTimeout(timeout);
      resolve(null);
    });
  });
}

// ─── Formula Parser (LaTeX → docx Math objects) ───────────────────────────

function parseLatexToTextRuns(latex: string): TextRun[] {
  // For complex formulas that can't be easily converted to OMML,
  // render them as styled text with proper Unicode math symbols
  let text = latex
    .replace(/\\frac\{([^}]*)\}\{([^}]*)\}/g, '($1)/($2)')
    .replace(/\\sqrt\{([^}]*)\}/g, '\u221A($1)')
    .replace(/\\sum/g, '\u2211')
    .replace(/\\prod/g, '\u220F')
    .replace(/\\int/g, '\u222B')
    .replace(/\\partial/g, '\u2202')
    .replace(/\\infty/g, '\u221E')
    .replace(/\\pm/g, '\u00B1')
    .replace(/\\mp/g, '\u2213')
    .replace(/\\times/g, '\u00D7')
    .replace(/\\div/g, '\u00F7')
    .replace(/\\leq/g, '\u2264')
    .replace(/\\geq/g, '\u2265')
    .replace(/\\neq/g, '\u2260')
    .replace(/\\approx/g, '\u2248')
    .replace(/\\equiv/g, '\u2261')
    .replace(/\\cdot/g, '\u00B7')
    .replace(/\\ldots/g, '...')
    .replace(/\\cdots/g, '\u22EF')
    .replace(/\^{([^}]*)}/g, '^($1)')
    .replace(/_{([^}]*)}/g, '_($1)')
    .replace(/\\left/g, '')
    .replace(/\\right/g, '')
    .replace(/\\text\{([^}]*)\}/g, '$1')
    .replace(/\\mathbb\{([^}]*)\}/g, '$1')
    .replace(/\\mathrm\{([^}]*)\}/g, '$1')
    .replace(/\\operatorname\{([^}]*)\}/g, '$1')
    .replace(/\\alpha/g, '\u03B1')
    .replace(/\\beta/g, '\u03B2')
    .replace(/\\gamma/g, '\u03B3')
    .replace(/\\delta/g, '\u03B4')
    .replace(/\\epsilon/g, '\u03B5')
    .replace(/\\theta/g, '\u03B8')
    .replace(/\\lambda/g, '\u03BB')
    .replace(/\\mu/g, '\u03BC')
    .replace(/\\sigma/g, '\u03C3')
    .replace(/\\omega/g, '\u03C9')
    .replace(/\\Sigma/g, '\u03A3')
    .replace(/\\Omega/g, '\u03A9')
    .replace(/\\Pi/g, '\u03A0')
    .replace(/\\Delta/g, '\u0394')
    .replace(/\\Phi/g, '\u03A6')
    .replace(/\\Psi/g, '\u03A8')
    .replace(/\\in/g, '\u2208')
    .replace(/\\notin/g, '\u2209')
    .replace(/\\subset/g, '\u2282')
    .replace(/\\supset/g, '\u2283')
    .replace(/\\cup/g, '\u222A')
    .replace(/\\cap/g, '\u2229')
    .replace(/\\emptyset/g, '\u2205')
    .replace(/\\forall/g, '\u2200')
    .replace(/\\exists/g, '\u2203')
    .replace(/\\rightarrow/g, '\u2192')
    .replace(/\\leftarrow/g, '\u2190')
    .replace(/\\Rightarrow/g, '\u21D2')
    .replace(/\\Leftarrow/g, '\u21D0')
    .replace(/\\Leftrightarrow/g, '\u21D4')
    .replace(/\\to/g, '\u2192')
    .replace(/\\gets/g, '\u2190')
    .replace(/\\neg/g, '\u00AC')
    .replace(/\\vee/g, '\u2228')
    .replace(/\\wedge/g, '\u2227')
    .replace(/\\Rightarrow/g, '\u21D2')
    .replace(/\\implies/g, '\u21D2')
    .replace(/\\iff/g, '\u21D4')
    .replace(/\\log/g, 'log')
    .replace(/\\ln/g, 'ln')
    .replace(/\\sin/g, 'sin')
    .replace(/\\cos/g, 'cos')
    .replace(/\\tan/g, 'tan')
    .replace(/\\lim/g, 'lim')
    .replace(/\\min/g, 'min')
    .replace(/\\max/g, 'max')
    .replace(/\\arg/g, 'arg')
    .replace(/\\det/g, 'det')
    .replace(/\\exp/g, 'exp')
    .replace(/\{/g, '')
    .replace(/\}/g, '')
    .replace(/\\,/g, ' ')
    .replace(/\\;/g, ' ')
    .replace(/\\!/g, '')
    .replace(/\\ /g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  return [new TextRun({
    text,
    italics: true,
    size: 22,
    font: 'Cambria Math',
    color: '1a1a2e',
  })];
}

// ─── Page Scraper ─────────────────────────────────────────────────────────

async function scrapePage(url: string, socket: any, progress: { current: number; total: number }): Promise<ScrapedPage> {
  const zai = await getZAI();

  socket.emit('progress', {
    type: 'status',
    message: `Fetching page: ${url}`,
    current: progress.current,
    total: progress.total,
    url,
  } as ScrapeProgress);

  const result = await zai.functions.invoke('page_reader', { url });

  if (!result.data || !result.data.html) {
    throw new Error(`Failed to fetch content from ${url}`);
  }

  const html = result.data.html;
  const $ = cheerio.load(html);

  // Extract title
  const title = result.data.title || $('h1').first().text().trim() || path.basename(url).replace(/[-_]/g, ' ') || 'Untitled Page';

  // Ordered sections array - this preserves the visual order of content
  const sections: ContentSection[] = [];
  const images: ScrapedImage[] = [];
  const formulas: string[] = [];
  let imageOrder = 0;

  // ─── Find main content area ──────────────────────────────────────
  const contentArea = $('article .article-content, .entry-content, article, .post-content, main .content').first();
  const root = contentArea.length > 0 ? contentArea : $.root();

  // ─── Step 1: Build an ordered list of all content nodes ────────────
  // We walk the DOM tree in document order and classify each node
  const contentClone = root.clone();

  // Remove non-content elements
  contentClone.find('script, style, nav, footer, header, .sidebar, .navigation, .breadcrumb, .share, .social, .comments, .related, .ad, .advertisement, .widget, .popup, .modal, .overlay, .cookie, .newsletter, .subscribe').remove();

  const processedTexts = new Set<string>();
  const processedImages = new Set<string>();
  const processedFormulas = new Set<string>();

  // ─── Extract carousel/slideshow images first (GFG specific) ─────
  const carouselImages: { url: string; alt?: string }[] = [];
  contentClone.find('.carousel-slide img, .slider img, .swiper-slide img, .slick-slide img, [class*="carousel"] img, [class*="slider"] img, .wp-block-image img, .featured-img img, .thumb-item img, .course-item img, .geeksforgeeks-img img').each((_i, el) => {
    let src = $(el).attr('src') || $(el).attr('data-src') || $(el).attr('data-lazy-src') || '';
    if (src && !src.startsWith('data:') && !processedImages.has(src)) {
      if (src.startsWith('//')) src = 'https:' + src;
      if (src.startsWith('/')) src = new URL(url).origin + src;
      processedImages.add(src);
      carouselImages.push({ url: src, alt: $(el).attr('alt') || undefined });
    }
  });

  // If we found carousel images, add them as a group at the beginning
  if (carouselImages.length > 0) {
    socket.emit('progress', {
      type: 'status',
      message: `Found ${carouselImages.length} carousel/featured images`,
      url,
    } as ScrapeProgress);

    const downloadedImages: { buffer: Buffer; ext: string; width: number; height: number; alt?: string }[] = [];
    for (let i = 0; i < Math.min(carouselImages.length, MAX_IMAGES_PER_PAGE); i++) {
      socket.emit('progress', {
        type: 'image_done',
        message: `Downloading carousel image ${i + 1}/${carouselImages.length}`,
        current: i + 1,
        total: carouselImages.length,
        url: carouselImages[i].url,
      } as ScrapeProgress);

      const downloaded = await downloadAndProcessImage(carouselImages[i].url);
      if (downloaded) {
        downloadedImages.push({
          ...downloaded,
          alt: carouselImages[i].alt,
        });
        imageOrder++;
        images.push({
          url: carouselImages[i].url,
          buffer: downloaded.buffer,
          ext: downloaded.ext,
          alt: carouselImages[i].alt,
          order: imageOrder,
          width: downloaded.width,
          height: downloaded.height,
        });
      }
      await new Promise(r => setTimeout(r, 300));
    }

    if (downloadedImages.length > 0) {
      sections.push({
        type: 'carousel',
        content: 'Featured Images',
        images: downloadedImages,
      });
    }
  }

  // ─── Step 2: Walk through content in document order ───────────────
  async function walkAndExtract(el: cheerio.Cheerio<cheerio.Element>, depth: number = 0): Promise<void> {
    if (depth > 20) return;

    const tagName = (el as any).prop('tagName')?.toLowerCase() || '';

    // ── Formulas (MathJax / KaTeX) ──
    if (el.hasClass('mathjax') || el.hasClass('MathJax') || el.hasClass('math-display') || el.hasClass('katex-display') ||
        el.prop('tagName')?.toLowerCase() === 'math' || el.attr('type')?.includes('math/tex')) {
      const formula = el.attr('type')?.includes('math/tex')
        ? el.html() || ''
        : el.find('annotation[encoding="application/x-tex"]').text() || el.text() || '';

      const cleanFormula = formula.replace(/\s+/g, ' ').trim();
      if (cleanFormula.length > 2 && !processedFormulas.has(cleanFormula)) {
        processedFormulas.add(cleanFormula);
        formulas.push(cleanFormula);
        sections.push({ type: 'formula', content: cleanFormula });
      }
      // Don't recurse into formula elements
      return;
    }

    // ── Headings ──
    if (/^h[1-6]$/.test(tagName)) {
      const text = el.text().trim();
      if (text.length > 1 && !processedTexts.has(text)) {
        processedTexts.add(text);
        const level = parseInt(tagName[1]);
        sections.push({ type: 'heading', level, content: text });
      }
      return; // Don't recurse into heading children
    }

    // ── Code blocks ──
    if (tagName === 'pre' || el.hasClass('code-block') || el.hasClass('highlight') || el.hasClass('Syntax')) {
      const codeEl = el.find('code').first();
      const codeText = codeEl.length > 0 ? codeText_fromEl(codeEl) : el.text();
      const cleaned = codeText.trim();
      if (cleaned.length > 5 && !processedTexts.has(cleaned)) {
        processedTexts.add(cleaned);
        sections.push({ type: 'code', content: cleaned.substring(0, 8000) });
      }
      return;
    }

    // ── Tables ──
    if (tagName === 'table') {
      const rows: string[][] = [];
      el.find('tr').each((_ri, row) => {
        const cells: string[] = [];
        $(row).find('th, td').each((_ci, cell) => {
          cells.push($(cell).text().trim().replace(/\s+/g, ' '));
        });
        if (cells.length > 0) rows.push(cells);
      });
      if (rows.length > 0) {
        const tableKey = rows.map(r => r.join('|')).join('\n');
        if (!processedTexts.has(tableKey)) {
          processedTexts.add(tableKey);
          sections.push({ type: 'table', content: '', rows });
        }
      }
      return;
    }

    // ── Lists ──
    if (tagName === 'ul' || tagName === 'ol') {
      const items: string[] = [];
      el.find('> li').each((_li, li) => {
        const itemText = $(li).text().trim().replace(/\s+/g, ' ');
        if (itemText.length > 2) items.push(itemText);
      });
      if (items.length > 0) {
        const listKey = items.join('\n');
        if (!processedTexts.has(listKey)) {
          processedTexts.add(listKey);
          sections.push({ type: 'list', content: '', items });
        }
      }
      return;
    }

    // ── Images (inline, not carousel) ──
    if (tagName === 'img') {
      let src = el.attr('src') || el.attr('data-src') || el.attr('data-lazy-src') || '';
      if (!src || src.startsWith('data:')) return;
      if (processedImages.has(src)) return;

      // Skip tiny icons/trackers
      const w = parseInt(el.attr('width') || '0');
      const h = parseInt(el.attr('height') || '0');
      if ((w > 0 && w < 40) || (h > 0 && h < 40)) return;
      if (src.includes('pixel') || src.includes('spacer') || src.includes('1x1')) return;

      if (src.startsWith('//')) src = 'https:' + src;
      if (src.startsWith('/')) src = new URL(url).origin + src;

      processedImages.add(src);
      imageOrder++;

      // Download image
      socket.emit('progress', {
        type: 'image_done',
        message: `Downloading image ${imageOrder}`,
        url: src,
      } as ScrapeProgress);

      const downloaded = await downloadAndProcessImage(src);
      if (downloaded) {
        images.push({
          url: src,
          buffer: downloaded.buffer,
          ext: downloaded.ext,
          alt: el.attr('alt') || undefined,
          order: imageOrder,
          width: downloaded.width,
          height: downloaded.height,
        });
        sections.push({
          type: 'image',
          content: src,
          imageData: downloaded.buffer,
          imageExt: downloaded.ext,
          imageWidth: downloaded.width,
          imageHeight: downloaded.height,
        });
      }
      await new Promise(r => setTimeout(r, 200));
      return;
    }

    // ── Horizontal rules ──
    if (tagName === 'hr') {
      sections.push({ type: 'hr', content: '' });
      return;
    }

    // ── Paragraphs ──
    if (tagName === 'p') {
      const pText = el.text().trim().replace(/\s+/g, ' ');
      // Check if this paragraph contains a formula
      const formulaEl = el.find('.mathjax, .MathJax, .katex, math, script[type*="math/tex"]').first();
      if (formulaEl.length > 0) {
        const formula = formulaEl.attr('type')?.includes('math/tex')
          ? formulaEl.html() || ''
          : formulaEl.find('annotation[encoding="application/x-tex"]').text() || formulaEl.text() || '';
        const cleanFormula = formula.replace(/\s+/g, ' ').trim();
        if (cleanFormula.length > 2 && !processedFormulas.has(cleanFormula)) {
          processedFormulas.add(cleanFormula);
          formulas.push(cleanFormula);
          sections.push({ type: 'formula', content: cleanFormula });
        }
        // Get surrounding text if any
        const surroundingText = el.clone().find('.mathjax, .MathJax, .katex, math, script[type*="math/tex"]').remove().end().text().trim().replace(/\s+/g, ' ');
        if (surroundingText.length > 10 && !processedTexts.has(surroundingText)) {
          processedTexts.add(surroundingText);
          sections.push({ type: 'paragraph', content: surroundingText });
        }
      } else if (pText.length > 10 && !processedTexts.has(pText)) {
        processedTexts.add(pText);
        sections.push({ type: 'paragraph', content: pText });
      }
      return;
    }

    // ── Divs and other containers: recurse into children ──
    if (['div', 'section', 'article', 'main', 'span', 'figure', 'figcaption', 'aside', 'details', 'summary'].includes(tagName)) {
      for (const child of el.children().toArray()) {
        await walkAndExtract($(child), depth + 1);
      }
    }
  }

  // Helper for code text extraction
  function codeText_fromEl(el: cheerio.Cheerio<cheerio.Element>): string {
    // Prefer the raw text without HTML encoding issues
    let text = '';
    el.contents().each((_i, node) => {
      if (node.type === 'text') {
        text += node.data || '';
      } else if ((node as any).tagName === 'br') {
        text += '\n';
      } else {
        text += $(node).text();
      }
    });
    return text || el.text();
  }

  // Walk through all top-level children of the content area
  const topElements = contentClone.children();
  for (const child of topElements.toArray()) {
    await walkAndExtract($(child));
  }

  // ─── Fallback: if no structured content was extracted ──────────────
  const textSections = sections.filter(s => s.type === 'heading' || s.type === 'paragraph');
  if (textSections.length === 0) {
    const plainText = contentClone.text().replace(/\s+/g, ' ').trim();
    if (plainText.length > 50) {
      const paragraphs = plainText.split(/\n\n|(?<=[.!?])\s+(?=[A-Z])/).filter(p => p.trim().length > 20);
      for (const p of paragraphs.slice(0, 20)) {
        if (!processedTexts.has(p.trim())) {
          processedTexts.add(p.trim());
          sections.push({ type: 'paragraph', content: p.trim() });
        }
      }
    }
  }

  // ─── Extract child links (related GFG pages) ──────────────────────
  const baseUrl = new URL(url);
  const seenLinks = new Set<string>();

  // Look for links in the main content area and sidebar "Related Articles" etc.
  const linkSelectors = 'article a[href], .entry-content a[href], .article-content a[href], .related a[href], .sidebar a[href]';
  $(linkSelectors).each((_i, el) => {
    let href = $(el).attr('href') || '';
    if (!href || href.startsWith('#') || href.startsWith('javascript:')) return;
    if (href.startsWith('//')) href = 'https:' + href;
    else if (href.startsWith('/')) href = baseUrl.origin + href;
    try {
      const linkUrl = new URL(href);
      if (linkUrl.hostname.includes('geeksforgeeks.org') && !seenLinks.has(href) && href !== url) {
        seenLinks.add(href);
        // Only include article/tutorial links, not category/course pages
        const pathParts = linkUrl.pathname.split('/').filter(Boolean);
        if (pathParts.length >= 2 && !href.match(/\/(courses|practice|company|explore|jobs|contribute|events|premium)$/)) {
          if (!href.match(/\.(jpg|jpeg|png|gif|svg|webp|css|js)$/i)) {
            childLinks.push(href);
          }
        }
      }
    } catch { /* skip invalid URLs */ }
  });

  // Limit child links
  childLinks.splice(MAX_CHILD_LINKS);

  socket.emit('progress', {
    type: 'page_done',
    message: `Completed: ${title} (${sections.length} sections, ${images.length} images)`,
    url,
  } as ScrapeProgress);

  return { url, title, sections, images, formulas, childLinks };
}

// ─── Word Document Generator ──────────────────────────────────────────────

async function generateDocx(pages: ScrapedPage[], fileName: string): Promise<string> {
  const docChildren: (Paragraph | Table)[] = [];

  // ── Cover Page ──
  docChildren.push(
    new Paragraph({ spacing: { before: 3000 }, children: [] })
  );
  docChildren.push(
    new Paragraph({
      children: [
        new TextRun({
          text: pages[0]?.title || 'GeeksforGeeks Notes',
          bold: true,
          size: 48,
          font: 'Calibri',
          color: '1a5632',
        }),
      ],
      alignment: AlignmentType.CENTER,
      spacing: { after: 300 },
    })
  );
  docChildren.push(
    new Paragraph({
      children: [
        new TextRun({
          text: 'Scraped from GeeksforGeeks',
          size: 24,
          font: 'Calibri',
          color: '666666',
        }),
      ],
      alignment: AlignmentType.CENTER,
      spacing: { after: 100 },
    })
  );
  docChildren.push(
    new Paragraph({
      children: [
        new TextRun({
          text: `Generated: ${new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' })}`,
          size: 22,
          font: 'Calibri',
          color: '888888',
        }),
      ],
      alignment: AlignmentType.CENTER,
      spacing: { after: 100 },
    })
  );
  docChildren.push(
    new Paragraph({
      children: [
        new TextRun({
          text: `Total Pages: ${pages.length} | Source: ${pages[0]?.url || 'N/A'}`,
          size: 20,
          font: 'Calibri',
          color: '999999',
          italics: true,
        }),
      ],
      alignment: AlignmentType.CENTER,
      spacing: { after: 600 },
    })
  );

  // Page break after cover
  docChildren.push(new Paragraph({ children: [new PageBreak()] }));

  // ── Content Pages ──
  for (let pageIdx = 0; pageIdx < pages.length; pageIdx++) {
    const page = pages[pageIdx];

    // Page title as H1
    docChildren.push(
      new Paragraph({
        children: [
          new TextRun({
            text: page.title,
            bold: true,
            size: 36,
            font: 'Calibri',
            color: '1a5632',
          }),
        ],
        heading: HeadingLevel.HEADING_1,
        spacing: { after: 100 },
        border: {
          bottom: { style: BorderStyle.SINGLE, size: 8, color: '2d6a4f' },
        },
      })
    );

    // Source URL
    docChildren.push(
      new Paragraph({
        children: [
          new ExternalHyperlink({
            children: [
              new TextRun({
                text: page.url,
                style: 'Hyperlink',
                size: 18,
                font: 'Calibri',
              }),
            ],
            link: page.url,
          }),
        ],
        spacing: { after: 300 },
      })
    );

    // Process sections in order
    for (const section of page.sections) {
      switch (section.type) {
        case 'heading': {
          const headingLevel = section.level
            ? Math.min(section.level, 4) as 1 | 2 | 3 | 4
            : 2;
          const headingMap: Record<number, typeof HeadingLevel.HEADING_1> = {
            1: HeadingLevel.HEADING_1,
            2: HeadingLevel.HEADING_2,
            3: HeadingLevel.HEADING_3,
            4: HeadingLevel.HEADING_4,
          };
          const sizeMap: Record<number, number> = { 1: 32, 2: 28, 3: 24, 4: 22 };
          docChildren.push(
            new Paragraph({
              children: [
                new TextRun({
                  text: section.content,
                  bold: true,
                  size: sizeMap[headingLevel] || 26,
                  font: 'Calibri',
                  color: headingLevel <= 2 ? '1a5632' : '333333',
                }),
              ],
              heading: headingMap[headingLevel] || HeadingLevel.HEADING_2,
              spacing: { before: 300, after: 150 },
            })
          );
          break;
        }

        case 'paragraph': {
          const cleanText = section.content
            .replace(/&nbsp;/g, ' ')
            .replace(/&amp;/g, '&')
            .replace(/&lt;/g, '<')
            .replace(/&gt;/g, '>')
            .replace(/&quot;/g, '"')
            .replace(/&#39;/g, "'")
            .replace(/\s+/g, ' ')
            .trim();

          if (cleanText.length < 3) continue;

          docChildren.push(
            new Paragraph({
              children: [
                new TextRun({
                  text: cleanText,
                  size: 22,
                  font: 'Calibri',
                }),
              ],
              spacing: { after: 150, line: 312 },
              alignment: AlignmentType.JUSTIFIED,
            })
          );
          break;
        }

        case 'formula': {
          const textRuns = parseLatexToTextRuns(section.content);
          docChildren.push(
            new Paragraph({
              children: textRuns,
              spacing: { before: 250, after: 250, line: 360 },
              alignment: AlignmentType.CENTER,
              indent: { left: 720, right: 720 },
              border: {
                top: { style: BorderStyle.SINGLE, size: 2, color: 'd0d0d0' },
                bottom: { style: BorderStyle.SINGLE, size: 2, color: 'd0d0d0' },
                left: { style: BorderStyle.SINGLE, size: 6, color: '2d6a4f' },
              },
              shading: {
                type: ShadingType.CLEAR,
                fill: 'f0f7f4',
              },
            })
          );
          break;
        }

        case 'image': {
          if (section.imageData && section.imageData.length > 100) {
            try {
              // Calculate dimensions preserving aspect ratio (max width 520pt ~ 6.8 inches)
              const maxDocxWidth = 520;
              let imgW = section.imageWidth || 580;
              let imgH = section.imageHeight || 360;
              if (imgW > maxDocxWidth) {
                const scale = maxDocxWidth / imgW;
                imgW = maxDocxWidth;
                imgH = Math.round(imgH * scale);
              }

              docChildren.push(
                new Paragraph({
                  children: [
                    new ImageRun({
                      data: section.imageData,
                      transformation: {
                        width: imgW,
                        height: imgH,
                      },
                      type: 'png',
                    }),
                  ],
                  spacing: { before: 200, after: 100 },
                  alignment: AlignmentType.CENTER,
                })
              );
            } catch (imgErr) {
              console.error('Failed to embed image:', section.content, imgErr);
              docChildren.push(
                new Paragraph({
                  children: [
                    new TextRun({
                      text: `[Image: ${section.content}]`,
                      italics: true,
                      size: 18,
                      color: '999999',
                      font: 'Calibri',
                    }),
                  ],
                  spacing: { after: 100 },
                  alignment: AlignmentType.CENTER,
                })
              );
            }
          }
          break;
        }

        case 'carousel': {
          // Add a heading for the carousel
          docChildren.push(
            new Paragraph({
              children: [
                new TextRun({
                  text: section.content || 'Featured Images',
                  bold: true,
                  size: 22,
                  font: 'Calibri',
                  color: '555555',
                }),
              ],
              spacing: { before: 200, after: 100 },
              alignment: AlignmentType.CENTER,
            })
          );

          // Add each image in order
          if (section.images) {
            for (let i = 0; i < section.images.length; i++) {
              const img = section.images[i];
              if (img.buffer.length > 100) {
                try {
                  const maxDocxWidth = 520;
                  let imgW = img.width || 580;
                  let imgH = img.height || 360;
                  if (imgW > maxDocxWidth) {
                    const scale = maxDocxWidth / imgW;
                    imgW = maxDocxWidth;
                    imgH = Math.round(imgH * scale);
                  }

                  docChildren.push(
                    new Paragraph({
                      children: [
                        new ImageRun({
                          data: img.buffer,
                          transformation: { width: imgW, height: imgH },
                          type: 'png',
                        }),
                      ],
                      spacing: { before: 150, after: 80 },
                      alignment: AlignmentType.CENTER,
                    })
                  );

                  // Image caption
                  if (img.alt) {
                    docChildren.push(
                      new Paragraph({
                        children: [
                          new TextRun({
                            text: `Figure ${i + 1}: ${img.alt}`,
                            italics: true,
                            size: 18,
                            color: '888888',
                            font: 'Calibri',
                          }),
                        ],
                        spacing: { after: 150 },
                        alignment: AlignmentType.CENTER,
                      })
                    );
                  }
                } catch (err) {
                  console.error('Failed to embed carousel image:', err);
                }
              }
            }
          }
          break;
        }

        case 'code': {
          const codeLines = section.content.split('\n');
          // Code block label
          docChildren.push(
            new Paragraph({
              children: [
                new TextRun({
                  text: 'Code',
                  bold: true,
                  size: 20,
                  font: 'Calibri',
                  color: '444444',
                }),
              ],
              spacing: { before: 150, after: 50 },
              shading: {
                type: ShadingType.CLEAR,
                fill: 'e8e8e8',
              },
            })
          );
          for (const line of codeLines) {
            docChildren.push(
              new Paragraph({
                children: [
                  new TextRun({
                    text: line || ' ',
                    size: 18,
                    font: 'Consolas',
                  }),
                ],
                spacing: { after: 0, line: 240 },
                indent: { left: 360 },
                shading: {
                  type: ShadingType.CLEAR,
                  fill: 'f5f5f5',
                },
              })
            );
          }
          docChildren.push(new Paragraph({ children: [], spacing: { after: 150 } }));
          break;
        }

        case 'list': {
          if (section.items) {
            for (const item of section.items) {
              const cleanItem = item
                .replace(/&nbsp;/g, ' ')
                .replace(/&amp;/g, '&')
                .replace(/&lt;/g, '<')
                .replace(/&gt;/g, '>')
                .replace(/\s+/g, ' ')
                .trim();

              docChildren.push(
                new Paragraph({
                  children: [
                    new TextRun({
                      text: '\u2022  ' + cleanItem,
                      size: 22,
                      font: 'Calibri',
                    }),
                  ],
                  spacing: { after: 80, line: 312 },
                  indent: { left: 540, hanging: 180 },
                })
              );
            }
          }
          break;
        }

        case 'table': {
          if (section.rows && section.rows.length > 0) {
            const tableRows = section.rows.map((row, rowIndex) => {
              return new TableRow({
                tableHeader: rowIndex === 0,
                cantSplit: true,
                children: row.map(cell => {
                  return new TableCell({
                    children: [
                      new Paragraph({
                        children: [
                          new TextRun({
                            text: cell,
                            bold: rowIndex === 0,
                            size: 20,
                            font: 'Calibri',
                            color: rowIndex === 0 ? 'ffffff' : '333333',
                          }),
                        ],
                        spacing: { after: 60 },
                      }),
                    ],
                    shading: rowIndex === 0
                      ? { type: ShadingType.CLEAR, fill: '2d6a4f', color: 'auto' }
                      : rowIndex % 2 === 0
                        ? { type: ShadingType.CLEAR, fill: 'f0f7f4', color: 'auto' }
                        : undefined,
                    margins: { top: 40, bottom: 40, left: 100, right: 100 },
                  });
                }),
              });
            });

            docChildren.push(
              new Table({
                rows: tableRows,
                width: { size: 100, type: WidthType.PERCENTAGE },
              })
            );
            docChildren.push(new Paragraph({ children: [], spacing: { after: 200 } }));
          }
          break;
        }

        case 'hr': {
          docChildren.push(
            new Paragraph({
              children: [],
              spacing: { before: 100, after: 100 },
              border: {
                bottom: { style: BorderStyle.SINGLE, size: 2, color: 'd0d0d0' },
              },
            })
          );
          break;
        }
      }
    }

    // Page separator between pages (not after the last one)
    if (pageIdx < pages.length - 1) {
      docChildren.push(new Paragraph({ children: [new PageBreak()] }));
    }
  }

  // ── Build Document ──
  const doc = new Document({
    sections: [
      {
        properties: {
          page: {
            margin: { top: 720, bottom: 720, left: 900, right: 900 },
          },
        },
        children: docChildren,
      },
    ],
  });

  // ── Save to file ──
  const filePath = path.join(DOWNLOAD_DIR, fileName);
  const buffer = await Packer.toBuffer(doc);
  fs.writeFileSync(filePath, buffer);

  return filePath;
}

// ─── Main Scraping Orchestrator ───────────────────────────────────────────

async function orchestrateScrape(
  startUrl: string,
  depth: number,
  followLinks: boolean,
  socket: any,
  sessionId: string
) {
  const visitedUrls = new Set<string>();
  const allPages: ScrapedPage[] = [];
  const urlQueue: { url: string; depth: number }[] = [{ url: startUrl, depth: 0 }];

  const sendProgress = (p: ScrapeProgress) => {
    socket.emit('progress', { ...p, sessionId });
  };

  try {
    sendProgress({ type: 'status', message: 'Starting scrape engine...' });

    while (urlQueue.length > 0 && allPages.length < MAX_PAGES) {
      const { url, depth: currentDepth } = urlQueue.shift()!;

      if (visitedUrls.has(url)) continue;
      visitedUrls.add(url);

      if (currentDepth > depth) break;

      sendProgress({
        type: 'status',
        message: `Scraping page ${allPages.length + 1}/${MAX_PAGES} (depth ${currentDepth}/${depth})`,
        current: allPages.length + 1,
        total: Math.min(MAX_PAGES, visitedUrls.size + urlQueue.length),
      });

      try {
        const page = await scrapePage(url, socket, {
          current: allPages.length + 1,
          total: Math.min(MAX_PAGES, visitedUrls.size + urlQueue.length),
        });

        allPages.push(page);

        // Add child links to queue if followLinks is enabled
        if (followLinks && currentDepth < depth) {
          let addedLinks = 0;
          for (const link of page.childLinks) {
            if (!visitedUrls.has(link) && allPages.length + urlQueue.length < MAX_PAGES) {
              urlQueue.push({ url: link, depth: currentDepth + 1 });
              sendProgress({
                type: 'link_found',
                message: `Found related page: ${link}`,
                url: link,
              });
              addedLinks++;
            }
          }
        }
      } catch (err: any) {
        sendProgress({
          type: 'error',
          message: `Failed to scrape ${url}: ${err.message}`,
          url,
        });
      }

      // Delay between page requests to be respectful
      if (urlQueue.length > 0) {
        await new Promise(r => setTimeout(r, 1500));
      }
    }

    // Generate Word document
    sendProgress({ type: 'status', message: `Generating Word document with ${allPages.length} page(s)...` });

    const timestamp = new Date().toISOString().replace(/[:.]/g, '-').substring(0, 19);
    const sanitizedTitle = allPages[0]?.title.replace(/[^a-zA-Z0-9]/g, '_').substring(0, 40) || 'scraped';
    const fileName = `GFG_${sanitizedTitle}_${timestamp}.docx`;
    const filePath = await generateDocx(allPages, fileName);

    sendProgress({
      type: 'complete',
      message: `Document generated successfully! ${allPages.length} page(s) scraped with ${allPages.reduce((sum, p) => sum + p.images.length, 0)} image(s).`,
      filePath: `/download/${fileName}`,
      fileName,
    });

    console.log(`[Scrape Complete] Session: ${sessionId}, Pages: ${allPages.length}, File: ${filePath}`);
  } catch (err: any) {
    sendProgress({
      type: 'error',
      message: `Scrape failed: ${err.message}`,
    });
    console.error(`[Scrape Error] Session: ${sessionId}`, err);
  }
}

// ─── Socket.IO Server ─────────────────────────────────────────────────────

io.on('connection', (socket) => {
  console.log(`Client connected: ${socket.id}`);

  socket.on('scrape', async (data: { url: string; depth: number; followLinks: boolean }) => {
    const { url, depth = 1, followLinks = true } = data;

    if (!url) {
      socket.emit('progress', { type: 'error', message: 'URL is required' });
      return;
    }

    if (!url.startsWith('http://') && !url.startsWith('https://')) {
      socket.emit('progress', { type: 'error', message: 'Invalid URL format. Must start with http:// or https://' });
      return;
    }

    const sessionId = socket.id;
    console.log(`[Scrape Start] Session: ${sessionId}, URL: ${url}, Depth: ${depth}, FollowLinks: ${followLinks}`);

    await orchestrateScrape(url, depth, followLinks, socket, sessionId);
  });

  socket.on('disconnect', () => {
    console.log(`Client disconnected: ${socket.id}`);
  });

  socket.on('error', (error) => {
    console.error(`Socket error (${socket.id}):`, error);
  });
});

const PORT = 3004;
httpServer.listen(PORT, () => {
  console.log(`Scrape service running on port ${PORT}`);
});

process.on('SIGTERM', () => {
  console.log('Received SIGTERM, shutting down...');
  httpServer.close(() => process.exit(0));
});

process.on('SIGINT', () => {
  console.log('Received SIGINT, shutting down...');
  httpServer.close(() => process.exit(0));
});