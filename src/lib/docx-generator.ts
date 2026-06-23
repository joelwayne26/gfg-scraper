import {
  Document, Packer, Paragraph, TextRun, ImageRun,
  AlignmentType, Table, TableRow, TableCell,
  WidthType, PageBreak, ExternalHyperlink,
} from 'docx';
import type { ContentSection, ScrapedPageData, CrossRefEntry, InlineRun } from './scraper';

// A4 content width in DXA (1 inch margins each side = 9360 DXA)
const PAGE_WIDTH_DXA = 9360;

function cleanText(t: string): string {
  return t.replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/\s+/g, ' ').trim();
}

function buildRunsFromInline(runs: InlineRun[]): TextRun[] {
  return runs.map(r => {
    const opts: any = { text: r.text, size: 22, font: 'Calibri' };
    if (r.bold) opts.bold = true;
    if (r.italics) opts.italics = true;
    if (r.code) { opts.font = 'Consolas'; opts.size = 20; }
    if (r.link) {
      return new ExternalHyperlink({
        children: [new TextRun({ text: r.text, bold: r.bold, italics: r.italics, font: r.code ? 'Consolas' : 'Calibri', size: r.code ? 20 : 22, style: 'Hyperlink' })],
        link: r.link,
      });
    }
    return new TextRun(opts);
  });
}

export async function generateDocxBuffer(
  pages: ScrapedPageData[],
  topic: string,
  _crossRefs: CrossRefEntry[],
): Promise<{ buffer: Buffer; fileName: string }> {
  const children: (Paragraph | Table)[] = [];

  // Simple header — just like ML4.docx
  children.push(new Paragraph({
    children: [new TextRun({ text: ` ${topic}`, size: 48, bold: true, font: 'Calibri' })],
    spacing: { after: 100 },
  }));
  children.push(new Paragraph({
    children: [new TextRun({ text: ` ${new Date().toLocaleDateString('en-US', { day: 'numeric', month: 'long', year: 'numeric' })}`, size: 22, font: 'Calibri' })],
    spacing: { after: 80 },
  }));
  children.push(new Paragraph({
    children: [new TextRun({ text: ` ${new Date().toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' })}`, size: 22, font: 'Calibri' })],
    spacing: { after: 400 },
  }));

  for (let pi = 0; pi < pages.length; pi++) {
    const page = pages[pi];

    // Page title
    children.push(new Paragraph({
      children: [new TextRun({ text: ` ${page.title}`, bold: true, size: 32, font: 'Calibri' })],
      spacing: { before: 400, after: 80 },
    }));

    // Source URL
    children.push(new Paragraph({
      children: [new TextRun({ text: page.url, size: 18, font: 'Calibri', color: '888888' })],
      spacing: { after: 200 },
    }));

    for (const sec of page.sections) {
      switch (sec.type) {

        case 'heading': {
          const lvl = sec.level || 2;
          const sizes: Record<number, number> = { 1: 30, 2: 26, 3: 24, 4: 22, 5: 20, 6: 20 };
          children.push(new Paragraph({
            children: [new TextRun({ text: sec.content, bold: true, size: sizes[lvl] || 24, font: 'Calibri' })],
            spacing: { before: 250, after: 80 },
          }));
          break;
        }

        case 'paragraph': {
          const clean = cleanText(sec.content);
          if (clean.length < 1) continue;
          children.push(new Paragraph({
            children: [new TextRun({ text: clean, size: 22, font: 'Calibri' })],
            spacing: { after: 120, line: 276 },
          }));
          break;
        }

        // Rich paragraph with inline bold/code/links
        case 'rich-paragraph': {
          if (!sec.runs || sec.runs.length === 0) break;
          const textRuns = buildRunsFromInline(sec.runs);
          if (textRuns.length > 0) {
            children.push(new Paragraph({
              children: textRuns,
              spacing: { after: 120, line: 276 },
            }));
          }
          break;
        }

        // Formula rendered as PNG image
        case 'formula-image': {
          if (sec.imageData && sec.imageData.length > 50) {
            try {
              const w = sec.imageWidth || 300;
              const h = sec.imageHeight || 50;
              children.push(new Paragraph({
                children: [new ImageRun({ data: sec.imageData, transformation: { width: w, height: h }, type: 'png' })],
                spacing: { before: 120, after: 120 }, alignment: AlignmentType.CENTER,
              }));
            } catch {
              // Fallback to text
              const { renderLatexToUnicode } = await import('./scraper');
              children.push(new Paragraph({
                children: [new TextRun({ text: renderLatexToUnicode(sec.content), size: 22, font: 'Cambria Math', italics: true })],
                spacing: { before: 120, after: 120 },
              }));
            }
          }
          break;
        }

        case 'image': {
          if (sec.imageData && sec.imageData.length > 100) {
            try {
              let w = sec.imageWidth || 580;
              let h = sec.imageHeight || 360;
              const maxW = 550;
              if (w > maxW) { const s = maxW / w; w = maxW; h = Math.round(h * s); }
              if (h < 10) h = 300;
              if (w < 10) w = 500;
              children.push(new Paragraph({
                children: [new ImageRun({ data: sec.imageData, transformation: { width: w, height: h }, type: 'png' })],
                spacing: { before: 120, after: 120 }, alignment: AlignmentType.CENTER,
              }));
            } catch {
              children.push(new Paragraph({
                children: [new TextRun({ text: `[Image: ${sec.content}]`, size: 18, font: 'Calibri', italics: true })],
                spacing: { after: 80 }, alignment: AlignmentType.CENTER,
              }));
            }
          }
          break;
        }

        case 'carousel': {
          if (sec.images) {
            for (const img of sec.images) {
              if (img.buffer.length > 100) {
                try {
                  let w = img.width || 580;
                  let h = img.height || 360;
                  const maxW = 550;
                  if (w > maxW) { const s = maxW / w; w = maxW; h = Math.round(h * s); }
                  if (h < 10) h = 300;
                  if (w < 10) w = 500;
                  children.push(new Paragraph({
                    children: [new ImageRun({ data: img.buffer, transformation: { width: w, height: h }, type: 'png' })],
                    spacing: { before: 100, after: 100 }, alignment: AlignmentType.CENTER,
                  }));
                } catch { /* skip */ }
              }
            }
          }
          break;
        }

        case 'code': {
          // Plain monospace — like ML4.docx
          for (const line of sec.content.split('\n')) {
            children.push(new Paragraph({
              children: [new TextRun({ text: line || ' ', size: 18, font: 'Consolas' })],
              spacing: { after: 0, line: 240 },
            }));
          }
          children.push(new Paragraph({ children: [], spacing: { after: 120 } }));
          break;
        }

        case 'list': {
          if (sec.items) for (const item of sec.items) {
            children.push(new Paragraph({
              children: [new TextRun({ text: cleanText(item), size: 22, font: 'Calibri' })],
              spacing: { after: 60, line: 276 },
              indent: { left: 360 },
            }));
          }
          break;
        }

        case 'table': {
          if (sec.rows && sec.rows.length > 0) {
            const numCols = Math.max(...sec.rows.map(r => r.length));
            const colWidth = Math.floor(PAGE_WIDTH_DXA / numCols);
            const columnWidths = Array(numCols).fill(colWidth);

            const rows = sec.rows.map((row, ri) => new TableRow({
              tableHeader: ri === 0,
              children: row.map(cell => new TableCell({
                children: [new Paragraph({
                  children: [new TextRun({ text: cell, bold: ri === 0, size: 20, font: 'Calibri' })],
                  spacing: { after: 40 },
                })],
                margins: { top: 40, bottom: 40, left: 80, right: 80 },
              })),
            }));
            children.push(new Table({
              rows,
              width: { size: PAGE_WIDTH_DXA, type: WidthType.DXA },
              columnWidths,
            }));
            children.push(new Paragraph({ children: [], spacing: { after: 150 } }));
          }
          break;
        }

        case 'hr': {
          children.push(new Paragraph({ children: [], spacing: { after: 80 } }));
          break;
        }

        case 'xref': {
          children.push(new Paragraph({
            children: [new TextRun({ text: `[Already covered: ${sec.content}${sec.refTopic ? ` in "${sec.refTopic}"` : ''}]`, size: 20, font: 'Calibri', italics: true, color: '888888' })],
            spacing: { before: 80, after: 80 },
          }));
          break;
        }
      }
    }

    if (pi < pages.length - 1) children.push(new Paragraph({ children: [new PageBreak()] }));
  }

  const doc = new Document({
    sections: [{ properties: { page: { margin: { top: 720, bottom: 720, left: 900, right: 900 } } }, children }],
  });

  const fileName = `${topic.replace(/[^a-zA-Z0-9]/g, '_')}.docx`;
  const buffer = await Packer.toBuffer(doc);
  return { buffer, fileName };
}