'use client';

import { useEffect, useState, useRef, useCallback } from 'react';
import { io, Socket } from 'socket.io-client';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Progress } from '@/components/ui/progress';
import { Switch } from '@/components/ui/switch';
import { Label } from '@/components/ui/label';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import {
  Globe, Download, Play, Loader2, CheckCircle2, XCircle,
  ImageIcon, Link2, FileText, AlertTriangle, Zap, ArrowRight, Settings2, BookOpen, RefreshCw
} from 'lucide-react';

interface ScrapeEvent {
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

interface TopicInfo {
  name: string;
  pageCount: number;
  depth: number;
  startUrl: string;
  updatedAt: string;
  fileName?: string;
}

export default function Home() {
  const [url, setUrl] = useState('https://www.geeksforgeeks.org/natural-language-processing-nlp/');
  const [topic, setTopic] = useState('NLP');
  const [followLinks, setFollowLinks] = useState(true);
  const [isConnected, setIsConnected] = useState(false);
  const [isScraping, setIsScraping] = useState(false);
  const [events, setEvents] = useState<ScrapeEvent[]>([]);
  const [completedFile, setCompletedFile] = useState<{ fileName: string; downloadUrl: string } | null>(null);
  const [pagesScraped, setPagesScraped] = useState(0);
  const [imagesDownloaded, setImagesDownloaded] = useState(0);
  const [linksFound, setLinksFound] = useState(0);
  const [xrefCount, setXrefCount] = useState(0);
  const [topics, setTopics] = useState<TopicInfo[]>([]);
  const [useApi, setUseApi] = useState(false);
  const socketRef = useRef<Socket | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  // Try WebSocket, fall back to API mode
  useEffect(() => {
    const socket = io('/?XTransformPort=3004', {
      transports: ['websocket', 'polling'],
      forceNew: true,
      reconnection: true,
      reconnectionAttempts: 3,
      reconnectionDelay: 2000,
      timeout: 10000,
    });
    socket.on('connect', () => setIsConnected(true));
    socket.on('disconnect', () => {
      setIsConnected(false);
      setUseApi(true);
    });
    socket.on('progress', (e: ScrapeEvent) => {
      setEvents(prev => [...prev, e]);
      if (e.type === 'page_done') setPagesScraped(p => p + 1);
      if (e.type === 'image_done') setImagesDownloaded(i => i + 1);
      if (e.type === 'link_found') setLinksFound(l => l + 1);
      if (e.type === 'xref_found') setXrefCount(x => x + 1);
      if (e.type === 'complete') {
        setIsScraping(false);
        if (e.fileName) setCompletedFile({ fileName: e.fileName, downloadUrl: `/api/download?file=${encodeURIComponent(e.fileName)}` });
      }
      if (e.type === 'error' && e.message.includes('Scrape failed:')) setIsScraping(false);
    });
    socketRef.current = socket;

    // If not connected after 5s, switch to API mode
    const timer = setTimeout(() => { if (!isConnected) setUseApi(true); }, 5000);
    return () => { clearTimeout(timer); socket.disconnect(); };
  }, []);

  // Load topics
  useEffect(() => { fetch('/api/topics').then(r => r.json()).then(d => setTopics(d.topics || [])).catch(() => {}); }, [completedFile]);

  // Auto-scroll
  useEffect(() => { if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight; }, [events]);

  const computedProgress = isScraping ? Math.min((pagesScraped * 10 + imagesDownloaded * 1) * 2, 95) : completedFile ? 100 : 0;

  // API-based scraping (for Vercel)
  const handleApiScrape = useCallback(async () => {
    setEvents([]); setPagesScraped(0); setImagesDownloaded(0); setLinksFound(0); setXrefCount(0);
    setCompletedFile(null); setIsScraping(true);
    setEvents([{ type: 'status', message: `Starting API scrape for "${topic}"...` }]);

    try {
      const res = await fetch('/api/scrape', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: url.trim(), topic, followLinks }),
      });

      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error || 'Scrape failed');
      }

      const data = await res.json();

      // Replay events
      if (data.events) {
        for (const e of data.events) {
          setEvents(prev => [...prev, e]);
          if (e.type === 'page_done') setPagesScraped(p => p + 1);
          if (e.type === 'image_done') setImagesDownloaded(i => i + 1);
          if (e.type === 'link_found') setLinksFound(l => l + 1);
          if (e.type === 'xref_found') setXrefCount(x => x + 1);
        }
      }

      if (data.stats) {
        setPagesScraped(data.stats.pagesScraped);
        setXrefCount(data.stats.pagesReferenced);
        setImagesDownloaded(data.stats.imagesDownloaded);
      }

      if (data.success && data.fileName) {
        setCompletedFile({ fileName: data.fileName, downloadUrl: data.downloadUrl });
      }

      setIsScraping(false);
      setEvents(prev => [...prev, {
        type: 'complete',
        message: `Done! ${data.stats?.pagesScraped || 0} pages, ${data.stats?.pagesReferenced || 0} cross-referenced, ${data.stats?.imagesDownloaded || 0} images.`,
        fileName: data.fileName,
      }]);
    } catch (err: any) {
      setIsScraping(false);
      setEvents(prev => [...prev, { type: 'error', message: `Failed: ${err.message}` }]);
    }
  }, [url, topic, followLinks]);

  // WebSocket-based scraping
  const handleSocketScrape = useCallback(() => {
    if (!socketRef.current || !isConnected) return;
    setEvents([]); setPagesScraped(0); setImagesDownloaded(0); setLinksFound(0); setXrefCount(0);
    setCompletedFile(null); setIsScraping(true);
    socketRef.current.emit('scrape', { url: url.trim(), followLinks });
  }, [url, followLinks, isConnected]);

  const handleScrape = useApi ? handleApiScrape : handleSocketScrape;

  const getIcon = (type: ScrapeEvent['type']) => {
    switch (type) {
      case 'status': return <Loader2 className="h-3.5 w-3.5 animate-spin text-sky-500 shrink-0" />;
      case 'page_done': return <CheckCircle2 className="h-3.5 w-3.5 text-emerald-500 shrink-0" />;
      case 'image_done': return <ImageIcon className="h-3.5 w-3.5 text-violet-500 shrink-0" />;
      case 'error': return <XCircle className="h-3.5 w-3.5 text-red-500 shrink-0" />;
      case 'complete': case 'topic_done': return <CheckCircle2 className="h-3.5 w-3.5 text-emerald-600 shrink-0" />;
      case 'link_found': return <Link2 className="h-3.5 w-3.5 text-amber-500 shrink-0" />;
      case 'xref_found': return <BookOpen className="h-3.5 w-3.5 text-orange-500 shrink-0" />;
    }
  };

  return (
    <div className="min-h-screen flex flex-col bg-gradient-to-br from-gray-50 via-white to-gray-100">
      <header className="border-b bg-white/80 backdrop-blur-sm sticky top-0 z-50">
        <div className="max-w-5xl mx-auto px-4 py-4 flex items-center gap-3">
          <div className="flex items-center justify-center w-10 h-10 rounded-xl bg-gradient-to-br from-emerald-500 to-teal-600 shadow-lg shadow-emerald-500/20">
            <Zap className="h-5 w-5 text-white" />
          </div>
          <div>
            <h1 className="text-lg font-bold tracking-tight text-gray-900">GFG Scraper</h1>
            <p className="text-xs text-gray-500">GeeksforGeeks to Word with Cross-Topic Referencing</p>
          </div>
          <div className="ml-auto flex items-center gap-3">
            <Badge variant={useApi ? 'default' : 'secondary'} className="text-[10px]">
              {useApi ? 'API Mode' : isConnected ? 'WebSocket' : 'Connecting...'}
            </Badge>
            <div className={`h-2 w-2 rounded-full ${isConnected && !useApi ? 'bg-emerald-500 animate-pulse' : useApi ? 'bg-blue-500' : 'bg-red-400'}`} />
          </div>
        </div>
      </header>

      <main className="flex-1 max-w-5xl mx-auto w-full px-4 py-8 space-y-6">
        <Tabs defaultValue="scrape" className="w-full">
          <TabsList className="grid w-full grid-cols-2">
            <TabsTrigger value="scrape" className="gap-2"><Zap className="h-4 w-4" /> New Scrape</TabsTrigger>
            <TabsTrigger value="topics" className="gap-2"><BookOpen className="h-4 w-4" /> Topics ({topics.length})</TabsTrigger>
          </TabsList>

          <TabsContent value="scrape" className="space-y-6 mt-6">
            {/* Config */}
            <Card className="shadow-lg border-0 bg-white">
              <CardHeader className="pb-4">
                <CardTitle className="flex items-center gap-2 text-lg"><Globe className="h-5 w-5 text-emerald-600" /> Scrape Configuration</CardTitle>
                <CardDescription>Enter a GFG URL and topic name. The system cross-references previously scraped pages to avoid duplicates.</CardDescription>
              </CardHeader>
              <CardContent className="space-y-5">
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                  <div className="space-y-2">
                    <Label className="text-sm font-medium text-gray-700 flex items-center gap-1.5"><Link2 className="h-3.5 w-3.5" /> Target URL</Label>
                    <Input value={url} onChange={e => setUrl(e.target.value)} placeholder="https://www.geeksforgeeks.org/..." disabled={isScraping} className="h-11 text-sm" />
                  </div>
                  <div className="space-y-2">
                    <Label className="text-sm font-medium text-gray-700 flex items-center gap-1.5"><BookOpen className="h-3.5 w-3.5" /> Topic Name</Label>
                    <Input value={topic} onChange={e => setTopic(e.target.value)} placeholder="e.g. NLP, Data Mining, ML" disabled={isScraping} className="h-11 text-sm" />
                  </div>
                </div>

                <div className="flex gap-2">
                  <Button onClick={handleScrape} disabled={isScraping || (!isConnected && !useApi) || !url.trim() || !topic.trim()} className="h-11 px-6 bg-gradient-to-r from-emerald-600 to-teal-600 hover:from-emerald-700 hover:to-teal-700 text-white shadow-lg shadow-emerald-500/20 transition-all">
                    {isScraping ? <><Loader2 className="h-4 w-4 animate-spin mr-2" /> Scraping...</> : <><Play className="h-4 w-4 mr-2" /> Start Scrape</>}
                  </Button>
                  {useApi && (
                    <Badge variant="outline" className="h-11 flex items-center gap-1 text-xs"><RefreshCw className="h-3 w-3" /> Using serverless API (Vercel compatible)</Badge>
                  )}
                </div>

                <div className="flex items-center justify-between p-4 rounded-lg bg-gray-50 border border-gray-100">
                  <div>
                    <Label className="text-sm font-medium text-gray-700 flex items-center gap-1.5"><ArrowRight className="h-3.5 w-3.5" /> Follow Links</Label>
                    <p className="text-xs text-gray-500 mt-1">Recursively scrape all linked GFG pages (no depth or page limit)</p>
                  </div>
                  <div className="flex items-center gap-2">
                    <span className="text-sm text-gray-600">{followLinks ? 'On' : 'Off'}</span>
                    <Switch checked={followLinks} onCheckedChange={setFollowLinks} disabled={isScraping} />
                  </div>
                </div>
              </CardContent>
            </Card>
          </TabsContent>

          <TabsContent value="topics" className="mt-6">
            <Card className="shadow-lg border-0 bg-white">
              <CardHeader className="pb-3">
                <CardTitle className="flex items-center gap-2 text-lg"><BookOpen className="h-5 w-5 text-emerald-600" /> Previously Scraped Topics</CardTitle>
                <CardDescription>Cross-referencing prevents re-scraping pages that appear in multiple topics.</CardDescription>
              </CardHeader>
              <CardContent>
                {topics.length === 0 ? (
                  <p className="text-sm text-gray-500 py-8 text-center">No topics scraped yet. Start your first scrape above.</p>
                ) : (
                  <div className="divide-y">
                    {topics.map(t => (
                      <div key={t.name} className="flex items-center gap-3 py-3">
                        <div className="p-2 rounded-lg bg-emerald-50"><FileText className="h-4 w-4 text-emerald-600" /></div>
                        <div className="flex-1 min-w-0">
                          <p className="font-semibold text-gray-900 text-sm">{t.name}</p>
                          <p className="text-xs text-gray-500 truncate">{t.startUrl}</p>
                        </div>
                        <Badge variant="secondary" className="text-xs">{t.pageCount} pages</Badge>
                        <Badge variant="outline" className="text-[10px]">{new Date(t.updatedAt).toLocaleDateString()}</Badge>
                        {t.fileName && (
                          <Button asChild size="sm" variant="outline" className="h-8">
                            <a href={`/api/download?file=${encodeURIComponent(t.fileName)}`}><Download className="h-3 w-3 mr-1" /> .docx</a>
                          </Button>
                        )}
                      </div>
                    ))}
                  </div>
                )}
              </CardContent>
            </Card>
          </TabsContent>
        </Tabs>

        {/* Stats */}
        {(isScraping || completedFile) && (
          <div className="grid grid-cols-2 sm:grid-cols-5 gap-3">
            {[
              { icon: FileText, label: 'Pages', value: pagesScraped, color: 'sky' },
              { icon: ImageIcon, label: 'Images', value: imagesDownloaded, color: 'violet' },
              { icon: Link2, label: 'Links', value: linksFound, color: 'amber' },
              { icon: BookOpen, label: 'Cross-Refs', value: xrefCount, color: 'orange' },
              { icon: completedFile ? CheckCircle2 : Loader2, label: completedFile ? 'Done' : 'Working', value: '', color: 'emerald', animate: !completedFile },
            ].map((s, i) => (
              <Card key={i} className="border-0 shadow-sm bg-white">
                <CardContent className="p-4 flex items-center gap-3">
                  <div className={`p-2 rounded-lg bg-${s.color}-50`}>
                    <s.icon className={`h-4 w-4 text-${s.color}-600 ${s.animate ? 'animate-spin' : ''}`} />
                  </div>
                  <div>
                    <p className="text-2xl font-bold text-gray-900">{s.value || '\u2014'}</p>
                    <p className="text-xs text-gray-500">{s.label}</p>
                  </div>
                </CardContent>
              </Card>
            ))}
          </div>
        )}

        {/* Progress */}
        {isScraping && (
          <Card className="border-0 shadow-sm bg-white">
            <CardContent className="p-4 space-y-2">
              <div className="flex justify-between text-sm"><span className="font-medium text-gray-700">Progress</span><span className="text-gray-500">{Math.round(computedProgress)}%</span></div>
              <Progress value={computedProgress} className="h-2.5" />
            </CardContent>
          </Card>
        )}

        {/* Download */}
        {completedFile && (
          <Card className="border-2 border-emerald-200 shadow-lg bg-gradient-to-r from-emerald-50 to-teal-50">
            <CardContent className="p-6 flex flex-col sm:flex-row items-center justify-between gap-4">
              <div className="flex items-center gap-3">
                <div className="p-3 rounded-xl bg-emerald-100"><Download className="h-6 w-6 text-emerald-700" /></div>
                <div>
                  <p className="font-semibold text-gray-900">Document Ready!</p>
                  <p className="text-sm text-gray-600 truncate max-w-xs">{completedFile.fileName}</p>
                </div>
              </div>
              <Button asChild className="bg-gradient-to-r from-emerald-600 to-teal-600 hover:from-emerald-700 hover:to-teal-700 text-white shadow-lg shadow-emerald-500/20 px-8 h-11">
                <a href={completedFile.downloadUrl}><Download className="h-4 w-4 mr-2" /> Download Word Document</a>
              </Button>
            </CardContent>
          </Card>
        )}

        {/* Activity Log */}
        {events.length > 0 && (
          <Card className="border-0 shadow-lg bg-white">
            <CardHeader className="pb-3">
              <CardTitle className="text-base flex items-center gap-2"><AlertTriangle className="h-4 w-4 text-amber-500" /> Activity Log <Badge variant="secondary" className="ml-auto text-xs">{events.length}</Badge></CardTitle>
            </CardHeader>
            <CardContent className="p-0">
              <div ref={scrollRef} className="max-h-80 overflow-y-auto">
                <div className="divide-y">
                  {events.map((e, i) => (
                    <div key={i} className={`flex items-start gap-3 px-4 py-2.5 text-sm ${e.type === 'error' ? 'bg-red-50/50' : e.type === 'complete' || e.type === 'topic_done' ? 'bg-emerald-50/50' : e.type === 'xref_found' ? 'bg-orange-50/50' : 'hover:bg-gray-50/50'}`}>
                      {getIcon(e.type)}
                      <div className="flex-1 min-w-0">
                        <p className={e.type === 'error' ? 'text-red-700' : e.type === 'complete' || e.type === 'topic_done' ? 'text-emerald-700 font-medium' : e.type === 'xref_found' ? 'text-orange-700' : 'text-gray-700'}>{e.message}</p>
                        {e.url && <p className="text-xs text-gray-400 truncate mt-0.5">{e.url}</p>}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            </CardContent>
          </Card>
        )}

        {/* How it works */}
        {!isScraping && !completedFile && events.length === 0 && (
          <Card className="border-0 shadow-sm bg-white">
            <CardContent className="p-6">
              <div className="flex items-start gap-4">
                <div className="p-3 rounded-xl bg-emerald-50"><Settings2 className="h-6 w-6 text-emerald-600" /></div>
                <div className="space-y-3">
                  <h3 className="font-semibold text-gray-900">How It Works</h3>
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 text-sm text-gray-600">
                    {[['1', 'Enter URL + Topic name, click Start Scrape'], ['2', 'Content, images, formulas extracted in order'], ['3', 'All images downloaded and inserted at correct positions'], ['4', 'LaTeX formulas converted to Unicode math symbols'], ['5', 'Cross-references tracked: duplicate pages are referenced, not re-scraped'], ['6', 'All hyperlinks followed recursively (no limits)'], ['7', 'Professional Word document generated with faithful content transfer']].map(([n, d]) => (
                      <div key={n} className="flex items-start gap-2"><span className="text-emerald-500 font-bold">{n}.</span><span>{d}</span></div>
                    ))}
                  </div>
                </div>
              </div>
            </CardContent>
          </Card>
        )}
      </main>

      <footer className="border-t bg-white/80 backdrop-blur-sm mt-auto">
        <div className="max-w-5xl mx-auto px-4 py-4 text-center text-xs text-gray-400">
          GFG Scraper — Cross-topic intelligent scraper with formula extraction and image preservation
        </div>
      </footer>
    </div>
  );
}