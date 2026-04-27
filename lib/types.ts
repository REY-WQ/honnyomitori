export interface Page {
  id: string;
  chapterId: string | null;
  pageNumber: number;
  text: string;
  processedAt: string;
  status: "pending" | "processing" | "done" | "error";
}

export interface Chapter {
  id: string;
  bookId: string;
  name: string;
  orderIndex: number;
  pages: Page[];
}

export interface BookSettings {
  chapterNavMode: "buttons" | "dropdown";
  removeBleedThrough: boolean;
}

export const DEFAULT_BOOK_SETTINGS: BookSettings = {
  chapterNavMode: "buttons",
  removeBleedThrough: true,
};

export interface Book {
  id: string;
  title: string;
  createdAt: string;
  chapters: Chapter[];
  settings: BookSettings;
}
