import { getSupabase } from "./supabase";
import { Book, Page } from "./types";

export async function getBooks(): Promise<Book[]> {
  const supabase = getSupabase();
  const { data: books } = await supabase.from("books").select("*").order("created_at", { ascending: false });
  if (!books) return [];

  const { data: pages } = await supabase.from("pages").select("*").order("page_number");
  const pagesByBook: Record<string, Page[]> = {};
  for (const p of pages || []) {
    if (!pagesByBook[p.book_id]) pagesByBook[p.book_id] = [];
    pagesByBook[p.book_id].push({
      id: p.id,
      pageNumber: p.page_number,
      text: p.text || "",
      processedAt: p.processed_at || "",
      status: p.status,
    });
  }

  return books.map((b) => ({
    id: b.id,
    title: b.title,
    createdAt: b.created_at,
    pages: pagesByBook[b.id] || [],
  }));
}

export async function getBook(id: string): Promise<Book | null> {
  const supabase = getSupabase();
  const { data: b } = await supabase.from("books").select("*").eq("id", id).single();
  if (!b) return null;

  const { data: pages } = await supabase.from("pages").select("*").eq("book_id", id).order("page_number");
  return {
    id: b.id,
    title: b.title,
    createdAt: b.created_at,
    pages: (pages || []).map((p) => ({
      id: p.id,
      pageNumber: p.page_number,
      text: p.text || "",
      processedAt: p.processed_at || "",
      status: p.status,
    })),
  };
}

export async function addBook(book: Book): Promise<void> {
  const supabase = getSupabase();
  await supabase.from("books").insert({ id: book.id, title: book.title, created_at: book.createdAt });
}

export async function deleteBook(id: string): Promise<void> {
  const supabase = getSupabase();
  await supabase.from("books").delete().eq("id", id);
}

export async function addPage(bookId: string, page: Page): Promise<void> {
  await addPages(bookId, [page]);
}

export async function addPages(bookId: string, pages: Page[]): Promise<void> {
  const supabase = getSupabase();
  await supabase.from("pages").insert(
    pages.map((p) => ({
      id: p.id,
      book_id: bookId,
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
