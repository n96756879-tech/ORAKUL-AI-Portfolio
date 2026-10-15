import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "ORAKUL AI — Анализ футбольных матчей",
  description: "AI-аналитик футбольных матчей на основе актуальных данных",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="ru">
      <body className="antialiased selection:bg-cyan-500/20 selection:text-cyan-300">
        {children}
      </body>
    </html>
  );
}
