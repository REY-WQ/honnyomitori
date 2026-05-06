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
  uploadPageImage, deletePageImage, pageImageExists,
} from "@/lib/storage";
import { compressImage } from "@/lib/compress";
import { getSupabase } from "@/lib/supabase";

type View = "text" | "edit";

// OCRテキスト処理用の共通正規表現
const RE_SENT_END     = /[。！？…」』）]$/;
const RE_CHAPTER_HEAD = /^第[一二三四五六七八九十百千万\d]+[章節部]/;
const RE_SEPARATOR    = /^[\*\-─━=＝]{2,}$/;
const RE_NOBRE_PRE    = /^\d+\s+第[一二三四五六七八九十百千万\d]+[章節部]/;
const RE_NOBRE_SUF    = /第[一二三四五六七八九十百千万\d]+[章節部].*\d+$/;
const RE_PAGE_NUM     = /^\s*\d+\s*$/;

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
  const retryFileInputRef = useRef<HTMLInputElement>(null);
  const retryPageRef = useRef<Page | null>(null);
  const cancelUploadRef = useRef(false);

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
  const selectModeRef = useRef(false);
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
  const chapterSearchInputRef = useRef<HTMLInputElement>(null);
  const navigateChapterSearchRef = useRef<(dir: "prev" | "next") => void>(() => {});
  const chapterSearchActiveRef = useRef(false);
  const bookSearchInputRef = useRef<HTMLInputElement>(null);
  const navigateBookSearchNextRef = useRef<() => void>(() => {});
  const bookSearchActiveRef = useRef(false);

  // Page number inline edit
  const [editingPageNum, setEditingPageNum] = useState(false);
  const [editingPageNumValue, setEditingPageNumValue] = useState("");

  // Search
  const [bookSearch, setBookSearch] = useState("");
  const [bookSearchDeferred, setBookSearchDeferred] = useState("");
  const [bookSearchActive, setBookSearchActive] = useState(false);
  const [chapterSearch, setChapterSearch] = useState("");
  const [chapterSearchActive, setChapterSearchActive] = useState(false);
  const [chapterSearchMatchIdx, setChapterSearchMatchIdx] = useState(0);
  const [bookSearchMatchIdx, setBookSearchMatchIdx] = useState(0);

  const selectedBook = books.find((b) => b.id === selectedBookId) ?? null;
  const editChapter = selectedBook?.chapters.find((c) => c.id === editChapterId) ?? null;
  const selectedPage = editChapter?.pages.find((p) => p.id === selectedPageId) ?? null;

  // Keep refs up-to-date every render so global handlers never have stale closures
  chapterSearchActiveRef.current = chapterSearchActive;
  bookSearchActiveRef.current = bookSearchActive;
  selectModeRef.current = selectMode;

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

  // Recover stuck "processing" pages on mount
  useEffect(() => {
    async function recoverProcessingPages() {
      const supabase = getSupabase();
      const books = await getBooks();
      const processingPages = books.flatMap((b) =>
        b.chapters.flatMap((c) =>
          c.pages
            .filter((p) => p.status === "processing")
            .map((p) => ({ page: p, book: b, chapter: c }))
        )
      );
      for (const { page, book, chapter } of processingPages) {
        const isFirstPage = chapter.pages[0]?.id === page.id;
        const removeBleedThrough = book.settings.removeBleedThrough !== false;
        supabase.functions.invoke("ocr-process", {
          body: { pageId: page.id, bookId: book.id, isFirstPage, removeBleedThrough },
        }).catch(console.error);
      }
    }
    recoverProcessingPages();
  }, []);

  // Realtime subscription
  useEffect(() => {
    const supabase = getSupabase();
    const channel = supabase
      .channel("db-changes")
      .on("postgres_changes", { event: "*", schema: "public" }, () => reload())
      .subscribe();
    return () => { supabase.removeChannel(channel); };
  }, [reload]);

  // Poll every 5s while any page is processing (Realtime fallback for mobile)
  const hasProcessingPages = books.some((b) =>
    b.chapters.some((c) => c.pages.some((p) => p.status === "processing"))
  );
  useEffect(() => {
    if (!hasProcessingPages) return;
    const id = setInterval(() => reload(), 5000);
    return () => clearInterval(id);
  }, [hasProcessingPages, reload]);

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
      if (!selectModeRef.current) return;
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
  }, []);

  // Auto-select first page when entering edit view
  useEffect(() => {
    if (view === "edit" && editChapter && editChapter.pages.length > 0 && !selectedPageId) {
      setSelectedPageId(editChapter.pages[0].id);
    }
  }, [view, editChapter, selectedPageId]);

  // Reset chapter search match index when query changes
  useEffect(() => { setChapterSearchMatchIdx(0); }, [chapterSearch]);
  useEffect(() => { setBookSearchMatchIdx(0); }, [bookSearch]);

  // Debounce book search query to avoid recomputing on every keystroke
  useEffect(() => {
    const t = setTimeout(() => setBookSearchDeferred(bookSearch), 300);
    return () => clearTimeout(t);
  }, [bookSearch]);

  // Scroll current match into view (setTimeout gives React time to re-render expanded chapter/page first)
  useEffect(() => {
    const timer = setTimeout(() => {
      document.querySelector("[data-search-current='true']")?.scrollIntoView({ behavior: "smooth", block: "center" });
    }, 80);
    return () => clearTimeout(timer);
  }, [bookSearchMatchIdx, chapterSearchMatchIdx, bookSearchActive, chapterSearchActive]);

  // Global Enter key → navigate chapter search
  // Uses refs so this handler never goes stale — registered once per Screen 3 visit
  useEffect(() => {
    if (view !== "edit") return;
    const handler = (e: KeyboardEvent) => {
      if (e.key !== "Enter") return;
      if (!chapterSearchActiveRef.current) return;
      const tag = (e.target as HTMLElement).tagName;
      if (tag === "TEXTAREA" || tag === "INPUT" || tag === "SELECT") return;
      e.preventDefault();
      navigateChapterSearchRef.current("next");
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [view]);

  // Global Enter key → navigate book search (Screen 2)
  useEffect(() => {
    if (view !== "text") return;
    const handler = (e: KeyboardEvent) => {
      if (e.key !== "Enter") return;
      if (!bookSearchActiveRef.current) return;
      if ((e.target as HTMLElement).tagName === "INPUT") return;
      if ((e.target as HTMLElement).tagName === "TEXTAREA") return;
      e.preventDefault();
      navigateBookSearchNextRef.current();
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [view]);

  // Re-focus book search input when returning to Screen 2 with active search
  useEffect(() => {
    if (view !== "text" || !bookSearchActive) return;
    setTimeout(() => { bookSearchInputRef.current?.focus(); }, 150);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view]);

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

  // Auto-navigate to first matching page when chapter search activates; focus input so Enter works
  useEffect(() => {
    if (!chapterSearchActive || !chapterSearchData || chapterSearchData.totalMatches === 0) return;
    const pm = chapterSearchData.pageMatches.find((m) => m.count > 0);
    if (pm && pm.pageId !== selectedPageId) {
      setSelectedPageId(pm.pageId);
      setMobilePanel("text");
      setEditingPageId(null);
    }
    setTimeout(() => { chapterSearchInputRef.current?.focus(); }, 200);
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

  useEffect(() => {
    setBleedResultState(null);
  }, [editChapterId]);

  // ===== BOOK ACTIONS =====

  async function handleCreateBook() {
    if (!newBookTitle.trim()) return;
    const book: Omit<Book, "chapters"> = {
      id: uuidv4(),
      title: newBookTitle.trim(),
      createdAt: new Date().toISOString(),
      settings: { chapterNavMode: "buttons", removeBleedThrough: true, removeBleedThroughBetweenPages: false, doubleClickUndo: "popup" },
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
      const keep = RE_SENT_END.test(t) || RE_CHAPTER_HEAD.test(t) || RE_SEPARATOR.test(t);
      if (keep || i === lines.length - 1) {
        out.push(buffer);
        buffer = "";
      }
    }
    if (buffer) out.push(buffer);
    return out.join("\n");
  }

  // 映り込み除去: 句点で終わらない文が、後に出てくる長い文の先頭と一致する場合は削除
  function removePrefixDuplicates(sentences: string[]): string[] {
    const result: string[] = [];
    for (let i = 0; i < sentences.length; i++) {
      const s = sentences[i].trim();
      if (!s) continue;
      // 句点系で終わっていれば完結した文 → 削除しない
      if (RE_SENT_END.test(s)) { result.push(s); continue; }
      // 10文字未満は短すぎて判定不能 → 削除しない
      if (s.length < 10) { result.push(s); continue; }
      // 後ろのいずれかの文がこの文を先頭に含んでいれば映り込みと判定
      const isBleedThrough = sentences.slice(i + 1, i + 10).some(
        (later) => later.trimStart().startsWith(s)
      );
      if (!isBleedThrough) result.push(s);
    }
    return result;
  }

  function cleanOcrText(raw: string, isFirstPage = true): string {
    const lines = raw.split("\n").filter((line) => {
      const t = line.trim();
      if (!t) return false;
      if (RE_PAGE_NUM.test(t)) return false;
      if (RE_NOBRE_PRE.test(t)) return false;
      if (RE_NOBRE_SUF.test(t)) return false;
      if (!isFirstPage && RE_CHAPTER_HEAD.test(t)) return false;
      return true;
    });

    const out: string[] = [];
    let buffer = "";

    for (let i = 0; i < lines.length; i++) {
      const t = lines[i].trim();
      if (!t) continue;
      buffer = buffer ? buffer + t : t;
      const keep = RE_SENT_END.test(t) || RE_CHAPTER_HEAD.test(t) || RE_SEPARATOR.test(t);
      if (keep || i === lines.length - 1) {
        out.push(buffer);
        buffer = "";
      }
    }
    if (buffer) out.push(buffer);
    const cleaned = selectedBook?.settings.removeBleedThrough !== false
      ? removePrefixDuplicates(out)
      : out;
    return cleaned.join("\n").trim();
  }

  async function handleCancelUpload() {
    cancelUploadRef.current = true;
  }

  async function handleUploadPhotos(files: FileList) {
    if (!editChapterId || !selectedBookId) return;
    const arr = Array.from(files).sort((a, b) => a.lastModified - b.lastModified);
    setProcessingTotal(arr.length);
    setProcessingDone(0);
    cancelUploadRef.current = false;
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
      bleedThroughCleaned: false,
    }));

    await addPages(selectedBookId, editChapterId, newPages);
    await reload();

    const supabase = getSupabase();
    const removeBleedThrough = selectedBook?.settings.removeBleedThrough !== false;

    // フェーズ1: 全画像をStorageにアップロード
    const uploadedPages: { page: Page; isFirstPage: boolean }[] = [];
    for (let i = 0; i < arr.length; i++) {
      if (cancelUploadRef.current) {
        const remainingIds = newPages.slice(i).map((p) => p.id);
        await deletePages(remainingIds);
        await reload();
        break;
      }
      const page = newPages[i];
      try {
        const base64 = await compressImage(arr[i]);
        await uploadPageImage(selectedBookId, page.id, base64);
        const isFirstPage = (chapter?.pages.length ?? 0) === 0 && i === 0;
        uploadedPages.push({ page, isFirstPage });
      } catch {
        await updatePage({ ...page, status: "error" });
      }
      setProcessingDone(i + 1);
    }

    // フェーズ2: アップロード完了分を一括でprocessingにしてEdge Function起動
    await Promise.all(uploadedPages.map(({ page }) => updatePage({ ...page, status: "processing" })));
    for (const { page, isFirstPage } of uploadedPages) {
      supabase.functions.invoke("ocr-process", {
        body: { pageId: page.id, bookId: selectedBookId, isFirstPage, removeBleedThrough },
      }).catch(console.error);
    }

    setUploading(false);
    setProcessingTotal(0);
    setProcessingDone(0);
  }

  async function handleRetryPage(page: Page) {
    if (!selectedBookId || !editChapterId) return;
    const supabase = getSupabase();
    const chapter = selectedBook?.chapters.find((c) => c.id === editChapterId);
    const isFirstPage = chapter?.pages[0]?.id === page.id;
    const removeBleedThrough = selectedBook?.settings.removeBleedThrough !== false;
    await updatePage({ ...page, status: "processing", bleedThroughCleaned: false });
    await resetNeighborBleedFlags(page, chapter?.pages ?? []);
    const { error } = await supabase.functions.invoke("ocr-process", {
      body: { pageId: page.id, bookId: selectedBookId, isFirstPage, removeBleedThrough },
    });
    if (error) {
      await updatePage({ ...page, status: "error", bleedThroughCleaned: false });
      retryPageRef.current = page;
      retryFileInputRef.current?.click();
    }
  }

  async function handleRetryWithFile(page: Page, file: File) {
    if (!selectedBookId || !editChapterId) return;
    const supabase = getSupabase();
    const chapter = selectedBook?.chapters.find((c) => c.id === editChapterId);
    try {
      await updatePage({ ...page, status: "processing", bleedThroughCleaned: false });
      await resetNeighborBleedFlags(page, chapter?.pages ?? []);
      const base64 = await compressImage(file);
      await uploadPageImage(selectedBookId, page.id, base64);
      const isFirstPage = chapter?.pages[0]?.id === page.id;
      const removeBleedThrough = selectedBook?.settings.removeBleedThrough !== false;
      supabase.functions.invoke("ocr-process", {
        body: { pageId: page.id, bookId: selectedBookId, isFirstPage, removeBleedThrough },
      }).catch(console.error);
    } catch {
      await updatePage({ ...page, status: "error", bleedThroughCleaned: false });
    }
  }

  async function resetNeighborBleedFlags(page: Page, pages: Page[]) {
    const sorted = [...pages].sort((a, b) => a.pageNumber - b.pageNumber);
    const idx = sorted.findIndex((p) => p.id === page.id);
    const neighbors = [sorted[idx - 1], sorted[idx + 1]].filter(Boolean);
    await Promise.all(
      neighbors.map((n) => updatePage({ ...n, bleedThroughCleaned: false }))
    );
  }

  async function handleDeletePage(id: string) {
    if (selectedBookId) await deletePageImage(selectedBookId, id).catch(() => {});
    await deletePage(id);
    if (selectedPageId === id) setSelectedPageId(null);
    reload();
  }

  async function handleBulkDelete() {
    if (deletingPageIds.size === 0) return;
    const ids = Array.from(deletingPageIds);
    if (selectedBookId) {
      await Promise.all(ids.map((id) => deletePageImage(selectedBookId, id).catch(() => {})));
    }
    await deletePages(ids);
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
    const chapter = selectedBook?.chapters.find((c) => c.id === editChapterId);
    await updatePage({ ...selectedPage, text: editingText, bleedThroughCleaned: false });
    await resetNeighborBleedFlags(selectedPage, chapter?.pages ?? []);
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
    if (chapterSearchActive && chapterSearch.trim()) carryOverSearchRef.current = chapterSearch;
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
    // 並び替え後は全ページのフラグをリセット
    await Promise.all(sortingPages.map((p) => updatePage({ ...p, bleedThroughCleaned: false })));
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

  // ===== BLEED-THROUGH BETWEEN PAGES =====

  const [cleaningBleed, setCleaningBleed] = useState(false);
  const [cleaningBleedResult, setCleaningBleedResult] = useState<string | null>(null);

  // 章単位スナップショット履歴: chapterId → { snapshots: [{pageId, text, bleedThroughCleaned}][], index }
  type PageSnap = { pageId: string; text: string; bleedThroughCleaned: boolean };
  const chapterHistoryRef = useRef<Map<string, { snapshots: PageSnap[][]; index: number }>>(new Map());

  // undo/redoポップアップ（章全体対象）
  const [undoPopup, setUndoPopup] = useState(false);
  const undoPopupTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // 除去/復元結果モード
  type BleedDiff = { pageId: string; pageNumber: number; removedText: string; removedPre: string; lcsText: string; charDelta: number };
  type BleedResultState = { type: "clean" | "undo" | "redo"; diffs: BleedDiff[]; chapterId: string } | null;
  const [bleedResultState, setBleedResultState] = useState<BleedResultState>(null);

  function pushChapterHistory(chapterId: string, before: PageSnap[], after: PageSnap[]) {
    const map = chapterHistoryRef.current;
    const entry = map.get(chapterId) ?? { snapshots: [], index: -1 };
    const newSnapshots = [...entry.snapshots.slice(0, entry.index + 1), before, after].slice(-20);
    map.set(chapterId, { snapshots: newSnapshots, index: newSnapshots.length - 1 });
  }

  async function handleUndo() {
    if (!editChapterId) return;
    const entry = chapterHistoryRef.current.get(editChapterId);
    if (!entry || entry.index <= 0) return;
    const newIndex = entry.index - 1;
    const current = entry.snapshots[entry.index];
    const snapshot = entry.snapshots[newIndex];
    chapterHistoryRef.current.set(editChapterId, { ...entry, index: newIndex });
    const pages = editChapter?.pages ?? [];
    await Promise.all(snapshot.map(({ pageId, text, bleedThroughCleaned }) => {
      const page = pages.find((p) => p.id === pageId);
      return page ? updatePage({ ...page, text, bleedThroughCleaned }) : Promise.resolve();
    }));
    reload();
    setBleedResultState({
      type: "undo",
      chapterId: editChapterId,
      diffs: snapshot.map((b) => {
        const a = current.find((x) => x.pageId === b.pageId);
        return {
          pageId: b.pageId,
          pageNumber: pages.find((p) => p.id === b.pageId)?.pageNumber ?? 0,
          removedText: b.text,
          removedPre: "",
          lcsText: "",
          charDelta: b.text.length - (a?.text.length ?? 0),
        };
      }).filter((d) => d.charDelta !== 0),
    });
  }

  async function handleRedo() {
    if (!editChapterId) return;
    const entry = chapterHistoryRef.current.get(editChapterId);
    if (!entry || entry.index >= entry.snapshots.length - 1) return;
    const newIndex = entry.index + 1;
    const current = entry.snapshots[entry.index];
    const snapshot = entry.snapshots[newIndex];
    chapterHistoryRef.current.set(editChapterId, { ...entry, index: newIndex });
    const pages = editChapter?.pages ?? [];
    await Promise.all(snapshot.map(({ pageId, text, bleedThroughCleaned }) => {
      const page = pages.find((p) => p.id === pageId);
      return page ? updatePage({ ...page, text, bleedThroughCleaned }) : Promise.resolve();
    }));
    reload();
    setBleedResultState({
      type: "redo",
      chapterId: editChapterId,
      diffs: snapshot.map((b) => {
        const a = current.find((x) => x.pageId === b.pageId);
        return {
          pageId: b.pageId,
          pageNumber: pages.find((p) => p.id === b.pageId)?.pageNumber ?? 0,
          removedText: b.text,
          removedPre: "",
          lcsText: "",
          charDelta: b.text.length - (a?.text.length ?? 0),
        };
      }).filter((d) => d.charDelta !== 0),
    });
  }

  function handleUndoButtonClick() {
    const entry = chapterHistoryRef.current.get(editChapterId ?? "");
    if (!entry || entry.index <= 0) return;
    handleUndo();
  }

  function handleUndoButtonDoubleClick() {
    if (undoPopupTimerRef.current) clearTimeout(undoPopupTimerRef.current);
    const setting = selectedBook?.settings.doubleClickUndo ?? "popup";
    if (setting === "next") {
      handleRedo();
    } else {
      setUndoPopup(true);
      undoPopupTimerRef.current = setTimeout(() => setUndoPopup(false), 4000);
    }
  }

  function splitToSentences(text: string): string[] {
    const results: string[] = [];
    let current = "";
    for (const char of text) {
      current += char;
      if ("。！？".includes(char) || char === "\n") {
        if (current.trim()) results.push(current.trim());
        current = "";
      }
    }
    if (current.trim()) results.push(current.trim());
    return results.filter((s) => s.length > 0);
  }

  type NormalizedText = { chars: string[]; rawStart: number[]; rawEnd: number[] };
  type FuzzyOverlap = { prevRawStart: number; currRawStart: number; currRawEnd: number; prevOverlap: string; currOverlap: string; score: number };

  const OVERLAP_PREV_LOOKBACK = 1400;
  const OVERLAP_CURR_LOOKAHEAD = 1600;
  const OVERLAP_MIN_NORM_CHARS = 45;
  const OVERLAP_MAX_NORM_CHARS = 900;
  const OVERLAP_STEP_CHARS = 30;
  const OVERLAP_LENGTH_FUZZ = 160;
  const OVERLAP_MAX_CURR_START = 700;
  const OVERLAP_MAX_PREV_END_BACKTRACK = 500;
  const IGNORED_OVERLAP_CHARS = new Set([
    ..."\u3000\u3001\u3002\uff0c\uff0e\u30fb\uff65\u300c\u300d\u300e\u300f\uff08\uff09()\uff3b\uff3d[]\u3010\u3011\u3008\u3009\u300a\u300b\u2026\u2025\u2014\u2015-\u2010\u2011\u2013_:\uff1a;\uff1b,.'\"`\u2018\u2019\u201c\u201d!?\uff01\uff1f",
  ]);

  function isIgnoredOverlapChar(char: string): boolean {
    return /\s/.test(char) || IGNORED_OVERLAP_CHARS.has(char);
  }

  function normalizeForOverlap(text: string): NormalizedText {
    const chars: string[] = [];
    const rawStart: number[] = [];
    const rawEnd: number[] = [];
    let rawIndex = 0;
    for (const rawChar of text) {
      const start = rawIndex;
      rawIndex += rawChar.length;
      const normalized = rawChar.normalize("NFKC").toLowerCase();
      for (const char of normalized) {
        if (isIgnoredOverlapChar(char)) continue;
        chars.push(char);
        rawStart.push(start);
        rawEnd.push(rawIndex);
      }
    }
    return { chars, rawStart, rawEnd };
  }

  function bigramCounts(chars: string[]): Map<string, number> {
    const counts = new Map<string, number>();
    for (let i = 0; i < chars.length - 1; i++) {
      const key = chars[i] + chars[i + 1];
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    return counts;
  }

  function bigramDice(a: string[], b: string[]): number {
    if (a.length < 2 || b.length < 2) return 0;
    const ac = bigramCounts(a);
    const bc = bigramCounts(b);
    let shared = 0;
    for (const [key, count] of ac) shared += Math.min(count, bc.get(key) ?? 0);
    return (2 * shared) / (a.length - 1 + b.length - 1);
  }

  function commonSubsequenceLength(a: string[], b: string[]): number {
    let prev = new Array(b.length + 1).fill(0);
    let curr = new Array(b.length + 1).fill(0);
    for (let i = 1; i <= a.length; i++) {
      for (let j = 1; j <= b.length; j++) {
        curr[j] = a[i - 1] === b[j - 1] ? prev[j - 1] + 1 : Math.max(prev[j], curr[j - 1]);
      }
      [prev, curr] = [curr, prev];
      curr.fill(0);
    }
    return prev[b.length];
  }

  function candidateLengths(max: number): number[] {
    const values = new Set<number>();
    for (let n = OVERLAP_MIN_NORM_CHARS; n <= max; n += OVERLAP_STEP_CHARS) values.add(n);
    values.add(max);
    return [...values].filter((n) => n >= OVERLAP_MIN_NORM_CHARS).sort((a, b) => a - b);
  }

  function findFuzzyPageOverlap(prevWindow: string, currWindow: string): FuzzyOverlap | null {
    const prevNorm = normalizeForOverlap(prevWindow);
    const currNorm = normalizeForOverlap(currWindow);
    const maxCurrLen = Math.min(currNorm.chars.length, OVERLAP_MAX_NORM_CHARS);
    const maxPrevLen = Math.min(prevNorm.chars.length, OVERLAP_MAX_NORM_CHARS);
    if (maxCurrLen < OVERLAP_MIN_NORM_CHARS || maxPrevLen < OVERLAP_MIN_NORM_CHARS) return null;

    let best: (FuzzyOverlap & { normScore: number }) | null = null;
    const maxCurrStart = Math.min(OVERLAP_MAX_CURR_START, maxCurrLen - OVERLAP_MIN_NORM_CHARS);
    for (let currStartNorm = 0; currStartNorm <= maxCurrStart; currStartNorm += OVERLAP_STEP_CHARS) {
      const currAvailable = maxCurrLen - currStartNorm;
      for (const currLen of candidateLengths(currAvailable)) {
        const currEndNorm = currStartNorm + currLen;
        const currPart = currNorm.chars.slice(currStartNorm, currEndNorm);
        const prevMin = Math.max(OVERLAP_MIN_NORM_CHARS, currLen - OVERLAP_LENGTH_FUZZ);
        const prevMax = Math.min(maxPrevLen, currLen + OVERLAP_LENGTH_FUZZ);
        const minPrevEnd = Math.max(prevMin, maxPrevLen - OVERLAP_MAX_PREV_END_BACKTRACK);
        for (let prevEndNorm = maxPrevLen; prevEndNorm >= minPrevEnd; prevEndNorm -= OVERLAP_STEP_CHARS) {
          for (let prevLen = prevMin; prevLen <= Math.min(prevEndNorm, prevMax); prevLen += OVERLAP_STEP_CHARS) {
            const prevStartNorm = prevEndNorm - prevLen;
            const prevPart = prevNorm.chars.slice(prevStartNorm, prevEndNorm);
            const dice = bigramDice(prevPart, currPart);
            if (dice < 0.16) continue;
            const common = commonSubsequenceLength(prevPart, currPart);
            const shortCoverage = common / Math.min(prevPart.length, currPart.length);
            const longCoverage = common / Math.max(prevPart.length, currPart.length);
            if (common < OVERLAP_MIN_NORM_CHARS || shortCoverage < 0.48 || longCoverage < 0.32) continue;
            const lengthBonus = Math.min(Math.min(prevPart.length, currPart.length) / 360, 1) * 0.05;
            const startPenalty = (currStartNorm / Math.max(maxCurrLen, 1)) * 0.18;
            const endPenalty = ((maxPrevLen - prevEndNorm) / Math.max(maxPrevLen, 1)) * 0.06;
            const score = dice * 0.38 + shortCoverage * 0.40 + longCoverage * 0.22 + lengthBonus - startPenalty - endPenalty;
            if (score < 0.38) continue;
            const prevRawStart = prevNorm.rawStart[prevStartNorm] ?? 0;
            const currRawStart = currNorm.rawStart[currStartNorm] ?? 0;
            const currRawEnd = currNorm.rawEnd[currEndNorm - 1] ?? 0;
            const candidate = { prevRawStart, currRawStart, currRawEnd, prevOverlap: prevWindow.slice(prevRawStart), currOverlap: currWindow.slice(currRawStart, currRawEnd), score, normScore: score + Math.min(currLen, prevLen) / 10000 };
            if (!best || candidate.normScore > best.normScore) best = candidate;
          }
        }
      }
    }
    return best;
  }

  function joinAfterOverlap(prefix: string, suffix: string): string {
    if (!prefix.trim()) return suffix.trim();
    if (!suffix.trim()) return prefix.trim();
    if (/\s$/.test(prefix) || /^\s/.test(suffix)) return (prefix + suffix).trim();
    return `${prefix.trimEnd()}\n${suffix.trimStart()}`.trim();
  }

  function overlapSimilarity(a: string, b: string): number {
    const an = normalizeForOverlap(a).chars;
    const bn = normalizeForOverlap(b).chars;
    if (an.length < 8 || bn.length < 8) return 0;
    const common = commonSubsequenceLength(an, bn);
    const shortCoverage = common / Math.min(an.length, bn.length);
    const longCoverage = common / Math.max(an.length, bn.length);
    return bigramDice(an, bn) * 0.35 + shortCoverage * 0.45 + longCoverage * 0.20;
  }

  function segmentQuality(text: string): number {
    const normalizedLength = Math.min(normalizeForOverlap(text).chars.length, 220);
    const hasSentenceEnd = RE_SENT_END.test(text.trim()) ? 12 : 0;
    const replacementPenalty = (text.match(/[�□■◇◆]/g)?.length ?? 0) * 10;
    const straySymbolPenalty = (text.match(/[|\\~^]{2,}/g)?.length ?? 0) * 8;
    const naturalPatterns = [/できるような/g, /している/g, /されている/g, /られている/g, /ものである/g, /なのである/g, /については/g, /というのも/g, /すなわち/g, /であるから/g, /とするならば/g, /において/g, /に対して/g, /として/g, /一瞬で/g, /ではなく/g, /そうしたこと/g, /化学反応/g, /二次性質/g, /存在していた/g, /主張すること/g];
    const brokenPatterns = [/[一-龯々]{1,4}な(視点|感覚|性質|関係|外部|内部|対象|もの)/g, /[がのをにへとでやりるか]{5,}/g, /[一-龯々]{1,4}心ではない/g, /次性質/g, /測定存能/g, /[一-龯々ぁ-んァ-ン]ー[ぁ-ん]/g, /[ァ-ンー]{3,}$/g, /そうした[でにをが]/g, /とか、[^。！？]{0,4}こと/g, /[ぁ-んァ-ン一-龯々]{2,8}$/g, /ずから/g, /がられている/g, /がりゆる/g, /与えるみ$/g];
    const naturalBonus = naturalPatterns.reduce((sum, p) => sum + ((text.match(p)?.length ?? 0) * 12), 0);
    const brokenPenalty = brokenPatterns.reduce((sum, p) => sum + ((text.match(p)?.length ?? 0) * 18), 0);
    const danglingPenalty = RE_SENT_END.test(text.trim()) ? 0 : 10;
    return normalizedLength + hasSentenceEnd + naturalBonus - replacementPenalty - straySymbolPenalty - brokenPenalty - danglingPenalty;
  }

  function longestCommonSuffixPrefix(prefixText: string, fullText: string): { length: number; completeEnd: number } {
    let best = { length: 0, completeEnd: -1 };
    for (let end = 1; end <= fullText.length; end++) {
      const maxLen = Math.min(prefixText.length, end);
      for (let len = maxLen; len >= 1; len--) {
        if (prefixText.slice(prefixText.length - len) === fullText.slice(end - len, end)) {
          if (len > best.length) best = { length: len, completeEnd: end };
          break;
        }
      }
    }
    return best;
  }

  function completeDanglingSegment(a: string, b: string): string | null {
    const aTrim = a.trim();
    const bTrim = b.trim();
    if (!aTrim || !bTrim) return null;
    const aComplete = RE_SENT_END.test(aTrim);
    const bComplete = RE_SENT_END.test(bTrim);
    if (aComplete === bComplete) return null;
    const dangling = aComplete ? bTrim : aTrim;
    const complete = aComplete ? aTrim : bTrim;
    if (normalizeForOverlap(dangling).chars.length < 40) return null;
    if (overlapSimilarity(dangling, complete) < 0.72) return null;
    const dNorm = normalizeForOverlap(dangling);
    const cNorm = normalizeForOverlap(complete);
    const common = commonSubsequenceLength(dNorm.chars, cNorm.chars);
    if (common / Math.max(dNorm.chars.length, 1) < 0.88) return null;
    const danglingTail = dangling.slice(Math.max(0, dangling.length - 24));
    const completeTailWindow = complete.slice(Math.max(0, complete.length - 80));
    const anchor = longestCommonSuffixPrefix(danglingTail, completeTailWindow);
    if (anchor.length < 2) return null;
    const append = completeTailWindow.slice(anchor.completeEnd);
    if (append.length === 0 || append.length > 12) return null;
    if (!RE_SENT_END.test((dangling + append).trim())) return null;
    return (dangling + append).trim();
  }

  function chooseBetterOverlapSegment(prevSegment: string, currSegment: string): string {
    const completed = completeDanglingSegment(prevSegment, currSegment);
    if (completed) return completed;
    const prevScore = segmentQuality(prevSegment);
    const currScore = segmentQuality(currSegment);
    if (prevScore >= currScore * 0.92 && prevScore <= currScore * 1.08) {
      return prevSegment.length >= currSegment.length ? prevSegment : currSegment;
    }
    return prevScore > currScore ? prevSegment : currSegment;
  }

  function mergeOverlapText(prevOverlap: string, currOverlap: string): string {
    const prevSegments = splitToSentences(prevOverlap);
    const currSegments = splitToSentences(currOverlap);
    if (prevSegments.length === 0) return currOverlap.trim();
    if (currSegments.length === 0) return prevOverlap.trim();
    const merged: string[] = [];
    let prevIndex = 0;
    let matched = 0;
    for (const currSegment of currSegments) {
      let bestIndex = -1;
      let bestScore = 0;
      const searchEnd = Math.min(prevSegments.length, prevIndex + 7);
      for (let i = prevIndex; i < searchEnd; i++) {
        const score = overlapSimilarity(prevSegments[i], currSegment);
        if (score > bestScore) { bestScore = score; bestIndex = i; }
      }
      if (bestIndex >= 0 && bestScore >= 0.38) {
        for (let i = prevIndex; i < bestIndex; i++) {
          if (segmentQuality(prevSegments[i]) >= 30) merged.push(prevSegments[i]);
        }
        merged.push(chooseBetterOverlapSegment(prevSegments[bestIndex], currSegment));
        prevIndex = bestIndex + 1;
        matched++;
      } else if (segmentQuality(currSegment) >= 30) {
        merged.push(currSegment);
      }
    }
    if (matched === 0) {
      return segmentQuality(currOverlap) > segmentQuality(prevOverlap) ? currOverlap.trim() : prevOverlap.trim();
    }
    return merged.join("").trim();
  }

  function removeBleedThroughHead(currText: string, prevText: string): { text: string; removed: boolean; removedPre: string; lcsText: string; newPrevText: string | null } {
    const prevWindowStart = Math.max(0, prevText.length - OVERLAP_PREV_LOOKBACK);
    const prevWindow = prevText.slice(prevWindowStart);
    const currWindow = currText.slice(0, OVERLAP_CURR_LOOKAHEAD);
    const overlap = findFuzzyPageOverlap(prevWindow, currWindow);
    if (!overlap) return { text: currText, removed: false, removedPre: "", lcsText: "", newPrevText: null };
    const currPrefix = currText.slice(0, overlap.currRawStart);
    const currOverlap = currText.slice(overlap.currRawStart, overlap.currRawEnd);
    const mergedOverlap = mergeOverlapText(overlap.prevOverlap, currOverlap);
    const keptText = joinAfterOverlap(currPrefix, currText.slice(overlap.currRawEnd));
    let newPrevText: string | null = null;
    if (mergedOverlap && mergedOverlap !== overlap.prevOverlap.trim()) {
      newPrevText = (prevText.slice(0, prevWindowStart + overlap.prevRawStart) + mergedOverlap).trim();
    }
    return { text: keptText, removed: true, removedPre: "", lcsText: currOverlap, newPrevText };
  }

  async function handleCleanBleedThrough() {
    if (!editChapter || cleaningBleed) return;
    setCleaningBleed(true);
    setCleaningBleedResult(null);

    const pages = [...editChapter.pages].sort((a, b) => a.pageNumber - b.pageNumber);
    const allCleaned = pages.every((p) => p.bleedThroughCleaned);
    let totalRemoved = 0;
    const toUpdateMap = new Map<string, Page>();
    const beforeSnapMap = new Map<string, PageSnap>();
    const afterSnapMap = new Map<string, PageSnap>();
    const removedPres: Record<string, string> = {};
    const lcsTexts: Record<string, string> = {};

    for (let i = 0; i < pages.length; i++) {
      const prev = pages[i - 1];
      const curr = pages[i];

      if (!allCleaned && curr.bleedThroughCleaned) continue;

      let newCurrText = curr.text;
      let changed = false;

      if (prev) {
        const prevCurrent = toUpdateMap.get(prev.id) ?? prev;
        const result = removeBleedThroughHead(curr.text, prevCurrent.text);
        if (result.removed) {
          newCurrText = result.text;
          changed = true;
          removedPres[curr.id] = result.removedPre;
          lcsTexts[curr.id] = result.lcsText;
          if (result.newPrevText !== null) {
            if (!beforeSnapMap.has(prev.id)) {
              beforeSnapMap.set(prev.id, { pageId: prev.id, text: prevCurrent.text, bleedThroughCleaned: prevCurrent.bleedThroughCleaned });
            }
            const updatedPrev = { ...prevCurrent, text: result.newPrevText, bleedThroughCleaned: true };
            toUpdateMap.set(prev.id, updatedPrev);
            afterSnapMap.set(prev.id, { pageId: prev.id, text: result.newPrevText, bleedThroughCleaned: true });
          }
        }
      }

      if (changed) {
        totalRemoved++;
        if (!beforeSnapMap.has(curr.id)) {
          beforeSnapMap.set(curr.id, { pageId: curr.id, text: curr.text, bleedThroughCleaned: curr.bleedThroughCleaned });
        }
        toUpdateMap.set(curr.id, { ...curr, text: newCurrText, bleedThroughCleaned: true });
        afterSnapMap.set(curr.id, { pageId: curr.id, text: newCurrText, bleedThroughCleaned: true });
      } else if (!curr.bleedThroughCleaned) {
        toUpdateMap.set(curr.id, { ...curr, bleedThroughCleaned: true });
      }
    }

    const beforeSnap = [...beforeSnapMap.values()];
    const afterSnap = beforeSnap.map(b => afterSnapMap.get(b.pageId)!).filter(Boolean);
    const toUpdate = [...toUpdateMap.values()];

    if (beforeSnap.length > 0) pushChapterHistory(editChapter.id, beforeSnap, afterSnap);

    await Promise.all(toUpdate.map((p) => updatePage(p)));
    await reload();
    setCleaningBleed(false);
    setCleaningBleedResult(`除去完了（${totalRemoved}箇所）`);
    setTimeout(() => setCleaningBleedResult(null), 4000);

    if (beforeSnap.length > 0) {
      setBleedResultState({
        type: "clean",
        chapterId: editChapter.id,
        diffs: beforeSnap.map((b, i) => ({
          pageId: b.pageId,
          pageNumber: pages.find((p) => p.id === b.pageId)?.pageNumber ?? 0,
          removedText: b.text,
          removedPre: removedPres[b.pageId] ?? "",
          lcsText: lcsTexts[b.pageId] ?? "",
          charDelta: afterSnap[i].text.length - b.text.length,
        })),
      });
    }
  }

  // ===== SEARCH =====

  function resetBookSearch() {
    setBookSearch("");
    setBookSearchDeferred("");
    setBookSearchActive(false);
    setBookSearchMatchIdx(0);
  }

  function resetChapterSearch() {
    setChapterSearch("");
    setChapterSearchActive(false);
    setChapterSearchMatchIdx(0);
  }

  const bookSearchData = useMemo(() => {
    if (!bookSearchActive || !bookSearchDeferred.trim() || !selectedBook) return null;
    const q = bookSearchDeferred.toLowerCase();
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
  }, [bookSearchActive, bookSearchDeferred, selectedBook]);

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
      parts.push(
        <mark
          key={i}
          data-search-current={isCurrent ? "true" : undefined}
          className={isCurrent ? "bg-orange-400 text-white rounded px-px" : "bg-yellow-200 rounded px-px"}
        >{text.slice(i, i + query.length)}</mark>
      );
      last = i + q.length; matchNum++;
      i = text.toLowerCase().indexOf(q, last);
    }
    if (last < text.length) parts.push(text.slice(last));
    return <>{parts}</>;
  }

  navigateChapterSearchRef.current = navigateChapterSearch;
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
    setTimeout(() => {
      document.querySelector("[data-search-current='true']")?.scrollIntoView({ behavior: "smooth", block: "center" });
      chapterSearchInputRef.current?.focus();
    }, 120);
  }

  navigateBookSearchNextRef.current = () => navigateBookSearch("next");
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
                <button onClick={resetBookSearch} className="text-gray-400 hover:text-gray-600 text-sm leading-none">✕</button>
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
        ) : bleedResultState && bleedResultState.chapterId === editChapterId ? (
          /* ===== BLEED RESULT MODE ===== */
          <>
            <div className="p-3 border-b border-gray-200">
              <div className="flex items-center justify-between mb-1.5">
                <p className="text-xs font-semibold uppercase tracking-wide text-blue-600">
                  {bleedResultState.type === "undo" ? "↩ 復元結果" : bleedResultState.type === "redo" ? "↪ 再除去結果" : "✦ 除去結果"}
                </p>
                <button onClick={() => setBleedResultState(null)} className="text-gray-400 hover:text-gray-600 text-sm leading-none">✕</button>
              </div>
              <p className="text-xs text-gray-500">
                {editChapter?.name} の {bleedResultState.diffs.length}ページを
                {bleedResultState.type === "undo" ? "復元" : "修正"}しました
              </p>
            </div>
            <div className="flex-1 overflow-y-auto p-1.5">
              {bleedResultState.diffs.length === 0 ? (
                <p className="text-xs text-gray-400 text-center mt-8">変更されたページはありません</p>
              ) : (
                bleedResultState.diffs.map((diff) => (
                  <div
                    key={diff.pageId}
                    onClick={() => { setSelectedPageId(diff.pageId); setMobilePanel("text"); setShowSidebar(false); }}
                    className={`px-2 py-2 rounded-xl cursor-pointer mb-0.5 ${diff.pageId === selectedPageId ? "bg-blue-50 border-l-2 border-blue-500" : "hover:bg-gray-50"}`}
                  >
                    <p className="text-xs font-semibold text-blue-600 mb-1">ページ {diff.pageNumber}</p>
                    <p className="text-[11px] leading-relaxed line-clamp-2" style={{ color: '#2563eb', textDecoration: 'line-through' }}>
                      {diff.removedText.slice(0, 60)}…
                    </p>
                    <p className="text-[10px] mt-1" style={{ color: '#2563eb' }}>
                      {diff.charDelta > 0 ? `+${diff.charDelta}文字 復元` : `${diff.charDelta}文字 除去`}
                    </p>
                  </div>
                ))
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
                      ref={bookSearchInputRef}
                      value={bookSearch}
                      onChange={(e) => setBookSearch(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Escape") resetBookSearch();
                        if (e.key === "Enter") {
                          e.preventDefault();
                          if (!bookSearch.trim()) return;
                          if (bookSearchActive) navigateBookSearch("next"); else setBookSearchActive(true);
                        }
                      }}
                      placeholder="全文検索..."
                      className="text-xs border border-gray-200 rounded-lg px-2 py-1.5 w-24 outline-none focus:border-blue-300"
                    />
                    <button type="submit" className="bg-gray-800 text-white text-xs rounded-lg px-2 py-1.5 shrink-0 active:scale-95">🔍</button>
                    {bookSearchActive && (
                      <button type="button" onClick={resetBookSearch} className="text-gray-400 hover:text-gray-600 text-sm leading-none px-0.5">✕</button>
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
                    <button
                      onClick={handleCancelUpload}
                      className="text-xs text-red-400 border border-red-200 bg-white rounded-lg px-2 py-0.5 active:scale-95 transition-transform"
                    >中断</button>
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
                    <button onClick={resetChapterSearch} className="bg-gray-100 text-gray-600 text-xs font-semibold rounded-xl px-3 py-1.5 active:scale-95 transition-transform">✕</button>
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
                    <button
                      onClick={() => setSelectMode(true)}
                      disabled={uploading || (editChapter?.pages.length ?? 0) === 0}
                      className="bg-gray-100 text-gray-600 text-xs font-semibold rounded-xl px-3 active:scale-95 transition-transform disabled:opacity-30"
                    >選択</button>
                  </div>
                  {cleaningBleedResult && (
                    <div className="text-xs text-green-600 bg-green-50 border border-green-200 rounded-xl px-3 py-1.5 mb-2 text-center">
                      ✓ {cleaningBleedResult}
                    </div>
                  )}
                  {cleaningBleed && (
                    <div className="text-xs text-orange-600 bg-orange-50 border border-orange-200 rounded-xl px-3 py-1.5 mb-2 text-center">
                      ✦ 映り込み除去中...
                    </div>
                  )}
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
              <input
                ref={retryFileInputRef}
                type="file"
                accept="image/*"
                className="hidden"
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  if (file && retryPageRef.current) handleRetryWithFile(retryPageRef.current, file);
                  e.target.value = "";
                }}
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
                      if (chapterSearchActive) {
                        setTimeout(() => { chapterSearchInputRef.current?.focus(); }, 50);
                      }
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
                    if (ch) {
                      if (chapterSearchActive && chapterSearch.trim()) carryOverSearchRef.current = chapterSearch;
                      setEditChapterId(ch.id); setSelectedPageId(ch.pages[0]?.id ?? null); setEditingPageId(null);
                    }
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
                    ref={chapterSearchInputRef}
                    value={chapterSearch}
                    onChange={(e) => setChapterSearch(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Escape") resetChapterSearch();
                      if (e.key === "Enter") {
                        e.preventDefault();
                        if (!chapterSearch.trim() || !editChapter) return;
                        if (chapterSearchActive) {
                          navigateChapterSearch("next");
                        } else {
                          const q = chapterSearch.toLowerCase();
                          const firstPage = editChapter.pages.find((p) => p.status === "done" && p.text.toLowerCase().includes(q));
                          if (firstPage && firstPage.id !== selectedPageId) {
                            setSelectedPageId(firstPage.id);
                            setMobilePanel("text");
                          }
                          setChapterSearchActive(true);
                          setChapterSearchMatchIdx(0);
                          setTimeout(() => { chapterSearchInputRef.current?.focus(); }, 150);
                        }
                      }
                    }}
                    placeholder="章内検索..."
                    className="text-xs border border-gray-200 rounded-lg px-2 py-1 w-12 md:w-20 outline-none focus:border-blue-300"
                  />
                  <button type="submit" className="bg-gray-800 text-white text-xs rounded-lg px-1.5 py-1 shrink-0 active:scale-95">🔍</button>
                  {chapterSearchActive && (
                    <button type="button" onClick={resetChapterSearch} className="text-gray-400 hover:text-gray-600 text-sm leading-none px-0.5">✕</button>
                  )}
                </form>
                {/* Split ✦|↩ button */}
                {selectedPage?.status === "done" && (
                  <div className="relative ml-1 shrink-0">
                    <div className="flex rounded-xl overflow-hidden border border-gray-200">
                      <button
                        onClick={() => handleCleanBleedThrough()}
                        disabled={cleaningBleed || (editChapter?.pages.length ?? 0) === 0}
                        className="bg-orange-50 border-r border-orange-200 text-orange-500 text-xs font-bold px-2.5 py-1 active:scale-95 transition-transform disabled:opacity-40"
                        title="章全体の映り込みを除去"
                      >✦</button>
                      <button
                        onClick={() => handleUndoButtonClick()}
                        onDoubleClick={() => handleUndoButtonDoubleClick()}
                        className="bg-blue-600 text-white text-xs font-bold px-2.5 py-1 active:scale-95 transition-transform"
                        title="除去を元に戻す（ダブルクリック: 進む）"
                      >↩</button>
                    </div>
                    {undoPopup && (
                      <div className="absolute top-full left-0 mt-1 z-50 bg-white border border-gray-200 rounded-xl shadow-lg overflow-hidden whitespace-nowrap">
                        <button
                          onClick={() => { handleUndo(); setUndoPopup(false); }}
                          className="block w-full text-left px-4 py-2 text-xs text-gray-700 hover:bg-gray-50 active:bg-gray-100"
                        >↩ 前に戻る（章全体）</button>
                        <button
                          onClick={() => { handleRedo(); setUndoPopup(false); }}
                          className="block w-full text-left px-4 py-2 text-xs text-gray-700 hover:bg-gray-50 active:bg-gray-100 border-t border-gray-100"
                        >↪ 次に進む（章全体）</button>
                      </div>
                    )}
                  </div>
                )}
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
                      {selectedPage.status === "done" ? (() => {
                        const bleedDiff = bleedResultState?.type === "clean" && bleedResultState.chapterId === editChapterId
                          ? bleedResultState.diffs.find((d) => d.pageId === selectedPage.id)
                          : null;
                        const mainText = chapterSearchActive && chapterSearch.trim()
                          ? renderHighlighted(selectedPage.text, chapterSearch, chapterSearchMatchIdx, chapterSearchData?.pageMatches.find((m) => m.pageId === selectedPage.id)?.startIdx ?? 0)
                          : selectedPage.text;
                        if (!bleedDiff || (!bleedDiff.removedPre && !bleedDiff.lcsText)) {
                          return <p className="text-sm text-gray-800 leading-relaxed whitespace-pre-wrap break-all">{mainText}</p>;
                        }
                        return (
                          <p className="text-sm text-gray-800 leading-relaxed whitespace-pre-wrap break-all">
                            {bleedDiff.removedPre && <span style={{ color: '#2563eb' }}>{bleedDiff.removedPre}</span>}
                            {bleedDiff.lcsText && <span style={{ color: '#2563eb' }}>{bleedDiff.lcsText}</span>}
                            {mainText}
                          </p>
                        );
                      })() : (
                        <p className="text-sm text-gray-800 leading-relaxed whitespace-pre-wrap break-all">
                          {selectedPage.status === "processing" ? "⟳ OCR処理中..."
                          : selectedPage.status === "error" ? "✕ エラーが発生しました"
                          : "⏳ 待機中"}
                        </p>
                      )}
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
              <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-2">OCR後処理</p>
              <label className="flex items-center justify-between px-2 py-2 rounded-xl cursor-pointer hover:bg-gray-50">
                <div>
                  <p className="text-sm text-gray-700">映り込み除去（OCR時）</p>
                  <p className="text-xs text-gray-400">同ページ内の重複テキストを自動削除</p>
                </div>
                <input
                  type="checkbox"
                  checked={selectedBook.settings.removeBleedThrough !== false}
                  onChange={(e) => handleUpdateSettings({ ...selectedBook.settings, removeBleedThrough: e.target.checked })}
                  className="accent-blue-600 w-4 h-4"
                />
              </label>
              <label className="flex items-center justify-between px-2 py-2 rounded-xl cursor-pointer hover:bg-gray-50">
                <div>
                  <p className="text-sm text-gray-700">ページ間映り込み除去（OCR時）</p>
                  <p className="text-xs text-gray-400">前後ページとの重複も自動削除（デフォルトOFF）</p>
                </div>
                <input
                  type="checkbox"
                  checked={selectedBook.settings.removeBleedThroughBetweenPages === true}
                  onChange={(e) => handleUpdateSettings({ ...selectedBook.settings, removeBleedThroughBetweenPages: e.target.checked })}
                  className="accent-blue-600 w-4 h-4"
                />
              </label>
            </div>

            <div>
              <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-2">↩ ダブルクリック動作</p>
              {(["popup", "next"] as const).map((mode) => (
                <label key={mode} className="flex items-center gap-2.5 px-2 py-2 rounded-xl cursor-pointer hover:bg-gray-50">
                  <input
                    type="radio"
                    name="doubleClickUndo"
                    checked={(selectedBook.settings.doubleClickUndo ?? "popup") === mode}
                    onChange={() => handleUpdateSettings({ ...selectedBook.settings, doubleClickUndo: mode })}
                    className="accent-blue-600"
                  />
                  <span className="text-sm text-gray-700">
                    {mode === "popup" ? "前に戻る / 次に進む を確認（デフォルト）" : "すぐ次に進む"}
                  </span>
                </label>
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
