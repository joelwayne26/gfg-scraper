'use client';

import { useEffect, useState, useRef, useCallback } from 'react';
import { io, Socket } from 'socket.io-client';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Badge } from '@/components/ui/badge';
import { Progress } from '@/components/ui/progress';
import { Switch } from '@/components/ui/switch';
import { Slider } from '@/components/ui/slider';
import { Label } from '@/components/ui/label';
import {
  Globe, Download, Play, Loader2, CheckCircle2, XCircle,
  ImageIcon, Link2, FileText, AlertTriangle, Zap, ArrowRight, Layers, Settings2
} from 'lucide-react';

interface ProgressEvent {
  type: 'status' | 'page_done' | 'image_done' | 'error' | 'complete' | 'link_found';
  message: string;
  current?: number;
  total?: number;
  url?: string;
  filePath?: string;
  fileName?: string;
}

export default function Home() {
  const [url, setUrl] = useState('https://www.geeksforgeeks.org/data-science/data-mining/');
  const [depth, setDepth] = useState(1);
  const [maxPages, setMaxPages] = useState(10);
  const [followLinks, setFollowLinks] = useState(true);
  const [isConnected, setIsConnected] = useState(false);
  const [isScraping, setIsScraping] = useState(false);
  const [progressEvents, setProgressEvents] = useState<ProgressEvent[]>([]);
  const [completedFile, setCompletedFile] = useState<{ filePath: string; fileName: string } | null>(null);
  const [pagesScraped, setPagesScraped] = useState(0);
  const [imagesDownloaded, setImagesDownloaded] = useState(0);
  const [totalLinks, setTotalLinks] = useState(0);
  const socketRef = useRef<Socket | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  // Connect to WebSocket
  useEffect(() => {
    const socketInstance = io('/?XTransformPort=3004', {
      transports: ['websocket', 'polling'],
      forceNew: true,
      reconnection: true,
      reconnectionAttempts: 5,
      reconnectionDelay: 2000,
      timeout: 15000,
    });

    socketInstance.on('connect', () => {
      setIsConnected(true);
    });

    socketInstance.on('disconnect', () => {
      setIsConnected(false);
    });

    socketInstance.on('progress', (event: ProgressEvent) => {
      setProgressEvents((prev) => [...prev, event]);

      if (event.type === 'page_done') {
        setPagesScraped((p) => p + 1);
      }
      if (event.type === 'image_done') {
        setImagesDownloaded((i) => i + 1);
      }
      if (event.type === 'link_found') {
        setTotalLinks((t) => t + 1);
      }
      if (event.type === 'complete') {
        setIsScraping(false);
        if (event.fileName) {
          setCompletedFile({
            filePath: event.filePath || `/download/${event.fileName}`,
            fileName: event.fileName,
          });
        }
      }
      if (event.type === 'error') {
        if (event.message.includes('Scrape failed:')) {
          setIsScraping(false);
        }
      }
    });

    socketRef.current = socketInstance;

    return () => {
      socketInstance.disconnect();
    };
  }, []);

  // Auto-scroll progress log
  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [progressEvents]);

  // Compute progress percentage
  const computedProgress = isScraping
    ? Math.min(
        (pagesScraped * 40 + imagesDownloaded * 3) / (maxPages * 40) * 100,
        95
      )
    : completedFile
    ? 100
    : 0;

  const handleScrape = useCallback(() => {
    if (!socketRef.current || !isConnected || !url.trim()) return;

    setProgressEvents([]);
    setPagesScraped(0);
    setImagesDownloaded(0);
    setTotalLinks(0);
    setCompletedFile(null);
    setIsScraping(true);

    socketRef.current.emit('scrape', {
      url: url.trim(),
      depth,
      followLinks,
    });
  }, [url, depth, maxPages, followLinks, isConnected]);

  const getEventIcon = (type: ProgressEvent['type']) => {
    switch (type) {
      case 'status': return <Loader2 className="h-3.5 w-3.5 animate-spin text-sky-500 shrink-0" />;
      case 'page_done': return <CheckCircle2 className="h-3.5 w-3.5 text-emerald-500 shrink-0" />;
      case 'image_done': return <ImageIcon className="h-3.5 w-3.5 text-violet-500 shrink-0" />;
      case 'error': return <XCircle className="h-3.5 w-3.5 text-red-500 shrink-0" />;
      case 'complete': return <CheckCircle2 className="h-3.5 w-3.5 text-emerald-600 shrink-0" />;
      case 'link_found': return <Link2 className="h-3.5 w-3.5 text-amber-500 shrink-0" />;
    }
  };

  return (
    <div className="min-h-screen flex flex-col bg-gradient-to-br from-gray-50 via-white to-gray-100">
      {/* Header */}
      <header className="border-b bg-white/80 backdrop-blur-sm sticky top-0 z-50">
        <div className="max-w-5xl mx-auto px-4 py-4 flex items-center gap-3">
          <div className="flex items-center justify-center w-10 h-10 rounded-xl bg-gradient-to-br from-emerald-500 to-teal-600 shadow-lg shadow-emerald-500/20">
            <Zap className="h-5 w-5 text-white" />
          </div>
          <div>
            <h1 className="text-lg font-bold tracking-tight text-gray-900">GFG Scraper</h1>
            <p className="text-xs text-gray-500">GeeksforGeeks to Word Document Converter</p>
          </div>
          <div className="ml-auto flex items-center gap-2">
            <div className={`h-2 w-2 rounded-full ${isConnected ? 'bg-emerald-500 animate-pulse' : 'bg-red-400'}`} />
            <span className="text-xs text-gray-500">{isConnected ? 'Connected' : 'Disconnected'}</span>
          </div>
        </div>
      </header>

      {/* Main Content */}
      <main className="flex-1 max-w-5xl mx-auto w-full px-4 py-8 space-y-6">
        {/* Configuration Card */}
        <Card className="shadow-lg border-0 bg-white">
          <CardHeader className="pb-4">
            <CardTitle className="flex items-center gap-2 text-lg">
              <Globe className="h-5 w-5 text-emerald-600" />
              Scrape Configuration
            </CardTitle>
            <CardDescription>
              Enter a GeeksforGeeks URL. The system extracts text, images, formulas in order, and follows related links to build a complete Word document.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-5">
            {/* URL Input */}
            <div className="space-y-2">
              <Label className="text-sm font-medium text-gray-700 flex items-center gap-1.5">
                <Link2 className="h-3.5 w-3.5" />
                Target URL
              </Label>
              <div className="flex gap-2">
                <Input
                  value={url}
                  onChange={(e) => setUrl(e.target.value)}
                  placeholder="https://www.geeksforgeeks.org/..."
                  disabled={isScraping}
                  className="flex-1 h-11 text-sm"
                  onKeyDown={(e) => e.key === 'Enter' && !isScraping && handleScrape()}
                />
                <Button
                  onClick={handleScrape}
                  disabled={isScraping || !isConnected || !url.trim()}
                  className="h-11 px-6 bg-gradient-to-r from-emerald-600 to-teal-600 hover:from-emerald-700 hover:to-teal-700 text-white shadow-lg shadow-emerald-500/20 transition-all"
                >
                  {isScraping ? (
                    <>
                      <Loader2 className="h-4 w-4 animate-spin mr-2" />
                      Scraping...
                    </>
                  ) : (
                    <>
                      <Play className="h-4 w-4 mr-2" />
                      Start Scrape
                    </>
                  )}
                </Button>
              </div>
            </div>

            {/* Settings Row */}
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
              {/* Depth Control */}
              <div className="space-y-3 p-4 rounded-lg bg-gray-50 border border-gray-100">
                <div className="flex items-center justify-between">
                  <Label className="text-sm font-medium text-gray-700 flex items-center gap-1.5">
                    <Layers className="h-3.5 w-3.5" />
                    Link Depth
                  </Label>
                  <Badge variant="secondary" className="font-mono text-xs">{depth}</Badge>
                </div>
                <Slider
                  value={[depth]}
                  onValueChange={(v) => setDepth(v[0])}
                  min={0}
                  max={3}
                  step={1}
                  disabled={isScraping}
                  className="w-full"
                />
                <div className="flex justify-between text-[11px] text-gray-400">
                  <span>Current page only</span>
                  <span>Deep crawl</span>
                </div>
              </div>

              {/* Max Pages Control */}
              <div className="space-y-3 p-4 rounded-lg bg-gray-50 border border-gray-100">
                <div className="flex items-center justify-between">
                  <Label className="text-sm font-medium text-gray-700 flex items-center gap-1.5">
                    <FileText className="h-3.5 w-3.5" />
                    Max Pages
                  </Label>
                  <Badge variant="secondary" className="font-mono text-xs">{maxPages}</Badge>
                </div>
                <Slider
                  value={[maxPages]}
                  onValueChange={(v) => setMaxPages(v[0])}
                  min={1}
                  max={15}
                  step={1}
                  disabled={isScraping}
                  className="w-full"
                />
                <div className="flex justify-between text-[11px] text-gray-400">
                  <span>1 page</span>
                  <span>15 pages</span>
                </div>
              </div>

              {/* Follow Links Toggle */}
              <div className="space-y-3 p-4 rounded-lg bg-gray-50 border border-gray-100 flex flex-col justify-between">
                <div>
                  <Label className="text-sm font-medium text-gray-700 flex items-center gap-1.5">
                    <ArrowRight className="h-3.5 w-3.5" />
                    Follow Related Links
                  </Label>
                  <p className="text-xs text-gray-500 mt-1">
                    Scrape linked GFG pages recursively
                  </p>
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-sm text-gray-600">
                    {followLinks ? 'Enabled' : 'Disabled'}
                  </span>
                  <Switch
                    checked={followLinks}
                    onCheckedChange={setFollowLinks}
                    disabled={isScraping}
                  />
                </div>
              </div>
            </div>
          </CardContent>
        </Card>

        {/* Stats Bar */}
        {(isScraping || completedFile) && (
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            <Card className="border-0 shadow-sm bg-white">
              <CardContent className="p-4 flex items-center gap-3">
                <div className="p-2 rounded-lg bg-sky-50">
                  <FileText className="h-4 w-4 text-sky-600" />
                </div>
                <div>
                  <p className="text-2xl font-bold text-gray-900">{pagesScraped}</p>
                  <p className="text-xs text-gray-500">Pages Scraped</p>
                </div>
              </CardContent>
            </Card>
            <Card className="border-0 shadow-sm bg-white">
              <CardContent className="p-4 flex items-center gap-3">
                <div className="p-2 rounded-lg bg-violet-50">
                  <ImageIcon className="h-4 w-4 text-violet-600" />
                </div>
                <div>
                  <p className="text-2xl font-bold text-gray-900">{imagesDownloaded}</p>
                  <p className="text-xs text-gray-500">Images Saved</p>
                </div>
              </CardContent>
            </Card>
            <Card className="border-0 shadow-sm bg-white">
              <CardContent className="p-4 flex items-center gap-3">
                <div className="p-2 rounded-lg bg-amber-50">
                  <Link2 className="h-4 w-4 text-amber-600" />
                </div>
                <div>
                  <p className="text-2xl font-bold text-gray-900">{totalLinks}</p>
                  <p className="text-xs text-gray-500">Links Found</p>
                </div>
              </CardContent>
            </Card>
            <Card className="border-0 shadow-sm bg-white">
              <CardContent className="p-4 flex items-center gap-3">
                <div className="p-2 rounded-lg bg-emerald-50">
                  {completedFile ? (
                    <CheckCircle2 className="h-4 w-4 text-emerald-600" />
                  ) : (
                    <Loader2 className="h-4 w-4 text-emerald-600 animate-spin" />
                  )}
                </div>
                <div>
                  <p className="text-sm font-bold text-gray-900">
                    {completedFile ? 'Complete' : 'Working...'}
                  </p>
                  <p className="text-xs text-gray-500">
                    {completedFile ? 'Ready to download' : 'Please wait'}
                  </p>
                </div>
              </CardContent>
            </Card>
          </div>
        )}

        {/* Progress Bar */}
        {isScraping && (
          <Card className="border-0 shadow-sm bg-white">
            <CardContent className="p-4 space-y-2">
              <div className="flex justify-between text-sm">
                <span className="font-medium text-gray-700">Scraping Progress</span>
                <span className="text-gray-500">{Math.round(computedProgress)}%</span>
              </div>
              <Progress value={computedProgress} className="h-2.5" />
            </CardContent>
          </Card>
        )}

        {/* Download Card */}
        {completedFile && (
          <Card className="border-2 border-emerald-200 shadow-lg bg-gradient-to-r from-emerald-50 to-teal-50">
            <CardContent className="p-6 flex flex-col sm:flex-row items-center justify-between gap-4">
              <div className="flex items-center gap-3">
                <div className="p-3 rounded-xl bg-emerald-100">
                  <Download className="h-6 w-6 text-emerald-700" />
                </div>
                <div>
                  <p className="font-semibold text-gray-900">Document Ready!</p>
                  <p className="text-sm text-gray-600 truncate max-w-xs">{completedFile.fileName}</p>
                </div>
              </div>
              <Button
                asChild
                className="bg-gradient-to-r from-emerald-600 to-teal-600 hover:from-emerald-700 hover:to-teal-700 text-white shadow-lg shadow-emerald-500/20 px-8 h-11"
              >
                <a href={`/api/download?file=${encodeURIComponent(completedFile.fileName)}`}>
                  <Download className="h-4 w-4 mr-2" />
                  Download Word Document
                </a>
              </Button>
            </CardContent>
          </Card>
        )}

        {/* Progress Log */}
        {progressEvents.length > 0 && (
          <Card className="border-0 shadow-lg bg-white">
            <CardHeader className="pb-3">
              <CardTitle className="text-base flex items-center gap-2">
                <AlertTriangle className="h-4 w-4 text-amber-500" />
                Activity Log
                <Badge variant="secondary" className="ml-auto text-xs">
                  {progressEvents.length} events
                </Badge>
              </CardTitle>
            </CardHeader>
            <CardContent className="p-0">
              <div
                ref={scrollRef}
                className="max-h-80 overflow-y-auto"
              >
                <div className="divide-y">
                  {progressEvents.map((event, i) => (
                    <div
                      key={i}
                      className={`flex items-start gap-3 px-4 py-2.5 text-sm transition-colors ${
                        event.type === 'error'
                          ? 'bg-red-50/50'
                          : event.type === 'complete'
                          ? 'bg-emerald-50/50'
                          : 'hover:bg-gray-50/50'
                      }`}
                    >
                      {getEventIcon(event.type)}
                      <div className="flex-1 min-w-0">
                        <p className={
                          event.type === 'error'
                            ? 'text-red-700'
                            : event.type === 'complete'
                            ? 'text-emerald-700 font-medium'
                            : 'text-gray-700'
                        }>
                          {event.message}
                        </p>
                        {event.url && (
                          <p className="text-xs text-gray-400 truncate mt-0.5">{event.url}</p>
                        )}
                      </div>
                      <span className="text-[10px] text-gray-400 whitespace-nowrap">
                        {new Date().toLocaleTimeString()}
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            </CardContent>
          </Card>
        )}

        {/* Info Card */}
        {!isScraping && !completedFile && progressEvents.length === 0 && (
          <Card className="border-0 shadow-sm bg-white">
            <CardContent className="p-6">
              <div className="flex items-start gap-4">
                <div className="p-3 rounded-xl bg-emerald-50">
                  <Settings2 className="h-6 w-6 text-emerald-600" />
                </div>
                <div className="space-y-2">
                  <h3 className="font-semibold text-gray-900">How It Works</h3>
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 text-sm text-gray-600">
                    <div className="flex items-start gap-2">
                      <span className="text-emerald-500 font-bold">1.</span>
                      <span>Enter a GeeksforGeeks URL and click <strong>Start Scrape</strong></span>
                    </div>
                    <div className="flex items-start gap-2">
                      <span className="text-emerald-500 font-bold">2.</span>
                      <span>The system fetches the page and extracts all content</span>
                    </div>
                    <div className="flex items-start gap-2">
                      <span className="text-emerald-500 font-bold">3.</span>
                      <span>Images are downloaded with <strong>correct aspect ratios</strong></span>
                    </div>
                    <div className="flex items-start gap-2">
                      <span className="text-emerald-500 font-bold">4.</span>
                      <span>Formulas are converted from LaTeX to Unicode math symbols</span>
                    </div>
                    <div className="flex items-start gap-2">
                      <span className="text-emerald-500 font-bold">5.</span>
                      <span>Related hyperlinks are followed to scrape linked pages</span>
                    </div>
                    <div className="flex items-start gap-2">
                      <span className="text-emerald-500 font-bold">6.</span>
                      <span>A formatted <strong>Word document</strong> is generated for download</span>
                    </div>
                  </div>
                </div>
              </div>
            </CardContent>
          </Card>
        )}
      </main>

      {/* Footer */}
      <footer className="border-t bg-white/80 backdrop-blur-sm mt-auto">
        <div className="max-w-5xl mx-auto px-4 py-4 text-center text-xs text-gray-400">
          GFG Scraper — Extracts content from GeeksforGeeks into structured Word documents with images, formulas, and related pages.
        </div>
      </footer>
    </div>
  );
}