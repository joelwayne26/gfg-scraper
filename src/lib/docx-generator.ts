import {
  Document, Packer, Paragraph, TextRun, ImageRun,
  AlignmentType, Table, TableRow, TableCell,
  WidthType, PageBreak,
} from 'docx';
import { renderLatex, type ContentSection, type ScrapedPageData, type CrossRefEntry } from './scraper';

export async function generateDocxBuffer(
  pages: ScrapedPageData[],
  topic: string,
  _crossRefs: CrossRefEntry[],
): Promise<{ buffer: Buffer; fileName: string }> {
  const children: (Paragraph | Table)[] = [];

  // Simple title — just the topic name
  children.push(new Paragraph({
    children: [new TextRun({ text: ` ${topic}`, size: 48, bold: true, font: 'Calibri' })],
    spacing: { after: 100 },
  }));
  children.push(new Paragraph({
    children: [new TextRun({ text: ` ${new Date().toLocaleDateString('en-US', { day: 'numeric', month: 'long', year: 'numeric' })}`, size: 22, font: 'Calibri' })],
    spacing: { after: 100 },
  }));
  children.push(new Paragraph({
    children: [new TextRun({ text: ` ${new Date().toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' })}`, size: 22, font: 'Calibri' })],
    spacing: { after: 400 },
  }));

  // ── Content Pages ──
  for (let pi = 0; pi < pages.length; pi++) {
    const page = pages[pi];

    // Page title — plain bold, no colors/borders
    children.push(new Paragraph({
      children: [new TextRun({ text: ` ${page.title}`, bold: true, size: 32, font: 'Calibri' })],
      spacing: { before: 400, after: 100 },
    }));

    // URL as plain text
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
          const clean = sec.content
            .replace(/&nbsp;/g, ' ')
            .replace(/&amp;/g, '&')
            .replace(/&lt;/g, '<')
            .replace(/&gt;/g, '>')
            .replace(/&quot;/g, '"')
            .replace(/&#39;/g, "'")
            .replace(/\s+/g, ' ')
            .trim();
          if (clean.length < 1) continue;
          children.push(new Paragraph({
            children: [new TextRun({ text: clean, size: 22, font: 'Calibri' })],
            spacing: { after: 120, line: 276 },
          }));
          break;
        }

        case 'formula': {
          const rendered = renderLatex(sec.content);
          children.push(new Paragraph({
            children: [new TextRun({ text: rendered, size: 22, font: 'Cambria Math', italics: true })],
            spacing: { before: 150, after: 150 },
          }));
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
              const imgType = (sec.imageExt === '.jpg' || sec.imageExt === '.jpeg') ? 'jpg' as const : 'png' as const;
              children.push(new Paragraph({
                children: [new ImageRun({ data: sec.imageData, transformation: { width: w, height: h }, type: imgType })],
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
          // Just paste all carousel images in order, no label
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
                  const imgType = (img.ext === '.jpg' || img.ext === '.jpeg') ? 'jpg' as const : 'png' as const;
                  children.push(new Paragraph({
                    children: [new ImageRun({ data: img.buffer, transformation: { width: w, height: h }, type: imgType })],
                    spacing: { before: 100, after: 100 }, alignment: AlignmentType.CENTER,
                  }));
                } catch { /* skip */ }
              }
            }
          }
          break;
        }

        case 'code': {
          // Plain monospace text, no background, no label
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
            const clean = item
              .replace(/&nbsp;/g, ' ')
              .replace(/&amp;/g, '&')
              .replace(/&lt;/g, '<')
              .replace(/&gt;/g, '>')
              .replace(/\s+/g, ' ')
              .trim();
            children.push(new Paragraph({
              children: [new TextRun({ text: clean, size: 22, font: 'Calibri' })],
              spacing: { after: 60, line: 276 },
              indent: { left: 360 },
            }));
          }
          break;
        }

        case 'table': {
          if (sec.rows && sec.rows.length > 0) {
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
            children.push(new Table({ rows, width: { size: 100, type: WidthType.PERCENTAGE } }));
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