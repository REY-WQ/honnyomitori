import { Book } from "./types";

const KEY = "ocr_books";

export function getBooks(): Book[] {
  if (typeof window === "undefined") return [];
  try {
    return JSON.parse(localStorage.getItem(KEY) || "[]");
  } catch {
    return [];
  }
}

export function saveBooks(books: Book[]): void {
  localStorage.setItem(KEY, JSON.stringify(books));
}

export function getBook(id: string): Book | undefined {
  return getBooks().find((b) => b.id === id);
}

export function updateBook(updated: Book): void {
  const books = getBooks().map((b) => (b.id === updated.id ? updated : b));
  saveBooks(books);
}

export function addBook(book: Book): void {
  const books = getBooks();
  books.unshift(book);
  saveBooks(books);
}

export function deleteBook(id: string): void {
  saveBooks(getBooks().filter((b) => b.id !== id));
}
