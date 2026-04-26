"use client";

import { useEffect, useRef, useState, useCallback, useMemo } from "react";
import { v4 as uuidv4 } from "uuid";
import { Book, Chapter, Page, BookSettings } from "@/lib/types";
import {
  getBooks, addBook, deleteBook, renameBook, updateBookSettings,
  addChapter, renameChapter, deleteChapter,
  addPages, updatePage, deletePage, deletePages,
  reorderChapters, reorderPages,
  nextChapterName,
} from "@/lib/storage";
import { compressImage } from "@/lib/compress";
import { getSupabase } from "@/lib/supabase";

type View = "text" | "edit";

export default function Home() {
  const [books, setBooks] = useState<Book[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedBookId, setSelectedBookId] = useState<string | null>(null);
  const [view, setView] = useState<View>("text");

  // Screen 2 state
  const [openChapterIds, setOpenChapterIds] = useState<Set<string>>(new Set());

  // Screen 3 state
  const [editChapterId, setEditChapterId] = useState<string | null>(null);
  const [selectedPageId, setSelectedPageId] = useState<string | null>(null);
  const [editingPageId, setEditingPageId] = useState<string | null>(null);
  const [editingText, setEditingText] = useState("");
  const [savingEdit, setSavingEdit] = useState(false);

  // Upload/processing state
  const [uploading, setUploading] = useState(false);
  const [processingTotal, setProcessingTotal] = useState(0);
  const [processingDone, setProcessingDone] = useState(0);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // New book state
  const [showNewBook, setShowNewBook] = useState(false);
  const [newBookTitle, setNewBookTitle] = useState("");

  // New chapter state
  const [showNewChapter, setShowNewChapter] = useState(false);
  const [newChapterName, setNewChapterName] = useState("");

  // Rename states
  const [renamingBookId, setRenamingBookId] = useState<string | null>(null);
  const [renameBookTitle, setRenameBookTitle] = useState("");
  const [renamingChapterId, setRenamingChapterId] = useState<string | null>(null);
  const [renameChapterName, setRenameChapterName] = useState("");

  // Delete confirmation
  const [deletingBookId, setDeletingBookId] = useState<string | null>(null);
  const [deletingPageIds, setDeletingPageIds] = useState<Set<string>>(new Set());
  const [selectMode, setSelectMode] = useState(false);
  const isDraggingRef = useRef(false);
  const pageListRef = useRef<HTMLDivElement>(null);
  const isMouseDownRef = useRef(false);
  const mouseDownPageIdRef = useRef<string | null>(null);
  const didMouseDragRef = useRef(false);

  // Mobile layout
  const [showSidebar, setShowSidebar] = useState(false);
  const [mobilePanel, setMobilePanel] = useState<"list" | "text">("list");

  // Settings
  const [showSettings, setShowSettings] = useState(false);

  // Reorder modes
  const [sortingPages, setSortingPages] = useState<Page[] | null>(null);
  const [sortingChapters, setSortingChapters] = useState<Chapter[] | null>(null);
  const dragIndexRef = useRef<number | null>(null);
  const carryOverSearchRef = useRef<string | null>(null);

  // Page number inline edit
  const [editingPageNum, setEditingPageNum] = useState(false);
  const [editingPageNumValue, setEditingPageNumValue] = useState("");

  // Search
  const [bookSearch, setBookSearch] = useState("");
  const [bookSearchActive, setBookSearchActive] = useState(false);
  const [chapterSearch, setChapterSearch] = useState("");
  const [chapterSearchActive, setChapterSearchActive] = useState(false);
  const [chapterSearchMatchIdx, setChapterSearchMatchIdx] = useState(0);
  const [bookSearchMatchIdx, setBookSearchMatchIdx] = useState(0);

  const selectedBook = books.find((b) => b.id === selectedBookId) ?? null;
  const editChapter = selectedBook?.chapters.find((c) => c.id === editChapterId) ?? null;
  const selectedPage = editChapter?.pages.find((p) => p.id === selectedPageId) ?? null;

  const reload = useCallback(async () => {
    try {
      const b = await getBooks();
      setBooks(b);
    } catch (e) {
      console.error("getBooks failed:", e);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    reload();
  }, [reload]);

  // Realtime subscription
  useEffect(() => {
    const supabase = getSupabase();
    const channel = supabase
      .channel("db-changes")
      .on("postgres_changes", { event: "*", schema: "public" }, () => reload())
      .subscribe();
    return () => { supabase.removeChannel(channel); };
  }, [reload]);

  // Global mouseup to end mouse drag-select
  useEffect(() => {
    const onMouseUp = () => { isMouseDownRef.current = false; };
    window.addEventListener("mouseup", onMouseUp);
    return () => window.removeEventListener("mouseup", onMouseUp);
  }, []);

  // Non-passive touchmove for drag-select (must prevent scroll during selection)
  useEffect(() => {
    const el = pageListRef.current;
    if (!el) return;
    const onTouchMove = (e: TouchEvent) => {
      if (!selectMode) return;
      isDraggingRef.current = true;
      e.preventDefault();
      const touch = e.touches[0];
      const target = document.elementFromPoint(touch.clientX, touch.clientY);
      const pageEl = target?.closest("[data-page-id]") as HTMLElement | null;
      if (pageEl?.dataset.pageId) {
        setDeletingPageIds((prev) => {
          const next = new Set(prev);
          next.add(pageEl.dataset.pageId!);
          return next;
        });
      }
    };
    el.addEventListener("touchmove", onTouchMove, { passive: false });
    return () => el.removeEventListener("touchmove", onTouchMove);
  }, [selectMode]);

  // Auto-select first page when entering edit view
  useEffect(() => {
    if (view === "edit" && editChapter && editChapter.pages.length > 0 && !selectedPageId) {
      setSelectedPageId(editChapter.pages[0].id);
    }
  }, [view, editChapter, selectedPageId]);

  // Reset chapter search match index when query changes
  useEffect(() => { setChapterSearchMatchIdx(0); }, [chapterSearch]);
  useEffect(() => { setBookSearchMatchIdx(0); }, [bookSearch]);

  // Auto-expand first matching chapter when book search activates
  useEffect(() => {
    if (!bookSearchActive || !bookSearchData || bookSearchData.total === 0 || !selectedBook) return;
    for (const chapter of selectedBook.chapters) {
      if ((bookSearchData.chapterCounts[chapter.id] ?? 0) > 0) {
        setOpenChapterIds((prev) => { const n = new Set(prev); n.add(chapter.id); return n; });
        break;
      }
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bookSearchActive]);

  // Auto-navigate to first matching page when chapter search activates
  useEffect(() => {
    if (!chapterSearchActive || !chapterSearchData || chapterSearchData.totalMatches === 0) return;
    const pm = chapterSearchData.pageMatches.find((m) => m.count > 0);
    if (pm && pm.pageId !== selectedPageId) {
      setSelectedPageId(pm.pageId);
      setMobilePanel("text");
      setEditingPageId(null);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chapterSearchActive]);

  // Reset chapter search when switching chapters (carry over from book search if set)
  useEffect(() => {
    if (carryOverSearchRef.current !== null) {
      setChapterSearch(carryOverSearchRef.current);
      setChapterSearchActive(true);
      setChapterSearchMatchIdx(0);
      carryOverSearchRef.current = null;
    } else {
      setChapterSearchActive(false);
      setChapterSearch("");
      setChapterSearchMatchIdx(0);
    }
  }, [editChapterId]);

  // ===== BOOK ACTIONS =====

  async function handleCreateBook() {
    if (!newBookTitle.trim()) return;
    const book: Omit<Book, "chapters"> = {
      id: uuidv4(),
      title: newBookTitle.trim(),
      createdAt: new Date().toISOString(),
      settings: { chapterNavMode: "buttons" },
    };
    await addBook(book);
    setNewBookTitle("");
    setShowNewBook(false);
    await reload();
    setSelectedBookId(book.id);
  }

  async function handleDeleteBook(id: string) {
    if (deletingBookId !== id) { setDeletingBookId(id); return; }
    setDeletingBookId(null);
    if (selectedBookId === id) { setSelectedBookId(null); setView("text"); }
    await deleteBook(id);
    reload();
  }

  async function handleRenameBook(id: string) {
    if (renameBookTitle.trim()) await renameBook(id, renameBookTitle.trim());
    setRenamingBookId(null);
    reload();
  }

  async function handleUpdateSettings(settings: BookSettings) {
    if (!selectedBookId) return;
    await updateBookSettings(selectedBookId, settings);
    reload();
  }

  // ===== CHAPTER ACTIONS =====

  function openAddChapter() {
    if (!selectedBook) return;
    setNewChapterName(nextChapterName(selectedBook.chapters));
    setShowNewChapter(true);
  }

  async function handleCreateChapter() {
    if (!newChapterName.trim() || !selectedBookId || !selectedBook) return;
    const chapter: Omit<Chapter, "pages"> = {
      id: uuidv4(),
      bookId: selectedBookId,
      name: newChapterName.trim(),
      orderIndex: selectedBook.chapters.length,
    };
    await addChapter(chapter);
    setShowNewChapter(false);
    setNewChapterName("");
    reload();
  }

  async function handleRenameChapter(id: string) {
    if (renameChapterName.trim()) await renameChapter(id, renameChapterName.trim());
    setRenamingChapterId(null);
    reload();
  }

  async function handleDeleteChapter(id: string) {
    await deleteChapter(id);
    if (editChapterId === id) { setEditChapterId(null); setView("text"); }
    reload();
  }

  function openEditView(chapter: Chapter) {
    setEditChapterId(chapter.id);
    setSelectedPageId(chapter.pages[0]?.id ?? null);
    setEditingPageId(null);
    setView("edit");
  }

  // ===== PAGE ACTIONS =====

  function joinPageTexts(pages: Page[]): string {
    const SENT_END     = /[。！？…」』）]$/;
    const CHAPTER_HEAD = /^第[一二三四五六七八九十百千万\d]+[章節部]/;
    const SEPARATOR    = /^[\*\-─━=＝]{2,}$/;

    const combined = pages
      .filter((p) => p.status === "done")
      .map((p) => p.text)
      .join("\n");

    const lines = combined.split("\n").filter((l) => l.trim());
    const out: string[] = [];
    let buffer = "";

    for (let i = 0; i < lines.length; i++) {
      const t = lines[i].trim();
      if (!t) continue;
      buffer = buffer ? buffer + t : t;
      const keep = SENT_END.test(t) || CHAPTER_HEAD.test(t) || SEPARATOR.test(t);
      if (keep || i === lines.length - 1) {
        out.push(buffer);
        buffer = "";
      }
    }
    if (buffer) out.push(buffer);
    return out.join("\n");
  }

  function cleanOcrText(raw: string, isFirstPage = true): string {
    const SENT_END     = /[。！？…」』）]$/;
    const CHAPTER_HEAD = /^第[一二三四五六七八九十百千万\d]+[章節部]/;
    const SEPARATOR    = /^[\*\-─━=＝]{2,}$/;
    const NOBRE_PRE    = /^\d+\s+第[一二三四五六七八九十百千万\d]+[章節部]/;
    const NOBRE_SUF    = /第[一二三四五六七八九十百千万\d]+[章節部].*\d+$/;

    const lines = raw.split("\n").filter((line) => {
      const t = line.trim();
      if (!t) return false;
      if (/^\s*\d+\s*$/.test(t)) return false;
      if (NOBRE_PRE.test(t)) return false;
      if (NOBRE_SUF.test(t)) return false;
      if (!isFirstPage && CHAPTER_HEAD.test(t)) return false;
      return true;
    });

    const out: string[] = [];
    let buffer = "";

    for (let i = 0; i < lines.length; i++) {
      const t = lines[i].trim();
      if (!t) continue;
      buffer = buffer ? buffer + t : t;
      const keep = SENT_END.test(t) || CHAPTER_HEAD.test(t) || SEPARATOR.test(t);
      if (keep || i === lines.length - 1) {
        out.push(buffer);
        buffer = "";
      }
    }
    if (buffer) out.push(buffer);
    return out.join("\n").trim();
  }

  async function handleUploadPhotos(files: FileList) {
    if (!editChapterId || !selectedBookId) return;
    const arr = Array.from(files).sort((a, b) => a.lastModified - b.lastModified);
    setProcessingTotal(arr.length);
    setProcessingDone(0);
    setUploading(true);

    const chapter = selectedBook?.chapters.find((c) => c.id === editChapterId);
    const allPagesInBook = selectedBook?.chapters.flatMap((c) => c.pages) ?? [];
    const maxBookPageNum = allPagesInBook.length > 0 ? Math.max(...allPagesInBook.map((p) => p.pageNumber)) : 0;
    const startNum = chapter && chapter.pages.length > 0
      ? Math.max(...chapter.pages.map((p) => p.pageNumber)) + 1
      : maxBookPageNum + 1;

    const newPages: Page[] = arr.map((_, i) => ({
      id: uuidv4(),
      chapterId: editChapterId,
      pageNumber: startNum + i,
      text: "",
      processedAt: "",
      status: "pending" as const,
    }));

    await addPages(selectedBookId, editChapterId, newPages);
    await reload();

    for (let i = 0; i < arr.length; i++) {
      const page = newPages[i];
      try {
        await updatePage({ ...page, status: "processing" });
        const base64 = await compressImage(arr[i]);
        const res = await fetch("/api/ocr", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ imageBase64: base64 }),
          signal: AbortSignal.timeout(30000),
        });
        const data = await res.json();
        if (data.text !== undefined) {
          const isFirstPage = (chapter?.pages.length ?? 0) === 0 && i === 0;
          await updatePage({ ...page, text: cleanOcrText(data.text, isFirstPage), status: "done", processedAt: new Date().toISOString() });
        } else {
          await updatePage({ ...page, status: "error" });
        }
      } catch {
        await updatePage({ ...page, status: "error" });
      }
      setProcessingDone(i + 1);
    }

    setUploading(false);
    setProcessingTotal(0);
    setProcessingDone(0);
  }

  async function handleRetryPage(page: Page) {
    if (!selectedBookId) return;
    await updatePage({ ...page, status: "error" });
    reload();
  }

  async function handleDeletePage(id: string) {
    await deletePage(id);
    if (selectedPageId === id) setSelectedPageId(null);
    reload();
  }

  async function handleBulkDelete() {
    if (deletingPageIds.size === 0) return;
    await deletePages(Array.from(deletingPageIds));
    setDeletingPageIds(new Set());
    setSelectMode(false);
    setSelectedPageId(null);
    reload();
  }

  function togglePageSelect(id: string) {
    setDeletingPageIds((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  }

  function exitSelectMode() {
    setSelectMode(false);
    setDeletingPageIds(new Set());
  }

  async function handleSaveEdit() {
    if (!editingPageId || !selectedPage) return;
    setSavingEdit(true);
    await updatePage({ ...selectedPage, text: editingText });
    setSavingEdit(false);
    setEditingPageId(null);
    reload();
  }

  // Chapter navigation
  function navigateChapter(dir: "prev" | "next") {
    if (!selectedBook || !editChapterId) return;
    const idx = selectedBook.chapters.findIndex((c) => c.id === editChapterId);
    const next = dir === "prev" ? idx - 1 : idx + 1;
    if (next < 0 || next >= selectedBook.chapters.length) return;
    const ch = selectedBook.chapters[next];
    setEditChapterId(ch.id);
    setSelectedPageId(ch.pages[0]?.id ?? null);
    setEditingPageId(null);
  }

  function navigatePage(dir: "prev" | "next") {
    if (!editChapter || !selectedPageId) return;
    const idx = editChapter.pages.findIndex((p) => p.id === selectedPageId);
    const next = dir === "prev" ? idx - 1 : idx + 1;
    if (next < 0 || next >= editChapter.pages.length) return;
    setSelectedPageId(editChapter.pages[next].id);
    setEditingPageId(null);
  }

  // ===== REORDER HELPERS =====

  function moveSortItem<T>(list: T[], from: number, to: number): T[] {
    const next = [...list];
    const [item] = next.splice(from, 1);
    next.splice(to, 0, item);
    return next;
  }

  async function handleSavePageOrder() {
    if (!sortingPages || !editChapterId) return;
    const updates = sortingPages.map((p, i) => ({ id: p.id, pageNumber: i + 1 }));
    await reorderPages(updates);
    setSortingPages(null);
    reload();
  }

  async function handleChangePageNumber(newNum: number) {
    if (!selectedPage || !editChapter) return;
    const offset = newNum - selectedPage.pageNumber;
    if (offset === 0) return;
    const updates = editChapter.pages.map((p) => ({ id: p.id, pageNumber: p.pageNumber + offset }));
    await reorderPages(updates);
    reload();
  }

  // ===== SEARCH =====

  const bookSearchData = useMemo(() => {
    if (!bookSearchActive || !bookSearch.trim() || !selectedBook) return null;
    const q = bookSearch.toLowerCase();
    const results: { chapterId: string; chapterName: string; pageId: string; pageNumber: number; snippet: string }[] = [];
    const chapterCounts: Record<string, number> = {};
    for (const chapter of selectedBook.chapters) {
      let total = 0;
      for (const page of chapter.pages) {
        if (page.status !== "done") continue;
        const lower = page.text.toLowerCase();
        let count = 0; let i = lower.indexOf(q);
        while (i !== -1) { count++; i = lower.indexOf(q, i + 1); }
        if (count > 0) {
          total += count;
          const firstIdx = lower.indexOf(q);
          const snippet = page.text.slice(Math.max(0, firstIdx - 12), firstIdx + q.length + 24);
          results.push({ chapterId: chapter.id, chapterName: chapter.name, pageId: page.id, pageNumber: page.pageNumber, snippet });
        }
      }
      chapterCounts[chapter.id] = total;
    }
    const total = Object.values(chapterCounts).reduce((a, b) => a + b, 0);
    return { results, chapterCounts, total };
  }, [bookSearchActive, bookSearch, selectedBook]);

  const chapterSearchData = useMemo(() => {
    if (!chapterSearchActive || !chapterSearch.trim() || !editChapter) return null;
    const q = chapterSearch.toLowerCase();
    let totalMatches = 0;
    const pageMatches: { pageId: string; count: number; startIdx: number }[] = [];
    for (const page of editChapter.pages) {
      if (page.status !== "done") { pageMatches.push({ pageId: page.id, count: 0, startIdx: totalMatches }); continue; }
      const lower = page.text.toLowerCase();
      let count = 0; let i = lower.indexOf(q);
      while (i !== -1) { count++; i = lower.indexOf(q, i + 1); }
      pageMatches.push({ pageId: page.id, count, startIdx: totalMatches });
      totalMatches += count;
    }
    return { totalMatches, pageMatches };
  }, [chapterSearchActive, chapterSearch, editChapter]);

  const chapterGlobalStarts = useMemo(() => {
    if (!bookSearchData || !selectedBook) return {} as Record<string, number>;
    const starts: Record<string, number> = {};
    let cumulative = 0;
    for (const chapter of selectedBook.chapters) {
      starts[chapter.id] = cumulative;
      cumulative += bookSearchData.chapterCounts[chapter.id] ?? 0;
    }
    return starts;
  }, [bookSearchData, selectedBook]);

  function renderHighlighted(text: string, query: string, currentGlobal: number, matchStart: number) {
    if (!query.trim()) return <>{text}</>;
    const q = query.toLowerCase();
    const parts: React.ReactNode[] = [];
    let last = 0; let matchNum = matchStart;
    let i = text.toLowerCase().indexOf(q);
    while (i !== -1) {
      if (i > last) parts.push(text.slice(last, i));
      const isCurrent = matchNum === currentGlobal;
      parts.push(<mark key={i} className={isCurrent ? "bg-orange-400 text-white rounded px-px" : "bg-yellow-200 rounded px-px"}>{text.slice(i, i + query.length)}</mark>);
      last = i + q.length; matchNum++;
      i = text.toLowerCase().indexOf(q, last);
    }
    if (last < text.length) parts.push(text.slice(last));
    return <>{parts}</>;
  }

  function navigateChapterSearch(dir: "prev" | "next") {
    if (!chapterSearchData || chapterSearchData.totalMatches === 0) return;
    const total = chapterSearchData.totalMatches;
    const next = dir === "next"
      ? (chapterSearchMatchIdx + 1) % total
      : (chapterSearchMatchIdx - 1 + total) % total;
    setChapterSearchMatchIdx(next);
    const pm = chapterSearchData.pageMatches.find((p) => next >= p.startIdx && next < p.startIdx + p.count);
    if (pm && pm.pageId !== selectedPageId) {
      setSelectedPageId(pm.pageId);
      setMobilePanel("text");
      setEditingPageId(null);
    }
  }

  function navigateBookSearch(dir: "prev" | "next") {
    if (!bookSearchData || bookSearchData.total === 0 || !selectedBook) return;
    const next = dir === "next"
      ? (bookSearchMatchIdx + 1) % bookSearchData.total
      : (bookSearchMatchIdx - 1 + bookSearchData.total) % bookSearchData.total;
    setBookSearchMatchIdx(next);
    let cumulative = 0;
    for (const chapter of selectedBook.chapters) {
      const count = bookSearchData.chapterCounts[chapter.id] ?? 0;
      if (next < cumulative + count) {
        setOpenChapterIds((prev) => { const n = new Set(prev); n.add(chapter.id); return n; });
        break;
      }
      cumulative += count;
    }
  }

  async function handleSaveChapterOrder() {
    if (!sortingChapters) return;
    const updates = sortingChapters.map((c, i) => ({ id: c.id, orderIndex: i }));
    await reorderChapters(updates);
    setSortingChapters(null);
    reload();
  }

  // ===== RENDER =====

  return (
    <main className="relative flex h-screen bg-gray-50 overflow-hidden" onClick={() => setDeletingBookId(null)}>

      {/* Mobile sidebar overlay */}
      {showSidebar && (
        <div className="fixed inset-0 bg-black/30 z-30 md:hidden" onClick={() => setShowSidebar(false)} />
      )}

      {/* ===== LEFT PANEL: テキスト一覧 / 検索結果 ===== */}
      <aside className={`absolute md:relative inset-y-0 left-0 z-40 md:z-auto h-full w-64 md:w-56 md:min-w-56 bg-white border-r border-gray-200 flex flex-col transition-transform duration-200 ease-in-out ${showSidebar ? "translate-x-0" : "-translate-x-full md:translate-x-0"}`}>
        {bookSearchActive && bookSearch.trim() && selectedBook ? (
          /* ===== SEARCH RESULTS MODE ===== */
          <>
            <div className="p-3 border-b border-gray-200">
              <div className="flex items-center justify-between mb-1.5">
                <p className="text-xs font-semibold text-gray-600 uppercase tracking-wide">検索結果</p>
                <button onClick={() => { setBookSearch(""); setBookSearchActive(false); setBookSearchMatchIdx(0); }} className="text-gray-400 hover:text-gray-600 text-sm leading-none">✕</button>
              </div>
              <div className="flex items-center gap-1">
                <span className="text-xs text-gray-500 flex-1">
                  {bookSearchData && bookSearchData.total > 0
                    ? `${bookSearchMatchIdx + 1}/${bookSearchData.total}件`
                    : "0件"}
                </span>
                <button onClick={() => navigateBookSearch("prev")} disabled={!bookSearchData || bookSearchData.total === 0} className="bg-gray-100 text-gray-600 text-xs rounded-lg px-2 py-1 active:scale-95 transition-transform disabled:opacity-30">↑</button>
                <button onClick={() => navigateBookSearch("next")} disabled={!bookSearchData || bookSearchData.total === 0} className="bg-gray-100 text-gray-600 text-xs rounded-lg px-2 py-1 active:scale-95 transition-transform disabled:opacity-30">↓</button>
              </div>
            </div>
            <div className="flex-1 overflow-y-auto p-1.5">
              {bookSearchData && bookSearchData.results.length > 0 ? (
                selectedBook.chapters.map((chapter) => {
                  const chapterResults = bookSearchData.results.filter((r) => r.chapterId === chapter.id);
                  if (chapterResults.length === 0) return null;
                  const hitCount = bookSearchData.chapterCounts[chapter.id] ?? 0;
                  return (
                    <div key={chapter.id} className="mb-2">
                      <div className="flex items-center justify-between px-2 py-1.5">
                        <p className="text-xs font-bold text-gray-600 truncate">{chapter.name}</p>
                        <span className="text-[10px] font-bold bg-yellow-200 text-yellow-800 rounded-full px-1.5 py-0.5 shrink-0 ml-1">{hitCount}件</span>
                      </div>
                      {chapterResults.map((r) => (
                        <div
                          key={r.pageId}
                          onClick={() => {
                            const ch = selectedBook.chapters.find((c) => c.id === r.chapterId)!;
                            carryOverSearchRef.current = bookSearch;
                            openEditView(ch);
                            setSelectedPageId(r.pageId);
                            setMobilePanel("text");
                            setShowSidebar(false);
                          }}
                          className="px-2 py-2 rounded-xl cursor-pointer hover:bg-blue-50 active:scale-[0.99] mb-0.5"
                        >
                          <p className="text-xs font-semibold text-blue-600 mb-0.5">ページ {r.pageNumber}</p>
                          <p className="text-[11px] text-gray-500 leading-relaxed">
                            ...{renderHighlighted(r.snippet, bookSearch, -1, 0)}...
                          </p>
                        </div>
                      ))}
                    </div>
                  );
                })
              ) : (
                <p className="text-xs text-gray-400 text-center mt-8">「{bookSearch}」に一致するページがありません</p>
              )}
            </div>
          </>
        ) : (
          /* ===== NORMAL BOOK LIST MODE ===== */
          <>
            <div className="p-3 border-b border-gray-200">
              <p className="text-xs font-semibold text-gray-400 uppercase tracking-wide mb-2">テキスト一覧</p>
              <button
                onClick={() => setShowNewBook(true)}
                className="w-full bg-blue-600 text-white text-xs font-semibold rounded-xl py-2 active:scale-95 transition-transform"
              >＋ 新規作成</button>
            </div>

            {showNewBook && (
              <div className="p-2 border-b border-gray-100">
                <input
                  autoFocus
                  value={newBookTitle}
                  onChange={(e) => setNewBookTitle(e.target.value)}
                  onKeyDown={(e) => { if (e.key === "Enter") handleCreateBook(); if (e.key === "Escape") setShowNewBook(false); }}
                  placeholder="タイトルを入力"
                  className="w-full border border-blue-300 rounded-lg px-2 py-1.5 text-xs outline-none mb-1.5"
                />
                <div className="flex gap-1">
                  <button onClick={handleCreateBook} className="flex-1 bg-blue-600 text-white text-xs rounded-lg py-1.5 font-semibold">作成</button>
                  <button onClick={() => setShowNewBook(false)} className="flex-1 bg-gray-100 text-gray-500 text-xs rounded-lg py-1.5">✕</button>
                </div>
              </div>
            )}

            <div className="flex-1 overflow-y-auto p-1.5">
              {loading ? (
                <p className="text-xs text-gray-400 text-center mt-8">読み込み中...</p>
              ) : books.length === 0 ? (
                <p className="text-xs text-gray-400 text-center mt-8">まだテキストがありません</p>
              ) : books.map((book) => (
                <div
                  key={book.id}
                  onClick={(e) => { e.stopPropagation(); setSelectedBookId(book.id); setView("text"); setEditingPageId(null); setShowSidebar(false); }}
                  className={`rounded-xl px-2.5 py-2 mb-1 cursor-pointer group ${selectedBookId === book.id ? "bg-blue-50" : "hover:bg-gray-50"}`}
                >
                  {renamingBookId === book.id ? (
                    <div className="flex gap-1" onClick={(e) => e.stopPropagation()}>
                      <input
                        autoFocus
                        value={renameBookTitle}
                        onChange={(e) => setRenameBookTitle(e.target.value)}
                        onKeyDown={(e) => { if (e.key === "Enter") handleRenameBook(book.id); if (e.key === "Escape") setRenamingBookId(null); }}
                        className="flex-1 border border-blue-300 rounded-lg px-2 py-1 text-xs outline-none"
                      />
                      <button onClick={() => handleRenameBook(book.id)} className="text-blue-600 text-xs px-1">✓</button>
                    </div>
                  ) : (
                    <div className="flex items-center justify-between">
                      <div className="min-w-0 flex-1">
                        <p className={`text-xs font-semibold truncate ${selectedBookId === book.id ? "text-blue-700" : "text-gray-800"}`}>{book.title}</p>
                        <p className="text-[10px] text-gray-400 mt-0.5">
                          {book.chapters.length}章 ・ {book.chapters.reduce((s, c) => s + c.pages.length, 0)}ページ
                        </p>
                      </div>
                      <div className="flex gap-1 opacity-0 group-hover:opacity-100 shrink-0 ml-1" onClick={(e) => e.stopPropagation()}>
                        <button onClick={() => { setRenamingBookId(book.id); setRenameBookTitle(book.title); }} className="text-gray-300 hover:text-blue-400 text-xs">✏️</button>
                        {deletingBookId === book.id ? (
                          <button onClick={() => handleDeleteBook(book.id)} className="text-[10px] bg-red-500 text-white px-1.5 py-0.5 rounded-full">確認</button>
                        ) : (
                          <button onClick={(e) => { e.stopPropagation(); handleDeleteBook(book.id); }} className="text-gray-300 hover:text-red-400 text-xs">🗑️</button>
                        )}
                      </div>
                    </div>
                  )}
                </div>
              ))}
            </div>
          </>
        )}
      </aside>

      {/* ===== MAIN CONTENT ===== */}
      {!selectedBook ? (
        <div className="flex-1 flex flex-col items-center justify-center text-gray-400">
          <button onClick={() => setShowSidebar(true)} className="md:hidden mb-4 bg-blue-600 text-white text-sm font-semibold rounded-xl px-5 py-2.5 active:scale-95">☰ テキストを選択</button>
          <p className="text-4xl mb-3">📖</p>
          <p className="text-sm hidden md:block">左からテキストを選択してください</p>
        </div>
      ) : view === "text" ? (
        /* ===== SCREEN 2: テキスト表示 ===== */
        <div className="flex-1 flex flex-col min-w-0">
          <header className="bg-white border-b border-gray-200 px-4 py-3 flex items-center justify-between">
            <div className="flex items-center gap-2">
              <button onClick={() => setShowSidebar(true)} className="md:hidden bg-gray-100 rounded-lg px-2.5 py-1.5 text-sm text-gray-600 active:scale-95">☰</button>
              <h1 className="text-base font-bold text-gray-800 truncate">{selectedBook.title}</h1>
            </div>
            <div className="flex items-center gap-2">
              {sortingChapters !== null ? (
                <>
                  <button onClick={handleSaveChapterOrder} className="text-sm bg-green-600 text-white rounded-lg px-3 py-1.5 font-semibold active:scale-95 transition-transform">✓ 完了</button>
                  <button onClick={() => setSortingChapters(null)} className="text-sm bg-gray-100 text-gray-600 rounded-lg px-2.5 py-1.5 active:scale-95 transition-transform">✕</button>
                </>
              ) : (
                <>
                  <form onSubmit={(e) => { e.preventDefault(); if (!bookSearch.trim()) return; if (bookSearchActive) navigateBookSearch("next"); else setBookSearchActive(true); }} className="flex items-center gap-1">
                    <input
                      value={bookSearch}
                      onChange={(e) => setBookSearch(e.target.value)}
                      onKeyDown={(e) => { if (e.key === "Escape") { setBookSearch(""); setBookSearchActive(false); } }}
                      placeholder="全文検索..."
                      className="text-xs border border-gray-200 rounded-lg px-2 py-1.5 w-24 outline-none focus:border-blue-300"
                    />
                    <button type="submit" className="bg-gray-800 text-white text-xs rounded-lg px-2 py-1.5 shrink-0 active:scale-95">🔍</button>
                    {bookSearchActive && (
                      <button type="button" onClick={() => { setBookSearch(""); setBookSearchActive(false); }} className="text-gray-400 hover:text-gray-600 text-sm leading-none px-0.5">✕</button>
                    )}
                  </form>
                  <button onClick={() => setSortingChapters([...selectedBook.chapters])} disabled={selectedBook.chapters.length < 2} className="text-sm bg-gray-100 rounded-lg px-2.5 py-1.5 text-gray-600 active:scale-95 transition-transform disabled:opacity-30">⇅</button>
                  <button onClick={() => setShowSettings(true)} className="text-sm bg-gray-100 rounded-lg px-3 py-1.5 text-gray-600 active:scale-95 transition-transform shrink-0">⚙️ 設定</button>
                </>
              )}
            </div>
          </header>

          <div className="flex-1 overflow-y-auto p-5">
            {sortingChapters !== null ? (
              <>
                <p className="text-xs text-amber-700 bg-amber-50 rounded-xl px-3 py-2 mb-3">⇅ ≡ をドラッグ、または ↑↓ で章の順序を変更。「完了」で保存。</p>
                {sortingChapters.map((chapter, index) => (
                  <div
                    key={chapter.id}
                    draggable
                    onDragStart={() => { dragIndexRef.current = index; }}
                    onDragOver={(e) => e.preventDefault()}
                    onDrop={() => {
                      if (dragIndexRef.current === null || dragIndexRef.current === index) { dragIndexRef.current = null; return; }
                      setSortingChapters(moveSortItem(sortingChapters, dragIndexRef.current, index));
                      dragIndexRef.current = null;
                    }}
                    className="bg-white rounded-2xl shadow-sm mb-2 flex items-center gap-3 px-4 py-3.5 cursor-grab active:cursor-grabbing border border-gray-100"
                  >
                    <span className="text-gray-300 text-xl select-none">⠿</span>
                    <div className="flex-1 min-w-0">
                      <p className="font-bold text-sm text-gray-800">{chapter.name}</p>
                      <p className="text-xs text-gray-400 mt-0.5">{chapter.pages.length}ページ</p>
                    </div>
                    <div className="flex flex-col">
                      <button onClick={() => { if (index > 0) setSortingChapters(moveSortItem(sortingChapters, index, index - 1)); }} disabled={index === 0} className="text-xs text-gray-400 hover:text-gray-700 disabled:opacity-20 leading-none py-0.5 px-1">↑</button>
                      <button onClick={() => { if (index < sortingChapters.length - 1) setSortingChapters(moveSortItem(sortingChapters, index, index + 1)); }} disabled={index === sortingChapters.length - 1} className="text-xs text-gray-400 hover:text-gray-700 disabled:opacity-20 leading-none py-0.5 px-1">↓</button>
                    </div>
                  </div>
                ))}
              </>
            ) : (
            <>
            <p className="text-xs text-gray-400 mb-4">章をタップすると展開・テキストが表示されます</p>

            {selectedBook.chapters.map((chapter) => {
              const isOpen = openChapterIds.has(chapter.id);
              const allDone = chapter.pages.length > 0 && chapter.pages.every((p) => p.status === "done");
              const processing = chapter.pages.filter((p) => p.status === "processing").length;
              const errors = chapter.pages.filter((p) => p.status === "error").length;
              const chapterHits = bookSearchActive && bookSearchData ? (bookSearchData.chapterCounts[chapter.id] ?? 0) : 0;

              return (
                <div key={chapter.id} className="bg-white rounded-2xl shadow-sm mb-3 overflow-hidden group">
                  {/* Chapter header */}
                  <div
                    className={`w-full px-4 py-3.5 flex items-center justify-between text-left transition-colors cursor-pointer active:scale-[0.99] ${isOpen ? "bg-yellow-100" : "bg-pink-50 hover:bg-pink-100"}`}
                    onClick={() => setOpenChapterIds((prev) => { const n = new Set(prev); n.has(chapter.id) ? n.delete(chapter.id) : n.add(chapter.id); return n; })}
                  >
                    <div>
                      {renamingChapterId === chapter.id ? (
                        <div className="flex gap-1" onClick={(e) => e.stopPropagation()}>
                          <input
                            autoFocus
                            value={renameChapterName}
                            onChange={(e) => setRenameChapterName(e.target.value)}
                            onKeyDown={(e) => { if (e.key === "Enter") handleRenameChapter(chapter.id); if (e.key === "Escape") setRenamingChapterId(null); }}
                            className="border border-blue-300 rounded-lg px-2 py-0.5 text-sm outline-none"
                          />
                          <button onClick={() => handleRenameChapter(chapter.id)} className="text-blue-600 text-sm px-1">✓</button>
                          <button onClick={() => setRenamingChapterId(null)} className="text-gray-400 text-sm px-1">✕</button>
                        </div>
                      ) : (
                        <>
                          <p className="font-bold text-sm text-gray-800">{chapter.name}</p>
                          <p className="text-xs text-gray-500 mt-0.5">
                            {chapter.pages.length === 0 ? "まだページなし" : `${chapter.pages.length}ページ`}
                            {allDone && " ✓"}
                            {processing > 0 && <span className="text-blue-500"> ⟳ 処理中{processing}枚</span>}
                            {errors > 0 && <span className="text-red-400"> ✕ エラー{errors}件</span>}
                          </p>
                        </>
                      )}
                    </div>
                    <div className="flex items-center gap-2 ml-2">
                      {chapterHits > 0 && (
                        <span className="text-[10px] font-bold bg-yellow-200 text-yellow-800 rounded-full px-1.5 py-0.5">{chapterHits}件</span>
                      )}
                      <button
                        onClick={(e) => { e.stopPropagation(); setRenamingChapterId(chapter.id); setRenameChapterName(chapter.name); }}
                        className="text-gray-300 hover:text-blue-400 text-xs opacity-0 group-hover:opacity-100"
                      >✏️</button>
                      {isOpen && (
                        <button
                          onClick={(e) => { e.stopPropagation(); navigator.clipboard.writeText(joinPageTexts(chapter.pages)); }}
                          className="text-xs text-gray-400 hover:text-blue-500 px-1.5 py-1 bg-gray-50 rounded-lg"
                          title="テキストをコピー"
                        >📋</button>
                      )}
                      <span className={isOpen ? "text-yellow-700" : "text-pink-700"}>{isOpen ? "▲" : "▼"}</span>
                    </div>
                  </div>

                  {/* Chapter body */}
                  {isOpen && (
                    <div className="px-4 py-3 border-t border-gray-100">
                      {chapter.pages.length === 0 ? (
                        <div className="text-center py-4">
                          <p className="text-xs text-gray-400 mb-3">まだページがありません</p>
                          <button
                            onClick={() => openEditView(chapter)}
                            className="bg-blue-600 text-white text-sm font-semibold rounded-xl px-5 py-2 active:scale-95 transition-transform"
                          >📷 ページを追加</button>
                        </div>
                      ) : (
                        <>
                          <button
                            onClick={() => openEditView(chapter)}
                            className="w-full mb-3 bg-blue-50 text-blue-600 border border-blue-200 rounded-xl py-2.5 text-sm font-medium active:scale-95 transition-transform"
                          >編集する場合はこちらのボタンをタップしてください</button>
                          <p className="text-sm text-gray-700 leading-relaxed whitespace-pre-wrap break-all">
                            {bookSearchActive && bookSearch.trim()
                              ? renderHighlighted(joinPageTexts(chapter.pages), bookSearch, bookSearchMatchIdx, chapterGlobalStarts[chapter.id] ?? 0)
                              : joinPageTexts(chapter.pages)}
                          </p>
                        </>
                      )}
                    </div>
                  )}
                </div>
              );
            })}

            {/* Add chapter button */}
            {!showNewChapter ? (
              <button
                onClick={openAddChapter}
                className="w-full border-2 border-dashed border-gray-200 rounded-2xl py-3 text-sm text-gray-400 hover:border-blue-300 hover:text-blue-400 transition-colors mt-1"
              >＋ 章を追加</button>
            ) : (
              <div className="bg-white rounded-2xl border-2 border-blue-400 p-3 mt-1">
                <p className="text-xs text-gray-500 mb-1.5">
                  章の名前 <span className="text-blue-500 font-medium">（自動入力: {newChapterName}）</span>
                </p>
                <div className="flex gap-2">
                  <input
                    autoFocus
                    value={newChapterName}
                    onChange={(e) => setNewChapterName(e.target.value)}
                    onKeyDown={(e) => { if (e.key === "Enter") handleCreateChapter(); if (e.key === "Escape") setShowNewChapter(false); }}
                    className="flex-1 border border-blue-300 rounded-xl px-3 py-1.5 text-sm outline-none"
                  />
                  <button onClick={handleCreateChapter} className="bg-blue-600 text-white text-sm rounded-xl px-3 font-semibold active:scale-95 transition-transform">追加</button>
                  <button onClick={() => setShowNewChapter(false)} className="bg-gray-100 text-gray-500 text-sm rounded-xl px-2">✕</button>
                </div>
                <p className="text-xs text-gray-400 mt-1.5">💡 「あとがき」など数字なしの名前も自由に入力できます</p>
              </div>
            )}
            </>
            )}
          </div>
        </div>
      ) : (
        /* ===== SCREEN 3: 編集画面 ===== */
        <div className="flex-1 flex min-w-0">

          {/* Left sub: page list */}
          <div className={`${mobilePanel === "text" ? "hidden md:flex" : "flex"} w-full md:w-64 md:min-w-64 bg-white border-r border-gray-200 flex-col`}>
            <div className="p-3 border-b border-gray-200">
              <div className="flex items-center gap-2 mb-1">
                <button onClick={() => { setView("text"); setMobilePanel("list"); setEditingPageId(null); }} className="md:hidden bg-gray-100 text-gray-600 text-xs rounded-lg px-2.5 py-1 active:scale-95 shrink-0">← 戻る</button>
                <div className="min-w-0">
                  <p className="text-[10px] text-gray-400 truncate">{selectedBook.title}</p>
                  <p className="font-bold text-sm text-gray-800">{editChapter?.name}</p>
                </div>
              </div>

              {/* Upload progress */}
              {uploading && (
                <div className="bg-blue-50 border border-blue-200 rounded-xl px-3 py-2 mb-2">
                  <div className="flex items-center justify-between mb-1">
                    <span className="text-xs text-blue-600 font-medium">⟳ 処理中 {processingDone} / {processingTotal} 枚</span>
                  </div>
                  <div className="bg-blue-100 rounded-full h-1.5">
                    <div
                      className="bg-blue-600 h-1.5 rounded-full transition-all"
                      style={{ width: `${processingTotal > 0 ? (processingDone / processingTotal) * 100 : 0}%` }}
                    />
                  </div>
                </div>
              )}

              {sortingPages !== null ? (
                <div className="flex gap-2">
                  <button onClick={handleSavePageOrder} className="flex-1 bg-green-600 text-white text-xs font-semibold rounded-xl py-2 active:scale-95 transition-transform">✓ 完了</button>
                  <button onClick={() => setSortingPages(null)} className="bg-gray-100 text-gray-600 text-xs font-semibold rounded-xl px-3 py-2 active:scale-95 transition-transform">✕</button>
                </div>
              ) : selectMode ? (
                <div className="flex gap-2">
                  <button
                    onClick={handleBulkDelete}
                    disabled={deletingPageIds.size === 0}
                    className="flex-1 bg-red-500 text-white text-xs font-semibold rounded-xl py-2 active:scale-95 transition-transform disabled:opacity-30"
                  >🗑 削除{deletingPageIds.size > 0 ? `（${deletingPageIds.size}件）` : ""}</button>
                  <button
                    onClick={exitSelectMode}
                    className="bg-gray-100 text-gray-600 text-xs font-semibold rounded-xl px-3 py-2 active:scale-95 transition-transform"
                  >✕</button>
                </div>
              ) : chapterSearchActive ? (
                <div className="space-y-1.5">
                  <div className="flex items-center gap-1 text-xs">
                    <span className="font-semibold text-gray-700 truncate flex-1">{chapterSearch}</span>
                    <span className="text-gray-400 shrink-0">
                      {chapterSearchData && chapterSearchData.totalMatches > 0
                        ? `${chapterSearchMatchIdx + 1}/${chapterSearchData.totalMatches}件`
                        : "0件"}
                    </span>
                  </div>
                  <div className="flex gap-1">
                    <button onClick={() => navigateChapterSearch("prev")} disabled={!chapterSearchData || chapterSearchData.totalMatches === 0} className="flex-1 bg-gray-100 text-gray-600 text-xs font-semibold rounded-xl py-1.5 active:scale-95 transition-transform disabled:opacity-30">↑</button>
                    <button onClick={() => navigateChapterSearch("next")} disabled={!chapterSearchData || chapterSearchData.totalMatches === 0} className="flex-1 bg-gray-100 text-gray-600 text-xs font-semibold rounded-xl py-1.5 active:scale-95 transition-transform disabled:opacity-30">↓</button>
                    <button onClick={() => { setChapterSearch(""); setChapterSearchActive(false); setChapterSearchMatchIdx(0); }} className="bg-gray-100 text-gray-600 text-xs font-semibold rounded-xl px-3 py-1.5 active:scale-95 transition-transform">✕</button>
                  </div>
                </div>
              ) : (
                <>
                  <div className="flex gap-2 mb-2">
                    <button
                      onClick={() => fileInputRef.current?.click()}
                      disabled={uploading}
                      className="flex-1 bg-blue-600 text-white text-xs font-semibold rounded-xl py-2 active:scale-95 transition-transform disabled:opacity-50"
                    >📷 写真を挿入</button>
                    <button
                      onClick={() => setSortingPages([...(editChapter?.pages ?? [])])}
                      disabled={uploading || (editChapter?.pages.length ?? 0) === 0}
                      className="bg-gray-100 text-gray-600 text-xs font-semibold rounded-xl px-3 active:scale-95 transition-transform disabled:opacity-30"
                      title="ページを並び替え"
                    >⇅</button>
                  </div>
                  <button
                    onClick={() => setSelectMode(true)}
                    disabled={uploading || (editChapter?.pages.length ?? 0) === 0}
                    className="w-full bg-gray-100 text-gray-600 text-xs font-semibold rounded-xl py-2 active:scale-95 transition-transform disabled:opacity-30"
                  >選択</button>
                </>
              )}
              <input
                ref={fileInputRef}
                type="file"
                accept="image/*"
                multiple
                className="hidden"
                onChange={(e) => e.target.files && handleUploadPhotos(e.target.files)}
              />
            </div>

            {/* Page list */}
            <div
              ref={pageListRef}
              className="flex-1 overflow-y-auto p-1.5"
              onTouchStart={() => { isDraggingRef.current = false; }}
            >
              {sortingPages !== null ? (
                sortingPages.map((page, index) => (
                  <div
                    key={page.id}
                    draggable
                    onDragStart={() => { dragIndexRef.current = index; }}
                    onDragOver={(e) => e.preventDefault()}
                    onDrop={() => {
                      if (dragIndexRef.current === null || dragIndexRef.current === index) { dragIndexRef.current = null; return; }
                      setSortingPages(moveSortItem(sortingPages, dragIndexRef.current, index));
                      dragIndexRef.current = null;
                    }}
                    className="flex items-center gap-2 px-2 py-2.5 rounded-xl mb-0.5 bg-white border border-gray-200 cursor-grab active:cursor-grabbing select-none"
                  >
                    <span className="text-gray-300 text-xl">⠿</span>
                    <div className="w-9 h-9 bg-gray-100 rounded-lg shrink-0 flex items-center justify-center text-sm text-gray-400">🖼</div>
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-semibold text-gray-700">ページ {index + 1}</p>
                      <p className={`text-xs ${page.status === "done" ? "text-green-600" : "text-gray-400"}`}>
                        {page.status === "done" ? `✓ ${page.text.length}文字` : page.status === "error" ? "✕ エラー" : "—"}
                      </p>
                    </div>
                    <div className="flex flex-col">
                      <button onClick={() => { if (index > 0) setSortingPages(moveSortItem(sortingPages, index, index - 1)); }} disabled={index === 0} className="text-xs text-gray-400 hover:text-gray-700 disabled:opacity-20 leading-none py-0.5 px-1">↑</button>
                      <button onClick={() => { if (index < sortingPages.length - 1) setSortingPages(moveSortItem(sortingPages, index, index + 1)); }} disabled={index === sortingPages.length - 1} className="text-xs text-gray-400 hover:text-gray-700 disabled:opacity-20 leading-none py-0.5 px-1">↓</button>
                    </div>
                  </div>
                ))
              ) : (
                editChapter?.pages.map((page) => {
                  const pm = chapterSearchActive && chapterSearchData
                    ? chapterSearchData.pageMatches.find((m) => m.pageId === page.id)
                    : null;
                  const hasHit = pm && pm.count > 0;
                  const isCurrentMatch = hasHit && chapterSearchMatchIdx >= pm!.startIdx && chapterSearchMatchIdx < pm!.startIdx + pm!.count;
                  return (
                  <div
                    key={page.id}
                    data-page-id={page.id}
                    onMouseDown={() => {
                      if (!selectMode) return;
                      isMouseDownRef.current = true;
                      mouseDownPageIdRef.current = page.id;
                      didMouseDragRef.current = false;
                    }}
                    onMouseEnter={() => {
                      if (!selectMode || !isMouseDownRef.current) return;
                      if (!didMouseDragRef.current && mouseDownPageIdRef.current) {
                        setDeletingPageIds((prev) => { const n = new Set(prev); n.add(mouseDownPageIdRef.current!); return n; });
                        didMouseDragRef.current = true;
                      }
                      setDeletingPageIds((prev) => { const n = new Set(prev); n.add(page.id); return n; });
                    }}
                    onClick={() => {
                      if (selectMode) {
                        if (!didMouseDragRef.current && !isDraggingRef.current) {
                          togglePageSelect(page.id);
                        }
                        didMouseDragRef.current = false;
                        isDraggingRef.current = false;
                        mouseDownPageIdRef.current = null;
                        return;
                      }
                      setSelectedPageId(page.id);
                      setMobilePanel("text");
                      setEditingPageId(null);
                    }}
                    className={`flex items-center gap-2 px-2 py-2.5 rounded-xl cursor-pointer mb-0.5 select-none ${
                      selectMode && deletingPageIds.has(page.id) ? "bg-red-50" :
                      isCurrentMatch ? "bg-orange-100" :
                      hasHit ? "bg-yellow-50" :
                      !selectMode && selectedPageId === page.id ? "bg-blue-50" : "hover:bg-gray-50"
                    }`}
                  >
                    {selectMode && (
                      <div className={`w-6 h-6 rounded-full border-2 shrink-0 flex items-center justify-center ${deletingPageIds.has(page.id) ? "bg-red-500 border-red-500" : "border-gray-300"}`}>
                        {deletingPageIds.has(page.id) && <span className="text-white text-xs font-bold">✓</span>}
                      </div>
                    )}
                    <div className="w-9 h-9 bg-gray-100 rounded-lg shrink-0 flex items-center justify-center text-sm text-gray-400">🖼</div>
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-semibold text-gray-700">ページ {page.pageNumber}</p>
                      <p className={`text-xs ${page.status === "done" ? "text-green-600" : page.status === "processing" ? "text-blue-500" : page.status === "error" ? "text-red-400" : "text-gray-400"}`}>
                        {page.status === "done" ? `✓ ${page.text.length}文字` : page.status === "processing" ? "⟳ 処理中" : page.status === "error" ? "✕ エラー" : "⏳ 待機中"}
                      </p>
                    </div>
                    {hasHit && (
                      <span className="text-[10px] font-bold bg-yellow-200 text-yellow-800 rounded-full px-1.5 py-0.5 shrink-0">{pm!.count}</span>
                    )}
                    {!selectMode && page.status === "error" && (
                      <button
                        onClick={(e) => { e.stopPropagation(); handleRetryPage(page); }}
                        className="text-xs bg-red-50 text-red-400 border border-red-200 rounded-lg px-2 py-1 shrink-0"
                      >🔄</button>
                    )}
                  </div>
                  );
                })
              )}
            </div>

            {/* Chapter navigation */}
            {selectedBook.settings.chapterNavMode === "buttons" ? (
              <div className="p-2 border-t border-gray-100 flex gap-2">
                <button
                  onClick={() => navigateChapter("prev")}
                  disabled={!selectedBook || selectedBook.chapters.findIndex((c) => c.id === editChapterId) === 0}
                  className="flex-1 bg-gray-100 text-gray-600 text-xs rounded-xl py-2 font-medium active:scale-95 transition-transform disabled:opacity-30"
                >← 前の章</button>
                <button
                  onClick={() => navigateChapter("next")}
                  disabled={!selectedBook || selectedBook.chapters.findIndex((c) => c.id === editChapterId) === selectedBook.chapters.length - 1}
                  className="flex-1 bg-gray-100 text-gray-600 text-xs rounded-xl py-2 font-medium active:scale-95 transition-transform disabled:opacity-30"
                >次の章 →</button>
              </div>
            ) : (
              <div className="p-2 border-t border-gray-100">
                <select
                  value={editChapterId ?? ""}
                  onChange={(e) => {
                    const ch = selectedBook.chapters.find((c) => c.id === e.target.value);
                    if (ch) { setEditChapterId(ch.id); setSelectedPageId(ch.pages[0]?.id ?? null); setEditingPageId(null); }
                  }}
                  className="w-full border border-gray-200 rounded-xl px-3 py-2 text-xs text-gray-700 outline-none"
                >
                  {selectedBook.chapters.map((c) => (
                    <option key={c.id} value={c.id}>{c.name}（{c.pages.length}ページ）</option>
                  ))}
                </select>
              </div>
            )}
          </div>

          {/* Right sub: page text */}
          <div className={`${mobilePanel === "list" ? "hidden md:flex" : "flex"} flex-1 flex-col bg-gray-50 min-w-0`}>
            <header className="bg-white border-b border-gray-200 px-3 py-2.5 flex items-center justify-between">
              <div className="flex items-center gap-1.5">
                <button onClick={() => setMobilePanel("list")} className="md:hidden bg-gray-100 rounded-lg px-2.5 py-1 text-sm text-gray-600 active:scale-95 shrink-0">←</button>
                <button onClick={() => navigatePage("prev")} disabled={!selectedPageId || editChapter?.pages[0]?.id === selectedPageId} className="bg-gray-100 rounded-lg px-2.5 py-1 text-sm disabled:opacity-30 active:scale-95 transition-transform">←</button>
                {editingPageNum && selectedPage ? (
                  <input
                    autoFocus
                    type="number"
                    value={editingPageNumValue}
                    onChange={(e) => setEditingPageNumValue(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") { const n = parseInt(editingPageNumValue); if (!isNaN(n) && n > 0) handleChangePageNumber(n); setEditingPageNum(false); }
                      if (e.key === "Escape") setEditingPageNum(false);
                    }}
                    onBlur={() => { const n = parseInt(editingPageNumValue); if (!isNaN(n) && n > 0) handleChangePageNumber(n); setEditingPageNum(false); }}
                    className="w-14 text-center border border-blue-300 rounded-lg px-1 py-0.5 text-sm font-semibold outline-none"
                  />
                ) : (
                  <span
                    onClick={() => { if (selectedPage) { setEditingPageNumValue(String(selectedPage.pageNumber)); setEditingPageNum(true); } }}
                    className="text-sm font-semibold text-gray-700 whitespace-nowrap cursor-pointer hover:text-blue-600"
                    title="タップしてページ番号を変更"
                  >ページ {selectedPage?.pageNumber ?? "—"}</span>
                )}
                <button onClick={() => navigatePage("next")} disabled={!selectedPageId || editChapter?.pages.at(-1)?.id === selectedPageId} className="bg-gray-100 rounded-lg px-2.5 py-1 text-sm disabled:opacity-30 active:scale-95 transition-transform">→</button>
                <form onSubmit={(e) => { e.preventDefault(); if (!chapterSearch.trim()) return; if (chapterSearchActive) navigateChapterSearch("next"); else { setChapterSearchActive(true); setChapterSearchMatchIdx(0); } }} className="flex items-center gap-1 ml-1">
                  <input
                    value={chapterSearch}
                    onChange={(e) => setChapterSearch(e.target.value)}
                    onKeyDown={(e) => { if (e.key === "Escape") { setChapterSearch(""); setChapterSearchActive(false); setChapterSearchMatchIdx(0); } }}
                    placeholder="章内検索..."
                    className="text-xs border border-gray-200 rounded-lg px-2 py-1 w-20 outline-none focus:border-blue-300"
                  />
                  <button type="submit" className="bg-gray-800 text-white text-xs rounded-lg px-1.5 py-1 shrink-0 active:scale-95">🔍</button>
                  {chapterSearchActive && (
                    <button type="button" onClick={() => { setChapterSearch(""); setChapterSearchActive(false); setChapterSearchMatchIdx(0); }} className="text-gray-400 hover:text-gray-600 text-sm leading-none px-0.5">✕</button>
                  )}
                </form>
              </div>
              <div className="flex items-center gap-1.5">
                <button onClick={() => { setView("text"); setMobilePanel("list"); setEditingPageId(null); }} className="text-xs bg-gray-100 text-gray-600 rounded-lg px-2.5 py-1.5 active:scale-95 transition-transform whitespace-nowrap">← 戻る</button>
                <button onClick={() => setShowSettings(true)} className="text-xs bg-gray-100 text-gray-600 rounded-lg px-2.5 py-1.5 active:scale-95 transition-transform">⚙️</button>
              </div>
            </header>

            <div className="flex-1 overflow-y-auto p-4">
              {!selectedPage ? (
                <div className="text-center text-gray-400 mt-20">
                  <p className="text-sm">左からページを選択してください</p>
                </div>
              ) : (
                <div className="bg-white rounded-2xl p-4 shadow-sm">
                  <div className="flex items-center justify-between mb-3">
                    <p className="text-xs text-gray-400">
                      {selectedBook.title} ＞ {editChapter?.name} ＞ ページ {selectedPage.pageNumber}
                    </p>
                    {selectedPage.status === "done" && (
                      <button
                        onClick={() => navigator.clipboard.writeText(selectedPage.text)}
                        className="text-xs text-gray-400 hover:text-blue-500 px-1.5 py-1 bg-gray-50 rounded-lg shrink-0 ml-2"
                        title="テキストをコピー"
                      >📋</button>
                    )}
                  </div>

                  {editingPageId === selectedPage.id ? (
                    <>
                      <textarea
                        autoFocus
                        value={editingText}
                        onChange={(e) => setEditingText(e.target.value)}
                        className="w-full min-h-48 border-2 border-blue-400 rounded-xl px-3 py-2.5 text-sm text-gray-800 leading-relaxed outline-none resize-y"
                      />
                      <div className="flex gap-2 mt-3">
                        <button
                          onClick={handleSaveEdit}
                          disabled={savingEdit}
                          className="flex-1 bg-blue-600 text-white text-sm font-semibold rounded-xl py-2.5 active:scale-95 transition-transform disabled:opacity-50"
                        >💾 保存</button>
                        <button
                          onClick={() => setEditingPageId(null)}
                          className="flex-1 bg-gray-100 text-gray-600 text-sm rounded-xl py-2.5 active:scale-95 transition-transform"
                        >キャンセル</button>
                      </div>
                    </>
                  ) : (
                    <>
                      <p className="text-sm text-gray-800 leading-relaxed whitespace-pre-wrap break-all">
                        {selectedPage.status === "done"
                          ? (chapterSearchActive && chapterSearch.trim()
                              ? renderHighlighted(
                                  selectedPage.text,
                                  chapterSearch,
                                  chapterSearchMatchIdx,
                                  chapterSearchData?.pageMatches.find((m) => m.pageId === selectedPage.id)?.startIdx ?? 0
                                )
                              : selectedPage.text)
                          : selectedPage.status === "processing" ? "⟳ OCR処理中..."
                          : selectedPage.status === "error" ? "✕ エラーが発生しました"
                          : "⏳ 待機中"}
                      </p>
                      {selectedPage.status === "done" && (
                        <button
                          onClick={() => { setEditingPageId(selectedPage.id); setEditingText(selectedPage.text); }}
                          className="w-full mt-4 bg-blue-50 text-blue-600 border border-blue-200 rounded-xl py-2.5 text-sm font-medium active:scale-95 transition-transform"
                        >✏️ テキストを編集</button>
                      )}
                    </>
                  )}
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {/* ===== SETTINGS PANEL ===== */}
      {showSettings && selectedBook && (
        <div className="fixed inset-0 z-50" onClick={() => setShowSettings(false)}>
          <div
            className="absolute top-0 right-0 w-72 h-full bg-white shadow-2xl p-5 flex flex-col gap-5 overflow-y-auto"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-start justify-between">
              <div>
                <p className="font-bold text-base text-gray-800">⚙️ 設定</p>
                <p className="text-[10px] text-gray-400 mt-0.5">「{selectedBook.title}」のみに適用</p>
              </div>
              <button onClick={() => setShowSettings(false)} className="bg-gray-100 rounded-lg px-2 py-1 text-sm text-gray-500">✕</button>
            </div>

            <div>
              <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-2">章ナビゲーション（編集画面）</p>
              {(["buttons", "dropdown"] as const).map((mode) => (
                <label key={mode} className="flex items-center gap-2.5 px-2 py-2 rounded-xl cursor-pointer hover:bg-gray-50">
                  <input
                    type="radio"
                    name="chapterNavMode"
                    checked={selectedBook.settings.chapterNavMode === mode}
                    onChange={() => handleUpdateSettings({ ...selectedBook.settings, chapterNavMode: mode })}
                    className="accent-blue-600"
                  />
                  <span className="text-sm text-gray-700">
                    {mode === "buttons" ? "← 前の章 / 次の章 → ボタン（通常）" : "ドロップダウンで章を選択"}
                  </span>
                </label>
              ))}
            </div>

            <div>
              <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-2">章の管理</p>
              {selectedBook.chapters.map((ch) => (
                <div key={ch.id} className="flex items-center justify-between px-2 py-1.5 rounded-xl hover:bg-gray-50">
                  <span className="text-sm text-gray-700">{ch.name}</span>
                  <div className="flex gap-1">
                    <button
                      onClick={() => { setRenamingChapterId(ch.id); setRenameChapterName(ch.name); setShowSettings(false); }}
                      className="text-xs text-gray-400 hover:text-blue-500 px-1"
                    >✏️</button>
                    <button
                      onClick={() => handleDeleteChapter(ch.id)}
                      className="text-xs text-gray-400 hover:text-red-500 px-1"
                    >🗑️</button>
                  </div>
                </div>
              ))}
            </div>

            <div>
              <p className="text-xs font-semibold text-gray-400 uppercase tracking-wide mb-2">拡張予定</p>
              <div className="text-xs text-gray-300 border border-dashed border-gray-200 rounded-xl p-3 text-center">フォントサイズ、エクスポートなど</div>
            </div>
          </div>
        </div>
      )}
    </main>
  );
}
