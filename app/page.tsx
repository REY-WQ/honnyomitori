"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { v4 as uuidv4 } from "uuid";
import { Book } from "@/lib/types";
import { getBooks, addBook, deleteBook } from "@/lib/storage";

export default function Home() {
  const router = useRouter();
  const [books, setBooks] = useState<Book[]>([]);
  const [title, setTitle] = useState("");
  const [showInput, setShowInput] = useState(false);

  useEffect(() => {
    setBooks(getBooks());
  }, []);

  function createBook() {
    if (!title.trim()) return;
    const book: Book = {
      id: uuidv4(),
      title: title.trim(),
      createdAt: new Date().toISOString(),
      pages: [],
    };
    addBook(book);
    setBooks(getBooks());
    setTitle("");
    setShowInput(false);
  }

  function removeBook(id: string) {
    deleteBook(id);
    setBooks(getBooks());
  }

  return (
    <main className="min-h-screen bg-gray-50 p-4 max-w-lg mx-auto">
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-2xl font-bold text-gray-800">📚 本棚</h1>
        <button
          onClick={() => setShowInput(true)}
          className="bg-blue-600 text-white px-4 py-2 rounded-xl text-sm font-medium shadow"
        >
          + 新しい本
        </button>
      </div>

      {showInput && (
        <div className="bg-white rounded-2xl shadow p-4 mb-4">
          <p className="text-sm text-gray-500 mb-2">本のタイトルを入力</p>
          <input
            autoFocus
            type="text"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && createBook()}
            placeholder="例：吾輩は猫である"
            className="w-full border border-gray-200 rounded-xl px-3 py-2 text-sm mb-3 outline-none focus:border-blue-400"
          />
          <div className="flex gap-2">
            <button
              onClick={createBook}
              className="flex-1 bg-blue-600 text-white py-2 rounded-xl text-sm font-medium"
            >
              作成
            </button>
            <button
              onClick={() => { setShowInput(false); setTitle(""); }}
              className="flex-1 bg-gray-100 text-gray-600 py-2 rounded-xl text-sm"
            >
              キャンセル
            </button>
          </div>
        </div>
      )}

      {books.length === 0 ? (
        <div className="text-center text-gray-400 mt-20">
          <p className="text-4xl mb-3">📖</p>
          <p className="text-sm">まだ本がありません</p>
          <p className="text-sm">「新しい本」から追加してください</p>
        </div>
      ) : (
        <div className="flex flex-col gap-3">
          {books.map((book) => (
            <div
              key={book.id}
              className="bg-white rounded-2xl shadow p-4 flex items-center justify-between"
            >
              <button
                onClick={() => router.push(`/book/${book.id}`)}
                className="flex-1 text-left"
              >
                <p className="font-semibold text-gray-800">{book.title}</p>
                <p className="text-xs text-gray-400 mt-0.5">
                  {book.pages.filter((p) => p.status === "done").length} ページ完了
                  　{new Date(book.createdAt).toLocaleDateString("ja-JP")}
                </p>
              </button>
              <button
                onClick={() => removeBook(book.id)}
                className="text-gray-300 hover:text-red-400 ml-3 text-lg"
              >
                🗑️
              </button>
            </div>
          ))}
        </div>
      )}
    </main>
  );
}
