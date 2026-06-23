import { io } from 'socket.io-client';

const socket = io('http://localhost:3004', {
  transports: ['websocket'],
  forceNew: true,
  timeout: 30000,
});

socket.on('connect', () => {
  console.log('Connected to scrape service');
  socket.emit('scrape', {
    url: 'https://www.geeksforgeeks.org/natural-language-processing-nlp/',
    topic: 'NLP',
    depth: 2,
    followLinks: true,
    maxPages: 20,
  });
});

socket.on('progress', (e: any) => {
  const ts = new Date().toLocaleTimeString();
  console.log(`[${ts}] [${e.type}] ${e.message}${e.url ? ` | ${e.url}` : ''}`);
  if (e.type === 'complete') {
    console.log(`\nDONE! File: ${e.fileName}`);
    setTimeout(() => process.exit(0), 2000);
  }
});

socket.on('disconnect', () => { console.log('Disconnected'); process.exit(1); });
socket.on('error', (e: any) => { console.error('Socket error:', e); });

setTimeout(() => { console.log('Timeout'); process.exit(1); }, 600000);