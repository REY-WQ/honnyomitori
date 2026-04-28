import { getSupabase } from "./supabase";
import { Book, Chapter, Page, BookSettings, DEFAULT_BOOK_SETTINGS } from "./types";

// ===== BOOKS =====

export async function getBooks(): Promise<Book[]> {
  const supabase = getSupabase();
  const { data: books } = await supabase
    .from("books")
    .select("*")
    .order("created_at", { ascending: false });
  if (!books) return [];

  const { data: chapters } = await supabase
    .from("chapters")
    .select("*")
    .order("order_index");

  const { data: pages } = await supabase
    .from("pages")
    .select("*")
    .order("page_number");

  return books.map((b) => buildBook(b, chapters || [], pages || []));
}

export async function getBook(id: string): Promise<Book | null> {
  const supabase = getSupabase();
  const { data: b } = await supabase.from("books").select("*").eq("id", id).single();
  if (!b) return null;

  const { data: chapters } = await supabase
    .from("chapters")
    .select("*")
    .eq("book_id", id)
    .order("order_index");

  const { data: pages } = await supabase
    .from("pages")
    .select("*")
    .eq("book_id", id)
    .order("page_number");

  return buildBook(b, chapters || [], pages || []);
}

function buildBook(b: Record<string, unknown>, allChapters: Record<string, unknown>[], allPages: Record<string, unknown>[]): Book {
  const bookChapters = allChapters.filter((c) => c.book_id === b.id);
  const bookPages = allPages.filter((p) => p.book_id === b.id);

  const chapters: Chapter[] = bookChapters.map((c) => ({
    id: c.id as string,
    bookId: c.book_id as string,
    name: c.name as string,
    orderIndex: c.order_index as number,
    pages: bookPages
      .filter((p) => p.chapter_id === c.id)
      .map(mapPage),
  }));

  return {
    id: b.id as string,
    title: b.title as string,
    createdAt: b.created_at as string,
    chapters,
    settings: { ...DEFAULT_BOOK_SETTINGS, ...((b.settings as BookSettings) || {}) },
  };
}

function mapPage(p: Record<string, unknown>): Page {
  return {
    id: p.id as string,
    chapterId: p.chapter_id as string | null,
    pageNumber: p.page_number as number,
    text: (p.text as string) || "",
    processedAt: (p.processed_at as string) || "",
    status: p.status as Page["status"],
  };
}

export async function addBook(book: Omit<Book, "chapters">): Promise<void> {
  const supabase = getSupabase();
  await supabase.from("books").insert({
    id: book.id,
    title: book.title,
    settings: book.settings,
    created_at: book.createdAt,
  });
}

export async function deleteBook(id: string): Promise<void> {
  const supabase = getSupabase();
  await supabase.from("books").delete().eq("id", id);
}

export async function renameBook(id: string, title: string): Promise<void> {
  const supabase = getSupabase();
  await supabase.from("books").update({ title }).eq("id", id);
}

export async function updateBookSettings(id: string, settings: BookSettings): Promise<void> {
  const supabase = getSupabase();
  await supabase.from("books").update({ settings }).eq("id", id);
}

// ===== CHAPTERS =====

export async function addChapter(chapter: Omit<Chapter, "pages">): Promise<void> {
  const supabase = getSupabase();
  await supabase.from("chapters").insert({
    id: chapter.id,
    book_id: chapter.bookId,
    name: chapter.name,
    order_index: chapter.orderIndex,
  });
}

export async function renameChapter(id: string, name: string): Promise<void> {
  const supabase = getSupabase();
  await supabase.from("chapters").update({ name }).eq("id", id);
}

export async function deleteChapter(id: string): Promise<void> {
  const supabase = getSupabase();
  await supabase.from("chapters").delete().eq("id", id);
}

// ===== PAGES =====

export async function addPages(bookId: string, chapterId: string, pages: Page[]): Promise<void> {
  const supabase = getSupabase();
  await supabase.from("pages").insert(
    pages.map((p) => ({
      id: p.id,
      book_id: bookId,
      chapter_id: chapterId,
      page_number: p.pageNumber,
      text: p.text,
      processed_at: p.processedAt || null,
      status: p.status,
    }))
  );
}

export async function updatePage(page: Page): Promise<void> {
  const supabase = getSupabase();
  await supabase.from("pages").update({
    text: page.text,
    processed_at: page.processedAt || null,
    status: page.status,
  }).eq("id", page.id);
}

export async function deletePage(id: string): Promise<void> {
  const supabase = getSupabase();
  await supabase.from("pages").delete().eq("id", id);
}

export async function deletePages(ids: string[]): Promise<void> {
  const supabase = getSupabase();
  await supabase.from("pages").delete().in("id", ids);
}

export async function reorderChapters(updates: { id: string; orderIndex: number }[]): Promise<void> {
  const supabase = getSupabase();
  await Promise.all(
    updates.map(({ id, orderIndex }) =>
      supabase.from("chapters").update({ order_index: orderIndex }).eq("id", id)
    )
  );
}

export async function reorderPages(updates: { id: string; pageNumber: number }[]): Promise<void> {
  const supabase = getSupabase();
  await Promise.all(
    updates.map(({ id, pageNumber }) =>
      supabase.from("pages").update({ page_number: pageNumber }).eq("id", id)
    )
  );
}

// ===== PAGE IMAGES (Supabase Storage) =====

export async function uploadPageImage(bookId: string, pageId: string, base64: string): Promise<void> {
  const supabase = getSupabase();
  const raw = base64.includes(",") ? base64.split(",")[1] : base64;
  const byteString = atob(raw);
  const bytes = new Uint8Array(byteString.length);
  for (let i = 0; i < byteString.length; i++) bytes[i] = byteString.charCodeAt(i);
  const blob = new Blob([bytes], { type: "image/jpeg" });
  await supabase.storage.from("ocr-images").upload(`${bookId}/${pageId}`, blob, { upsert: true });
}

export async function deletePageImage(bookId: string, pageId: string): Promise<void> {
  const supabase = getSupabase();
  await supabase.storage.from("ocr-images").remove([`${bookId}/${pageId}`]);
}

export async function pageImageExists(bookId: string, pageId: string): Promise<boolean> {
  const supabase = getSupabase();
  const { data } = await supabase.storage.from("ocr-images").list(bookId, { search: pageId });
  return (data?.length ?? 0) > 0;
}

// Smart chapter name: find max number in existing chapter names and return next
export function nextChapterName(chapters: Chapter[]): string {
  const numbers = chapters
    .map((c) => {
      const m = c.name.match(/(\d+)/);
      return m ? parseInt(m[1]) : null;
    })
    .filter((n): n is number => n !== null);

  if (numbers.length === 0) return "第1章";
  return `第${Math.max(...numbers) + 1}章`;
}
