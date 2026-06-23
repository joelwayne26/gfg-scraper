import { createServer } from 'http';
import { Server } from 'socket.io';
import ZAI from 'z-ai-web-dev-sdk';
import * as cheerio from 'cheerio';
import { scrapeTopic, loadRegistryFromDB } from '../../src/lib/scraper';
import { generateDocx } from '../../src/lib/docx-generator';
import type { ScrapeEvent } from '../../src/lib/scraper';

const DOWNLOAD_DIR = '/home/z/my-project/download';

const httpServer = createServer();
const io = new Server(httpServer, {
  path: '/',
  cors: { origin: '*', methods: ['GET', 'POST'] },
  pingTimeout: 120000,
  pingInterval: 25000,
});

async function main() {
  // Load DB registry
  try {
    const { db } = await import('../../src/lib/db');
    await loadRegistryFromDB(db);
    console.log('Loaded existing page registry from DB');
  } catch (e) {
    console.log('DB not available, starting fresh');
  }

  io.on('connection', (socket) => {
    console.log(`Client connected: ${socket.id}`);

    socket.on('scrape', async (data: { url: string; depth: number; followLinks: boolean; topic?: string; maxPages?: number }) => {
      const { url, depth = 1, followLinks = true, topic = 'Untitled', maxPages = 15 } = data;
      if (!url) { socket.emit('progress', { type: 'error', message: 'URL is required' }); return; }
      if (!url.startsWith('http://') && !url.startsWith('https://')) { socket.emit('progress', { type: 'error', message: 'Invalid URL' }); return; }

      console.log(`[Scrape] ${socket.id}: ${url} topic="${topic}" depth=${depth}`);

      try {
        const emit = (e: ScrapeEvent) => socket.emit('progress', e);

        const { pages, crossRefs } = await scrapeTopic(url, topic, depth, maxPages, emit);

        emit({ type: 'status', message: `Generating Word document...` });

        // Insert cross-reference sections into the pages
        if (crossRefs.length > 0) {
          emit({ type: 'xref_found', message: `Cross-referenced ${crossRefs.length} pages already in other topics` });
        }

        const fileName = await generateDocx(pages, topic, crossRefs);

        emit({
          type: 'complete',
          message: `Done! ${pages.length} pages scraped, ${crossRefs.length} cross-referenced.`,
          fileName,
          filePath: `/download/${fileName}`,
        });
      } catch (err: any) {
        socket.emit('progress', { type: 'error', message: `Scrape failed: ${err.message}` });
        console.error(`[Error] ${socket.id}:`, err);
      }
    });

    socket.on('disconnect', () => console.log(`Disconnected: ${socket.id}`));
  });

  const PORT = 3004;
  httpServer.listen(PORT, () => console.log(`Scrape service on port ${PORT}`));

  process.on('SIGTERM', () => httpServer.close(() => process.exit(0)));
  process.on('SIGINT', () => httpServer.close(() => process.exit(0)));
}

main().catch(console.error);